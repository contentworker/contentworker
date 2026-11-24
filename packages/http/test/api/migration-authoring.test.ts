import { MigrationDriverFinishedError, NotFoundError, SCOPES } from '@contentworker/domain';
import type { ApiConfig } from '@contentworker/platform/config';
import type {
  MigrationDriverState,
  MigrationPublishApproved,
  MigrationRunner,
  MigrationRunParams,
  MigrationTemplateApproved,
} from '@contentworker/ports';
import { FakeRemoteFetcher, FakeSiteSource } from '@contentworker/test-kit';
import { InProcessImportScriptSandbox } from '@contentworker/test-kit/import-script';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { createApiHasher } from '../../src/api/auth';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const O = 'https://site.test';
const article = (title: string) =>
  `<html><head><title>${title}</title></head><body><main><article><h1>${title}</h1><div class="body"><p>${title} <b>text</b>.</p></div></article></main></body></html>`;
const SITE = {
  [`${O}/blog/one`]: article('One'),
  [`${O}/blog/two`]: article('Two'),
};

const M = '/spaces/s1/environments/main';
const RUNS = `${M}/migrations/runs`;

const field = (apiId: string, type: string, position: number, required = false) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required,
  position,
});
const MODEL = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  urlPattern: '/blog/{slug}',
  fields: [
    field('title', 'Symbol', 0, true),
    field('slug', 'Slug', 1, true),
    field('summary', 'RichText', 2),
    {
      ...field('body', 'Array', 3),
      items: {
        type: 'Component',
        variants: [{ apiId: 'text', name: 'Text', fields: [field('body', 'RichText', 0)] }],
      },
    },
  ],
};
const SCRIPT = `export default function (page) {
  return {
    fields: { title: page.text('h1'), slug: page.url.split('/').pop(), summary: { $html: page.html('.body') } },
    blocks: [{ variant: 'text', fields: { body: { $html: page.html('article') } } }],
    assets: [],
    links: [],
  };
}`;

/** Keys holding one set of scopes each, seeded beside the dev keys. */
const KEYS = {
  runner: [SCOPES.migrationRun],
  manager: [SCOPES.contentManage, SCOPES.previewRead],
  editor: [SCOPES.contentWrite, SCOPES.previewRead],
  writer: [SCOPES.migrationRun, SCOPES.contentWrite],
  loader: [SCOPES.migrationRun, SCOPES.contentWrite, SCOPES.assetsWrite],
  publisher: [SCOPES.contentPublish],
  releaser: [SCOPES.contentPublish, SCOPES.contentWrite],
} as const;

/** Records what the driver is sent, with the template's status in the store at that moment. */
class RecordingRunner implements MigrationRunner {
  readonly calls: { kind: string; status?: string | undefined; payload: unknown }[] = [];
  private readonly running = new Set<string>();
  constructor(
    private readonly read: (runId: string, templateId: string) => Promise<string | undefined>,
  ) {}
  readonly finished = new Set<string>();
  /** Every signal fails this way: no instance, or the binding failing. */
  failSignals?: 'missing' | 'broken';
  async start(params: MigrationRunParams): Promise<MigrationDriverState> {
    this.calls.push({ kind: 'start', payload: params });
    if (this.finished.has(params.runId)) return 'finished';
    if (this.running.has(params.runId)) return 'running';
    this.running.add(params.runId);
    return 'started';
  }
  private refuse(runId: string): void {
    if (this.failSignals === 'missing') throw new NotFoundError('Migration driver', runId);
    if (this.failSignals === 'broken') throw new Error('internal error: Workflows is unavailable');
    if (this.finished.has(runId)) throw new MigrationDriverFinishedError(runId);
  }
  async templateApproved(
    _scope: unknown,
    runId: string,
    templateId: string,
    event: MigrationTemplateApproved,
  ): Promise<void> {
    this.refuse(runId);
    this.calls.push({
      kind: 'templateApproved',
      status: await this.read(runId, templateId),
      payload: event,
    });
  }
  async publishApproved(_scope: unknown, runId: string, event: MigrationPublishApproved) {
    this.refuse(runId);
    // As the Cloudflare runner answers a run with no Workflow instance.
    if (!this.running.has(runId)) throw new NotFoundError('Migration driver', runId);
    this.calls.push({ kind: 'publishApproved', payload: event });
  }
}

function makeApp(
  opts: { pages?: Record<string, string>; runner?: boolean; sandbox?: boolean } = {},
) {
  const wired = wire(config);
  const store = wired.ctx.store as unknown as { seedApiKey(key: Record<string, unknown>): void };
  for (const [name, scopes] of Object.entries(KEYS)) {
    store.seedApiKey({
      id: `key-${name}`,
      spaceId: 's1',
      kind: 'cma',
      name,
      hashedToken: createApiHasher(config.tokenPepper).hash(name),
      scopes: [...scopes],
      revoked: false,
    });
  }
  const scope = { spaceId: 's1', environmentId: 'main' };
  const runner = new RecordingRunner(
    async (runId, templateId) =>
      (await wired.ctx.store.migrations.getTemplate(scope, runId, templateId))?.status,
  );
  const sandbox = new InProcessImportScriptSandbox();
  const app = createApp(
    wired.ctx,
    config,
    wired.rag,
    wired.blob,
    wired.ai,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      siteSource: new FakeSiteSource(opts.pages ?? SITE),
      remoteFetcher: new FakeRemoteFetcher(),
      ...(opts.sandbox === false ? {} : { importScriptSandbox: sandbox }),
      ...(opts.runner === false ? {} : { migrationRunner: runner }),
    },
  );
  const send = (method: string, path: string, body?: unknown, token = 'runner', base = RUNS) =>
    app.request(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { app, wired, send, runner, sandbox };
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${res.status} ${res.url}: ${text.slice(0, 200)}`);
  }
}

interface Template {
  id: string;
  status: string;
  reviewDigest: string;
  proposal: { apiId: string } | null;
  script: { sha256: string; bytes: number } | null;
  lastTry: { pages: number; ok: number } | null;
  approvedBy: unknown;
}

/** A run clustered into its one template, with that template's id and path. */
async function clustered(send: ReturnType<typeof makeApp>['send']) {
  const run = await json<{ id: string }>(
    await send('POST', '', { source: { kind: 'sitemap', url: `${O}/` } }),
  );
  await send('POST', `/${run.id}/inventory`);
  while ((await json<{ more: boolean }>(await send('POST', `/${run.id}/fetch`, {}))).more) {}
  const view = await json<{ templates: { id: string }[] }>(
    await send('POST', `/${run.id}/cluster`, {}),
  );
  const template = view.templates[0]?.id as string;
  return { run: run.id, template, t: `/${run.id}/templates/${template}` };
}

/** Authored (proposed and scripted), and the digest a reviewer would read. */
async function authored(send: ReturnType<typeof makeApp>['send']) {
  const c = await clustered(send);
  expect((await send('POST', `${c.t}/proposal`, { model: MODEL })).status).toBe(200);
  expect((await send('PUT', `${c.t}/script`, { script: SCRIPT })).status).toBe(200);
  const read = await json<Template>(await send('GET', c.t, undefined, 'manager'));
  return { ...c, digest: read.reviewDigest };
}

describe('authoring a migration template over HTTP', () => {
  it('proposes, scripts, tries, approves, transforms, loads, relinks, redirects and publishes', async () => {
    const { send, runner } = makeApp();
    const c = await clustered(send);

    const pending = await json<Template>(await send('GET', c.t, undefined, 'manager'));
    expect(pending).toMatchObject({ status: 'pending', proposal: null, script: null });
    expect(pending.reviewDigest).toMatch(/^[0-9a-f]{64}$/);

    const proposed = await json<Template>(await send('POST', `${c.t}/proposal`, { model: MODEL }));
    expect(proposed).toMatchObject({ status: 'authoring', proposal: { apiId: 'article' } });
    const scripted = await json<Template>(await send('PUT', `${c.t}/script`, { script: SCRIPT }));
    expect(scripted.script).toEqual({ sha256: expect.any(String), bytes: SCRIPT.length });
    // A new script is a new version to review.
    expect(scripted.reviewDigest).not.toBe(proposed.reviewDigest);
    expect(await json(await send('GET', `${c.t}/script`, undefined, 'manager'))).toEqual({
      script: SCRIPT,
      sha256: scripted.script?.sha256,
    });

    const tried = await send('POST', `${c.t}/try`, {});
    expect(tried.status).toBe(200);
    const tryBody = await json<{
      summary: { pages: number; ok: number };
      results: { ok: boolean; output: { fields: { summary: { nodeType: string } } } }[];
    }>(tried);
    expect(tryBody.summary).toMatchObject({ pages: 2, ok: 2 });
    // Rich text leaves as a document, never as the fragment the script returned.
    expect(tryBody.results[0]?.output.fields.summary.nodeType).toBe('document');
    expect(JSON.stringify(tryBody)).not.toMatch(/\$html|<p>|<b>|<article/);
    const afterTry = await json<Template>(await send('GET', c.t, undefined, 'runner'));
    expect(afterTry.lastTry).toMatchObject({ pages: 2, ok: 2 });
    // A try isn't something reviewed: the digest holds.
    expect(afterTry.reviewDigest).toBe(scripted.reviewDigest);

    const approved = await send(
      'POST',
      `${c.t}/approve`,
      { reviewed: scripted.reviewDigest },
      'manager',
    );
    expect(approved.status).toBe(200);
    expect(await json(approved)).toMatchObject({
      template: { status: 'approved', approvedBy: { kind: 'key', keyId: 'key-manager' } },
      signalled: true,
    });
    // The driver heard of it only once the store held it.
    expect(runner.calls).toEqual([
      {
        kind: 'templateApproved',
        status: 'approved',
        payload: { approvedBy: { kind: 'key', keyId: 'key-manager' } },
      },
    ]);

    const transformed = await json<{ transformed: number; validated: number; more: boolean }>(
      await send('POST', `${c.t}/transform`, {}),
    );
    expect(transformed).toMatchObject({ transformed: 2, more: false });
    const loaded = await send('POST', `${c.t}/load`, { includeNeedsFix: true }, 'loader');
    expect(loaded.status).toBe(200);
    expect(await json(loaded)).toMatchObject({ loaded: 2, failed: [], more: false });
    // Loading again updates the same entries rather than adding two more.
    expect(
      await json(await send('POST', `${c.t}/load`, { includeNeedsFix: true }, 'loader')),
    ).toMatchObject({ loaded: 0, more: false });
    const loadedPages = await json<{ items: { entryId: string | null }[] }>(
      await send('GET', `/${c.run}/pages?stage=loaded`, undefined, 'manager'),
    );
    const entryIds = loadedPages.items.map((p) => p.entryId);
    expect(new Set(entryIds).size).toBe(2);
    for (const id of entryIds) {
      const entry = await json<{ fields: { summary: Record<string, unknown> } }>(
        await send('GET', `/entries/${id}`, undefined, 'cma', M),
      );
      // Stored as a document tree, never as the markup the script returned.
      expect(JSON.stringify(entry)).not.toMatch(/\$html|<p>|<b>/);
      expect(JSON.stringify(entry.fields.summary)).toContain('document');
    }

    expect(await json(await send('POST', `/${c.run}/relink`, {}, 'writer'))).toMatchObject({
      relinked: 0,
    });
    // The old paths are the new ones: nothing to redirect.
    expect(await json(await send('POST', `/${c.run}/redirects`, {}, 'manager'))).toMatchObject({
      created: 0,
      skipped: { identity: 2 },
    });
    const published = await json<{ published: number; failed: unknown[] }>(
      await send('POST', `/${c.run}/publish`, {}, 'publisher'),
    );
    expect(published).toMatchObject({ published: 2, failed: [] });
    const pages = await json<{ items: { stage: string }[] }>(
      await send('GET', `/${c.run}/pages`, undefined, 'manager'),
    );
    expect(pages.items.map((p) => p.stage)).toEqual(['published', 'published']);
  });

  it('refuses a stale digest, and an approval of a template changed since it was read', async () => {
    const { send, runner } = makeApp();
    const c = await authored(send);
    const stale = await send('POST', `${c.t}/approve`, { reviewed: '0'.repeat(64) }, 'manager');
    expect(stale.status).toBe(409);
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe('conflict');
    // The agent writes a new script while the person reviews the old one.
    await send('PUT', `${c.t}/script`, { script: `${SCRIPT}\n// v2` });
    expect((await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager')).status).toBe(
      409,
    );
    expect((await json<Template>(await send('GET', c.t))).status).toBe('authoring');
    expect(runner.calls).toEqual([]);
    expect((await send('POST', `${c.t}/approve`, { reviewed: 'short' }, 'manager')).status).toBe(
      422,
    );
  });

  it('holds an approved template’s model and script, and approving again tells the driver again', async () => {
    const { send, runner } = makeApp();
    const c = await authored(send);
    await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager');
    expect(
      (await send('PUT', `${c.t}/script`, { script: 'export default () => ({})' })).status,
    ).toBe(400);
    expect((await send('POST', `${c.t}/proposal`, { model: MODEL })).status).toBe(400);
    const again = await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager');
    expect(await json(again)).toMatchObject({ template: { status: 'approved' }, signalled: true });
    expect(runner.calls.map((call) => call.kind)).toEqual(['templateApproved', 'templateApproved']);
  });

  it('approves without a driver bound, saying it told none', async () => {
    const { send } = makeApp({ runner: false });
    const c = await authored(send);
    const res = await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager');
    expect(await json(res)).toMatchObject({
      template: { status: 'approved' },
      signalled: false,
      reason: 'no-driver',
    });
    expect((await send('POST', `/${c.run}/start`)).status).toBe(501);
    expect((await send('POST', `/${c.run}/publish-approval`, {}, 'publisher')).status).toBe(501);
  });

  it('answers 501 for a try or transform where scripts can’t run', async () => {
    const { send } = makeApp({ sandbox: false });
    const c = await authored(send);
    expect((await send('POST', `${c.t}/try`, {})).status).toBe(501);
    expect((await send('POST', `${c.t}/transform`, {})).status).toBe(501);
  });
});

describe('request caps', () => {
  it('tries at most five pages, and transforms and loads at most ten a request', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`${O}/blog/p${i}`, article(`P${i}`)]),
    );
    const { send, sandbox } = makeApp({ pages: many });
    const c = await authored(send);
    const ids = (
      await json<{ items: { id: string }[] }>(await send('GET', `/${c.run}/pages`))
    ).items.map((p) => p.id);
    expect((await send('POST', `${c.t}/try`, { pageIds: ids.slice(0, 6) })).status).toBe(422);
    expect((await send('POST', `${c.t}/try`, { pageIds: ids.slice(0, 5) })).status).toBe(200);
    expect(sandbox.runs).toHaveLength(5);

    await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager');
    expect((await send('POST', `${c.t}/transform`, { limit: 11 })).status).toBe(422);
    const first = await json<{ transformed: number; more: boolean; next: string }>(
      await send('POST', `${c.t}/transform`, {}),
    );
    expect(first).toMatchObject({ transformed: 10, more: true });
    const rest = await json<{ transformed: number; more: boolean }>(
      await send('POST', `${c.t}/transform`, { after: first.next }),
    );
    expect(rest).toMatchObject({ transformed: 2, more: false });

    expect((await send('POST', `${c.t}/load`, { limit: 11 }, 'loader')).status).toBe(422);
    const loaded = await json<{ loaded: number; more: boolean }>(
      await send('POST', `${c.t}/load`, { includeNeedsFix: true }, 'loader'),
    );
    expect(loaded).toMatchObject({ loaded: 10, more: true });
    expect((await send('POST', `/${c.run}/relink`, { limit: 51 }, 'writer')).status).toBe(422);
    expect((await send('POST', `/${c.run}/publish`, { limit: 51 }, 'publisher')).status).toBe(422);
    expect(
      (await send('PUT', `${c.t}/script`, { script: 'x'.repeat(256 * 1024 + 1) })).status,
    ).toBe(422);
  });
});

describe('the run’s driver', () => {
  it('starts once as the caller, and takes the go-ahead to publish', async () => {
    const { send, runner } = makeApp();
    const c = await clustered(send);
    // No driver yet: the go-ahead has nowhere to go.
    expect((await send('POST', `/${c.run}/publish-approval`, {}, 'publisher')).status).toBe(404);
    const first = await send('POST', `/${c.run}/start`);
    expect(first.status).toBe(202);
    expect(await json(first)).toEqual({ started: true });
    expect(await json(await send('POST', `/${c.run}/start`))).toEqual({ started: false });
    expect(runner.calls[0]?.payload).toEqual({
      scope: { spaceId: 's1', environmentId: 'main' },
      runId: c.run,
      startedBy: { kind: 'key', keyId: 'key-runner' },
    });

    expect((await send('POST', `/${c.run}/publish-approval`, {}, 'publisher')).status).toBe(202);
    expect(
      (await send('POST', `/${c.run}/publish-approval`, { viaRelease: true }, 'releaser')).status,
    ).toBe(202);
    expect(
      runner.calls.filter((call) => call.kind === 'publishApproved').map((call) => call.payload),
    ).toEqual([
      { approvedBy: { kind: 'key', keyId: 'key-publisher' } },
      { approvedBy: { kind: 'key', keyId: 'key-releaser' }, viaRelease: true },
    ]);
    // The approver is who is signed in; a body can't name another.
    expect(
      (
        await send(
          'POST',
          `/${c.run}/publish-approval`,
          { approvedBy: { kind: 'deployment' } },
          'publisher',
        )
      ).status,
    ).toBe(202);
    expect(runner.calls.at(-1)?.payload).toEqual({
      approvedBy: { kind: 'key', keyId: 'key-publisher' },
    });
  });
});

describe('a driver that has finished', () => {
  it('refuses start and the go-ahead, and approval says so', async () => {
    const { send, runner } = makeApp();
    const c = await authored(send);
    runner.finished.add(c.run);
    const start = await send('POST', `/${c.run}/start`);
    expect(start.status).toBe(400);
    expect((await json<{ error: { code: string } }>(start)).error.code).toBe('invalid_state');
    expect((await send('POST', `/${c.run}/publish-approval`, {}, 'publisher')).status).toBe(400);
    const approved = await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager');
    expect(await json(approved)).toMatchObject({
      template: { status: 'approved' },
      signalled: false,
      reason: 'driver-finished',
    });
  });

  it('answers a transient driver failure on approval as unreachable, the approval standing', async () => {
    const { send, runner } = makeApp();
    const c = await authored(send);
    runner.failSignals = 'broken';
    const approved = await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager');
    expect(approved.status).toBe(200);
    expect(await json(approved)).toMatchObject({ signalled: false, reason: 'unreachable' });
    expect((await json<Template>(await send('GET', c.t))).status).toBe('approved');
  });

  it('refuses a release named without viaRelease, on the publish and the go-ahead', async () => {
    const { send } = makeApp();
    const c = await clustered(send);
    await send('POST', `/${c.run}/start`);
    for (const body of [{ releaseId: 'r1' }, { releaseTitle: 'Launch' }]) {
      expect((await send('POST', `/${c.run}/publish`, body, 'releaser')).status).toBe(422);
      expect((await send('POST', `/${c.run}/publish-approval`, body, 'releaser')).status).toBe(422);
    }
  });
});

describe('reopening an approved template', () => {
  it('changes it, approves it again and takes its pages that aren’t loaded again', async () => {
    const { send, runner } = makeApp();
    const c = await authored(send);
    // Nothing to reopen before it is approved.
    const early = await send('POST', `${c.t}/reopen`, { reviewed: c.digest }, 'manager');
    expect(early.status).toBe(400);
    expect((await json<{ error: { code: string } }>(early)).error.code).toBe('invalid_state');
    await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager');
    await send('POST', `${c.t}/transform`, {});

    expect(
      (await send('POST', `${c.t}/reopen`, { reviewed: '0'.repeat(64) }, 'manager')).status,
    ).toBe(409);
    expect((await send('POST', `${c.t}/reopen`, { reviewed: 'short' }, 'manager')).status).toBe(
      422,
    );
    const reopened = await send('POST', `${c.t}/reopen`, { reviewed: c.digest }, 'manager');
    expect(reopened.status).toBe(200);
    expect(await json(reopened)).toMatchObject({
      status: 'authoring',
      contentTypeId: MODEL.apiId,
      approvedBy: null,
    });
    expect((await send('POST', `${c.t}/transform`, {})).status).toBe(400);
    const renamed = await send('POST', `${c.t}/proposal`, { model: { ...MODEL, apiId: 'other' } });
    expect(renamed.status).toBe(422);
    expect(await renamed.text()).toContain('must stay');
    expect((await send('PUT', `${c.t}/script`, { script: `${SCRIPT}\n// v2` })).status).toBe(200);
    const read = await json<Template>(await send('GET', c.t, undefined, 'manager'));
    // The approver who read the first version isn't told they approved this one.
    expect((await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager')).status).toBe(
      409,
    );
    await send('POST', `${c.t}/approve`, { reviewed: read.reviewDigest }, 'manager');
    expect((await send('POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager')).status).toBe(
      409,
    );
    expect(runner.calls.map((call) => call.kind)).toEqual(['templateApproved', 'templateApproved']);
    const now = await json<{ pageVersions: { toTransform: number; loadedEarlier: number } }>(
      await send('GET', c.t),
    );
    expect(now.pageVersions).toEqual({ toTransform: expect.any(Number), loadedEarlier: 0 });
    expect(now.pageVersions.toTransform).toBeGreaterThan(0);
    expect(await json(await send('POST', `${c.t}/load`, {}, 'loader'))).toMatchObject({
      loaded: 0,
    });
    expect(
      (await json<{ transformed: number }>(await send('POST', `${c.t}/transform`, {}))).transformed,
    ).toBeGreaterThan(0);
  });
});

describe('authorization and isolation', () => {
  it('checks each step’s scopes, sending nothing when it refuses', async () => {
    const { send, runner } = makeApp();
    const c = await authored(send);
    const refusals: [string, string, unknown, string][] = [
      ['GET', c.t, undefined, 'editor'],
      ['GET', `${c.t}/script`, undefined, 'editor'],
      ['POST', `${c.t}/proposal`, { model: MODEL }, 'manager'],
      ['PUT', `${c.t}/script`, { script: SCRIPT }, 'manager'],
      ['POST', `${c.t}/try`, {}, 'manager'],
      ['POST', `${c.t}/approve`, { reviewed: c.digest }, 'editor'],
      // Reaches the route, but approving needs content:manage.
      ['POST', `${c.t}/approve`, { reviewed: c.digest }, 'runner'],
      ['POST', `${c.t}/reopen`, { reviewed: c.digest }, 'editor'],
      ['POST', `${c.t}/reopen`, { reviewed: c.digest }, 'runner'],
      ['POST', `${c.t}/transform`, {}, 'manager'],
      ['POST', `${c.t}/load`, {}, 'runner'],
      ['POST', `${c.t}/load`, {}, 'editor'],
      ['POST', `/${c.run}/relink`, {}, 'runner'],
      ['POST', `/${c.run}/relink`, {}, 'editor'],
      ['POST', `/${c.run}/redirects`, {}, 'runner'],
      ['POST', `/${c.run}/publish`, {}, 'runner'],
      ['POST', `/${c.run}/publish`, { viaRelease: true }, 'publisher'],
      ['POST', `/${c.run}/start`, undefined, 'manager'],
      ['POST', `/${c.run}/publish-approval`, {}, 'runner'],
      ['POST', `/${c.run}/publish-approval`, { viaRelease: true }, 'publisher'],
    ];
    for (const [method, path, body, token] of refusals) {
      expect((await send(method, path, body, token)).status, `${method} ${path} as ${token}`).toBe(
        403,
      );
    }
    expect(runner.calls).toEqual([]);
    expect((await json<Template>(await send('GET', c.t))).status).toBe('authoring');
    // What each reads with: a content manager follows the template and reads its script.
    expect((await send('GET', c.t, undefined, 'manager')).status).toBe(200);
    expect((await send('GET', `${c.t}/script`, undefined, 'manager')).status).toBe(200);
  });

  it('keeps every step to its environment, and tells no driver of another’s run', async () => {
    const { app, send, runner } = makeApp();
    const c = await authored(send);
    const created = await app.request('/spaces/s1/environments', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'staging' }),
    });
    expect(created.status).toBeLessThan(300);
    const staging = '/spaces/s1/environments/staging/migrations/runs';
    const calls: [string, string, unknown][] = [
      ['GET', c.t, undefined],
      ['GET', `${c.t}/script`, undefined],
      ['POST', `${c.t}/proposal`, { model: MODEL }],
      ['PUT', `${c.t}/script`, { script: SCRIPT }],
      ['POST', `${c.t}/try`, {}],
      ['POST', `${c.t}/approve`, { reviewed: c.digest }],
      ['POST', `${c.t}/reopen`, { reviewed: c.digest }],
      ['POST', `${c.t}/transform`, {}],
      ['POST', `${c.t}/load`, {}],
      ['POST', `/${c.run}/relink`, {}],
      ['POST', `/${c.run}/redirects`, {}],
      ['POST', `/${c.run}/publish`, {}],
      ['POST', `/${c.run}/start`, undefined],
      ['POST', `/${c.run}/publish-approval`, {}],
    ];
    for (const [method, path, body] of calls) {
      expect((await send(method, path, body, 'admin', staging)).status, `${method} ${path}`).toBe(
        404,
      );
    }
    expect(runner.calls).toEqual([]);
    expect((await json<Template>(await send('GET', c.t))).status).toBe('authoring');
  });

  it('refuses a key of this space on another space’s path, telling no driver', async () => {
    const { send, runner } = makeApp();
    const c = await authored(send);
    const other = '/spaces/s2/environments/main/migrations/runs';
    for (const [method, path, body, token] of [
      ['GET', c.t, undefined, 'manager'],
      ['POST', `${c.t}/approve`, { reviewed: c.digest }, 'manager'],
      ['POST', `/${c.run}/start`, undefined, 'runner'],
      ['POST', `/${c.run}/publish-approval`, {}, 'publisher'],
      ['POST', `${c.t}/load`, {}, 'loader'],
    ] as const) {
      expect((await send(method, path, body, token, other)).status, `${method} ${path}`).toBe(403);
    }
    expect(runner.calls).toEqual([]);
  });
});
