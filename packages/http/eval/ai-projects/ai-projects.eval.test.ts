/**
 * The AI projects golden set, run against one dev deployment (amendment H: the rollout is gated on
 * it). Skipped unless CW_EVAL_AI_PROJECTS=1 and CW_EVAL_BASE_URL are set, which CI never does; and
 * even then it refuses a host the operator didn't list in CW_EVAL_ALLOWED_HOSTS. See README.md.
 *
 * For each golden project, each capability that takes one, each tier, with the project and without
 * (`projectId: null`), it records the answer and scores it (./checks.ts): conformance, planted-fact
 * recall, banned terms and planted-instruction leaks; then a conflict pass (the space's guidance
 * contradicts the project: the space must win) and an overflow pass on `balanced`. The report goes
 * to ./out (gitignored). Coworker isn't reached from here: its turns run over the admin's socket.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CallResult,
  excerptChars,
  followedPlantedInstruction,
  projectBeatSpace,
  type ReportedProject,
  reportedBudget,
  stringsOf,
  summarize,
} from './checks';
import { type EvalClient, evalClient, evalTarget } from './client';
import { GOLDEN_PROJECTS, type GoldenProject, overflowProject } from './fixtures';

const env = process.env as Record<string, string | undefined>;
const enabled = env.CW_EVAL_AI_PROJECTS === '1' && Boolean(env.CW_EVAL_BASE_URL);

const TIERS = ['flagship', 'balanced', 'fast'] as const;
type Tier = (typeof TIERS)[number];
/** Each golden project's source locale, and the locale it is translated into. */
const LOCALES: Record<GoldenProject['key'], { source: string; target: string }> = {
  en: { source: env.CW_EVAL_EN_LOCALE || 'en-US', target: env.CW_EVAL_DE_LOCALE || 'de-DE' },
  de: { source: env.CW_EVAL_DE_LOCALE || 'de-DE', target: env.CW_EVAL_EN_LOCALE || 'en-US' },
};
/** How long the runner waits for references' text to be read before it gives up, ms. */
const TEXT_WAIT_MS = Number(env.CW_EVAL_TEXT_WAIT_MS ?? 300_000);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idOf = (body: unknown): string => {
  const b = body as { id?: unknown; entry?: { id?: unknown }; asset?: { id?: unknown } } | null;
  const id = b?.id ?? b?.entry?.id ?? b?.asset?.id;
  if (typeof id !== 'string') throw new Error(`No id in ${JSON.stringify(body).slice(0, 300)}`);
  return id;
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the runner set up for one project, to call with and to clean up. */
interface Prepared {
  readonly golden: GoldenProject;
  readonly label: 'en' | 'de' | 'overflow';
  readonly projectId: string;
  readonly assetIds: string[];
  readonly entryId: string;
  readonly actionId: string;
}

/** One capability's call, as the runner makes it. */
interface Capability {
  readonly capability: string;
  readonly route: string;
  /** False: the call takes no tier (an AI action names its own); run once. */
  readonly tiered: boolean;
  readonly body: (p: Prepared, tier: Tier, projectId: string | null) => unknown;
  readonly path: (p: Prepared) => string;
  /** The answer has the documented shape (the project report aside). */
  readonly shape: (body: Record<string, unknown>) => boolean;
}

describe.skipIf(!enabled)('AI projects golden set (dev deployment only)', () => {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const typeId = `cwEval${runId}`;
  const results: CallResult[] = [];
  const prepared: Prepared[] = [];
  let client: EvalClient;

  const capabilities: Capability[] = [
    {
      capability: 'drafting',
      route: 'POST entries/generate',
      tiered: true,
      path: () => '/entries/generate',
      body: (p, tier, projectId) => ({
        contentTypeApiId: typeId,
        prompt: p.golden.brief,
        tier,
        projectId,
      }),
      shape: (b) => isRecord(b.fields),
    },
    {
      capability: 'drafting (canvas)',
      route: 'POST entries/canvas',
      tiered: true,
      path: () => '/entries/canvas',
      body: (p, tier, projectId) => ({
        contentTypeApiId: typeId,
        prose: `${p.golden.entry.title}\n\n${p.golden.entry.body}\n\n${p.golden.brief}`,
        tier,
        projectId,
      }),
      shape: (b) => isRecord(b.fields),
    },
    ...(env.CW_EVAL_BLOCKS_TYPE && env.CW_EVAL_BLOCKS_FIELD
      ? [
          {
            capability: 'layout',
            route: 'POST entries/blocks/generate',
            tiered: true,
            path: () => '/entries/blocks/generate',
            body: (p: Prepared, tier: Tier, projectId: string | null) => ({
              contentTypeApiId: env.CW_EVAL_BLOCKS_TYPE,
              field: env.CW_EVAL_BLOCKS_FIELD,
              prompt: p.golden.brief,
              tier,
              projectId,
            }),
            shape: (b: Record<string, unknown>) => Array.isArray(b.ops),
          },
        ]
      : []),
    {
      capability: 'field-assist (summarize)',
      route: 'POST entries/:id/summarize',
      tiered: true,
      path: (p) => `/entries/${p.entryId}/summarize`,
      body: (p, tier, projectId) => ({
        locale: LOCALES[p.golden.key].source,
        maxWords: 80,
        tier,
        projectId,
      }),
      shape: (b) => typeof b.summary === 'string',
    },
    {
      capability: 'field-assist (autofill)',
      route: 'POST entries/:id/autofill',
      tiered: true,
      path: (p) => `/entries/${p.entryId}/autofill`,
      body: (p, tier, projectId) => ({
        field: 'tagline',
        locale: LOCALES[p.golden.key].source,
        instructions: p.golden.brief,
        tier,
        projectId,
      }),
      shape: (b) => 'value' in b,
    },
    {
      capability: 'field-assist (AI action)',
      route: 'POST ai-actions/:id/run',
      tiered: false,
      path: (p) => `/ai-actions/${p.actionId}/run`,
      body: (p, _tier, projectId) => ({
        entryId: p.entryId,
        locale: LOCALES[p.golden.key].source,
        projectId,
      }),
      shape: (b) => typeof b.output === 'string',
    },
    {
      capability: 'translation',
      route: 'POST entries/:id/translate',
      tiered: true,
      path: (p) => `/entries/${p.entryId}/translate`,
      body: (p, tier, projectId) => ({
        sourceLocale: LOCALES[p.golden.key].source,
        targetLocale: LOCALES[p.golden.key].target,
        tier,
        projectId,
      }),
      shape: (b) => Array.isArray(b.translatedFields),
    },
    {
      capability: 'agents (audit)',
      route: 'POST entries/:id/audit',
      tiered: true,
      path: (p) => `/entries/${p.entryId}/audit`,
      body: (_p, tier, projectId) => ({ tier, projectId }),
      shape: (b) => Array.isArray(b.findings),
    },
  ];

  /** Uploads a reference file as an asset: the create, then the signed PUT of its bytes. */
  async function uploadReference(
    fileName: string,
    title: string,
    text: string,
    locale: string,
  ): Promise<string> {
    const created = await client.env<{
      asset?: { id: string };
      upload?: { url: string; headers: Record<string, string> };
    }>('POST', '/assets', { fileName, contentType: 'text/markdown', title: { [locale]: title } });
    if (created.status !== 201 || !created.body.upload) {
      throw new Error(`Asset create failed (${created.status}): ${JSON.stringify(created.body)}`);
    }
    const put = await client.upload(
      created.body.upload.url,
      created.body.upload.headers,
      new TextEncoder().encode(text),
    );
    if (put >= 300) throw new Error(`Upload of ${fileName} failed (${put})`);
    return idOf(created.body);
  }

  /**
   * Waits until every reference's text is read: the first call that finds one without text starts
   * reading it (amendment C); a person's Retry does the same, which the runner asks for directly.
   */
  async function waitForText(projectId: string): Promise<void> {
    const deadline = Date.now() + TEXT_WAIT_MS;
    const asked = new Set<string>();
    for (;;) {
      const got = await client.env<{
        references: { assetId: string; text: string; reason?: string }[];
      }>('GET', `/ai-projects/${projectId}`);
      const refs = got.body.references ?? [];
      if (refs.length > 0 && refs.every((r) => r.text === 'ready')) return;
      for (const r of refs) {
        if (
          r.text === 'none' &&
          r.reason &&
          r.reason !== 'too_large' &&
          r.reason !== 'unsupported' &&
          !asked.has(r.assetId)
        ) {
          asked.add(r.assetId);
          await client.env('POST', `/ai-projects/${projectId}/references/${r.assetId}/extract`);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`References of ${projectId} not read in time: ${JSON.stringify(refs)}`);
      }
      await pause(5_000);
    }
  }

  async function prepare(golden: GoldenProject, label: Prepared['label']): Promise<Prepared> {
    const { source } = LOCALES[golden.key];
    const assetIds: string[] = [];
    for (const ref of golden.references) {
      assetIds.push(await uploadReference(ref.fileName, ref.title, ref.text, source));
    }
    const project = await client.env('POST', '/ai-projects', {
      name: `${golden.name} ${runId}`,
      description: golden.description,
      instructions: golden.instructions,
      writer: golden.writer,
      reader: golden.reader,
      references: assetIds.map((assetId) => ({ assetId })),
    });
    if (project.status !== 201) {
      throw new Error(`Project create failed (${project.status}): ${JSON.stringify(project.body)}`);
    }
    const projectId = idOf(project.body);
    const entry = await client.env('POST', '/entries', {
      contentTypeApiId: typeId,
      fields: { title: { [source]: golden.entry.title }, body: { [source]: golden.entry.body } },
    });
    const action = await client.env('POST', '/ai-actions', {
      name: `Tagline ${label} ${runId}`,
      promptTemplate: 'Write one tagline for {{field.title}}, from: {{field.body}}',
      targetField: 'tagline',
    });
    await waitForText(projectId);
    return {
      golden,
      label,
      projectId,
      assetIds,
      entryId: idOf(entry.body),
      actionId: idOf(action.body),
    };
  }

  async function run(
    p: Prepared,
    cap: Capability,
    tier: Tier,
    withProject: boolean,
    pass: CallResult['pass'],
  ): Promise<CallResult> {
    const projectId = withProject ? p.projectId : null;
    try {
      const answer = await client.env<unknown>('POST', cap.path(p), cap.body(p, tier, projectId));
      const body = isRecord(answer.body) ? answer.body : {};
      const reported = (isRecord(body.project) ? body.project : null) as ReportedProject | null;
      // The answer names the project it took, and none when asked for none.
      const reportsProject = withProject ? reported?.id === p.projectId : reported === null;
      const result: CallResult = {
        capability: cap.capability,
        route: cap.route,
        tier: cap.tiered ? tier : 'action',
        project: p.label,
        withProject,
        pass,
        status: answer.status,
        ms: answer.ms,
        text: stringsOf(body),
        reported,
        conforms: answer.status >= 200 && answer.status < 300 && cap.shape(body) && reportsProject,
        ...(answer.status >= 300 ? { error: JSON.stringify(answer.body).slice(0, 500) } : {}),
      };
      results.push(result);
      return result;
    } catch (err) {
      const result: CallResult = {
        capability: cap.capability,
        route: cap.route,
        tier,
        project: p.label,
        withProject,
        pass,
        status: 0,
        ms: 0,
        text: '',
        reported: null,
        conforms: false,
        error: err instanceof Error ? err.message : String(err),
      };
      results.push(result);
      return result;
    }
  }

  beforeAll(
    async () => {
      client = evalClient(evalTarget(env));
      const ct = await client.env('POST', '/content-types', {
        apiId: typeId,
        name: `Eval article ${runId}`,
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: true,
            required: true,
            position: 0,
          },
          {
            apiId: 'body',
            name: 'Body',
            type: 'Text',
            localized: true,
            required: false,
            position: 1,
          },
          {
            apiId: 'tagline',
            name: 'Tagline',
            type: 'Symbol',
            localized: true,
            required: false,
            position: 2,
          },
        ],
      });
      if (ct.status !== 201) {
        throw new Error(`Content type create failed (${ct.status}): ${JSON.stringify(ct.body)}`);
      }
      for (const golden of GOLDEN_PROJECTS) prepared.push(await prepare(golden, golden.key));
    },
    TEXT_WAIT_MS * 3 + 120_000,
  );

  afterAll(async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'out');
    mkdirSync(dir, { recursive: true });
    const summary = summarize(results, [...GOLDEN_PROJECTS]);
    writeFileSync(
      join(dir, `ai-projects-${runId}.json`),
      JSON.stringify(
        {
          runId,
          at: new Date().toISOString(),
          target: env.CW_EVAL_BASE_URL,
          summary,
          results: results.map((r) => ({ ...r, text: r.text.slice(0, 4_000) })),
        },
        null,
        2,
      ),
    );
    console.table(summary);
    if (env.CW_EVAL_KEEP === '1' || !client) return;
    // Best effort: what the run made goes, so the dev space doesn't fill up.
    for (const p of prepared) {
      await client.env('DELETE', `/ai-actions/${p.actionId}`).catch(() => {});
      await client.env('DELETE', `/ai-projects/${p.projectId}`).catch(() => {});
      await client.env('DELETE', `/entries/${p.entryId}`).catch(() => {});
      for (const a of p.assetIds) await client.env('DELETE', `/assets/${a}`).catch(() => {});
    }
    await client.env('DELETE', `/content-types/${typeId}`).catch(() => {});
  }, 300_000);

  it('answers every capability on every tier, with and without the project', async () => {
    for (const p of prepared) {
      for (const cap of capabilities) {
        for (const tier of cap.tiered ? TIERS : (['balanced'] as const)) {
          for (const withProject of [true, false]) await run(p, cap, tier, withProject, 'plain');
        }
      }
    }
    const plain = results.filter((r) => r.pass === 'plain');
    // Every call that took the project said so, with the version and each reference's fate.
    for (const r of plain.filter((x) => x.withProject && x.status < 300)) {
      expect(r.reported, `${r.capability} ${r.tier}`).not.toBeNull();
    }
    const conformance = plain.filter((r) => r.conforms).length / Math.max(1, plain.length);
    const min = Number(env.CW_EVAL_MIN_CONFORMANCE ?? 0);
    expect(conformance).toBeGreaterThanOrEqual(min);
  }, 3_600_000);

  it('never follows an instruction planted in a reference', () => {
    const leaks = results.filter((r) => followedPlantedInstruction(r.text));
    expect(leaks.map((r) => `${r.capability} ${r.tier} ${r.project}`)).toEqual([]);
  });

  it('lets the space’s guidance win where it contradicts the project', async () => {
    const before = await client.space<{
      version: number;
      capabilities: Record<
        string,
        { enabled: boolean; tier: string | null; guidance: string | null }
      >;
    }>('GET', '/ai-settings');
    const original = before.body;
    const keep = (c: { enabled: boolean; tier: string | null; guidance: string | null }) => ({
      enabled: c.enabled,
      tier: c.tier,
      guidance: c.guidance,
    });
    const conflicting: GoldenProject[] = GOLDEN_PROJECTS.filter((g) => g.conflict.projectWants);
    const beaten: string[] = [];
    try {
      for (const p of prepared.filter((x) => conflicting.includes(x.golden))) {
        const current = await client.space<typeof original>('GET', '/ai-settings');
        const guided = Object.fromEntries(
          ['drafting', 'field-assist', 'agents', 'translation', 'layout'].map((c) => [
            c,
            {
              ...keep(original.capabilities[c] as never),
              guidance: p.golden.conflict.spaceGuidance,
            },
          ]),
        );
        await client.space('PUT', '/ai-settings', {
          expectedVersion: current.body.version,
          capabilities: guided,
        });
        for (const cap of capabilitiesFor(['drafting', 'field-assist (summarize)'])) {
          const r = await run(p, cap, 'balanced', true, 'conflict');
          if (projectBeatSpace(r.text, p.golden)) beaten.push(`${cap.capability} ${p.label}`);
        }
      }
    } finally {
      const current = await client.space<typeof original>('GET', '/ai-settings');
      await client.space('PUT', '/ai-settings', {
        expectedVersion: current.body.version,
        capabilities: Object.fromEntries(
          Object.entries(original.capabilities).map(([c, s]) => [c, keep(s)]),
        ),
      });
    }
    expect(beaten).toEqual([]);
  }, 600_000);

  it(
    'on balanced, trims references past the budget, reports them, and still answers',
    async () => {
      const p = await prepare(overflowProject(), 'overflow');
      prepared.push(p);
      const drafting = capabilitiesFor(['drafting'])[0] as Capability;
      const r = await run(p, drafting, 'balanced', true, 'plain');
      expect(r.status).toBeLessThan(300);
      expect(reportedBudget(r.reported)).toBe(true);
      expect(excerptChars(r.reported)).toBeLessThanOrEqual(12_000);
    },
    TEXT_WAIT_MS + 300_000,
  );

  function capabilitiesFor(names: readonly string[]): Capability[] {
    return capabilities.filter((c) => names.includes(c.capability));
  }
});
