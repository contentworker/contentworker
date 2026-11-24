import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type AppContext, createEnvironment, createSpace } from '@contentworker/application';
import {
  MigrationDriverFinishedError,
  type MigrationDriverStatus,
  NotFoundError,
  type Principal,
  SCOPES,
} from '@contentworker/domain';
import type {
  MigrationDriverState,
  MigrationPublishApproved,
  MigrationRunner,
  MigrationRunParams,
  MigrationTemplateApproved,
} from '@contentworker/ports';
import {
  FakeBlobStore,
  FakePasswordHasher,
  FakeRemoteFetcher,
  FakeSiteSource,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { InProcessImportScriptSandbox } from '@contentworker/test-kit/import-script';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { TOOL_SCOPES, toolListedFor } from '../../src/mcp/tool-scopes';

const SPACE = 'space-1';
const O = 'https://site.test';
const key = (id: string, scopes: string[]): Principal => ({
  spaceId: SPACE,
  kind: 'cma',
  keyId: `key-${id}`,
  scopes: scopes as Principal['scopes'],
});
const runner = key('runner', [SCOPES.migrationRun]);
const manager = key('manager', [SCOPES.contentManage]);
const editor = key('editor', [SCOPES.contentWrite, SCOPES.previewRead]);
const loader = key('loader', [SCOPES.migrationRun, SCOPES.contentWrite]);
const publisher = key('publisher', [SCOPES.contentPublish]);
const admin: Principal = { spaceId: SPACE, kind: 'admin', scopes: Object.values(SCOPES) };

const article = (t: string) =>
  `<html><body><main><article><h1>${t}</h1><div class="body"><p>${t} <b>text</b>.</p></div></article></main></body></html>`;
const SITE = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`${O}/blog/p${i}`, article(`P${i}`)]),
);

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
const SCRIPT = `export default (page) => ({
  fields: { title: page.text('h1'), slug: page.url.split('/').pop(), summary: { $html: page.html('.body') } },
  blocks: [{ variant: 'text', fields: { body: { $html: page.html('article') } } }],
  assets: [],
  links: [],
});`;

class RecordingRunner implements MigrationRunner {
  readonly calls: { kind: string; status?: string | undefined; payload: unknown }[] = [];
  private readonly running = new Set<string>();
  constructor(private readonly ctx: AppContext) {}
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
    scope: { spaceId: string; environmentId: string },
    runId: string,
    templateId: string,
    event: MigrationTemplateApproved,
  ) {
    this.refuse(runId);
    const t = await this.ctx.store.migrations.getTemplate(scope, runId, templateId);
    this.calls.push({ kind: 'templateApproved', status: t?.status, payload: event });
  }
  async publishApproved(_scope: unknown, runId: string, event: MigrationPublishApproved) {
    this.refuse(runId);
    if (!this.running.has(runId)) throw new NotFoundError('Migration driver', runId);
    this.calls.push({ kind: 'publishApproved', payload: event });
  }
  /** Asking where a driver is fails. */
  unreachable = false;
  async status(_scope: unknown, runId: string): Promise<MigrationDriverStatus> {
    if (this.unreachable) throw new Error('internal error: Workflows is unavailable');
    if (this.finished.has(runId)) return 'finished';
    return this.running.has(runId) ? 'waiting' : 'none';
  }
}

async function setup(opts: { runner?: boolean; sandbox?: boolean } = {}) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
    passwords: new FakePasswordHasher(),
  };
  const sandbox = new InProcessImportScriptSandbox();
  const driver = new RecordingRunner(ctx);
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
    siteSource: new FakeSiteSource(SITE),
    remoteFetcher: new FakeRemoteFetcher(),
    ...(opts.sandbox === false ? {} : { importScriptSandbox: sandbox }),
    ...(opts.runner === false ? {} : { migrationRunner: driver }),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  return { ctx, deps, sandbox, driver };
}

async function connect(deps: McpDeps, principal: Principal) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(deps, principal).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return {
      isError: r.isError === true,
      body: (text.startsWith('{') ? JSON.parse(text) : null) as never,
      text,
    };
  };
}

interface Template {
  status: string;
  reviewDigest: string;
  lastTry: { pages: number } | null;
}

/** A run clustered into its one template, proposed and scripted, as the runner. */
async function authored(deps: McpDeps) {
  const call = await connect(deps, runner);
  const run = (await call('migration_create', { source: { kind: 'sitemap', url: `${O}/` } }))
    .body as { id: string };
  await call('migration_inventory', { run: run.id });
  while (((await call('migration_fetch_pages', { run: run.id })).body as { more: boolean }).more) {}
  const view = (await call('migration_cluster', { run: run.id })).body as {
    templates: { id: string }[];
  };
  const ref = { run: run.id, template: view.templates[0]?.id as string };
  expect((await call('migration_propose_model', { ...ref, model: MODEL })).isError).toBe(false);
  expect((await call('migration_script_set', { ...ref, script: SCRIPT })).isError).toBe(false);
  const read = (await call('migration_template_get', ref)).body as Template;
  return { call, ref, digest: read.reviewDigest };
}

describe('site migration authoring tools', () => {
  it('take a template from proposal to published, as the HTTP routes do', async () => {
    const { deps, driver } = await setup();
    const { call, ref, digest } = await authored(deps);
    expect(((await call('migration_script_get', ref)).body as { script: string }).script).toBe(
      SCRIPT,
    );

    const tried = await call('migration_script_try', ref);
    expect(tried.isError).toBe(false);
    expect(tried.text).not.toMatch(/\$html|<p>|<b>|<article/);
    expect((tried.body as { summary: { ok: number } }).summary.ok).toBeGreaterThan(0);

    const asManager = await connect(deps, manager);
    const approved = await asManager('migration_template_approve', { ...ref, reviewed: digest });
    expect(approved.body).toMatchObject({ template: { status: 'approved' }, signalled: true });
    expect(driver.calls).toEqual([
      {
        kind: 'templateApproved',
        status: 'approved',
        payload: { approvedBy: { kind: 'key', keyId: 'key-manager' } },
      },
    ]);

    // Ten a call at most, then the rest from `next`.
    const first = (await call('migration_transform', ref)).body as {
      transformed: number;
      more: boolean;
      next: string;
    };
    expect(first).toMatchObject({ transformed: 10, more: true });
    expect((await call('migration_transform', { ...ref, after: first.next })).body).toMatchObject({
      transformed: 2,
      more: false,
    });
    expect((await call('migration_transform', { ...ref, limit: 11 })).isError).toBe(true);

    const asLoader = await connect(deps, loader);
    expect(
      (await asLoader('migration_load', { ...ref, includeNeedsFix: true })).body,
    ).toMatchObject({ loaded: 10, more: true });
    expect(
      (await asLoader('migration_load', { ...ref, includeNeedsFix: true })).body,
    ).toMatchObject({ loaded: 2, more: false });
    expect((await asLoader('migration_relink', { run: ref.run })).isError).toBe(false);
    expect((await asManager('migration_redirects', { run: ref.run })).body).toMatchObject({
      skipped: { identity: 12 },
    });
    const asPublisher = await connect(deps, publisher);
    expect((await asPublisher('migration_publish_entries', { run: ref.run })).body).toMatchObject({
      published: 12,
      failed: [],
    });
  });

  it('refuse a stale digest, and try at most five pages', async () => {
    const { deps, driver, sandbox } = await setup();
    const { call, ref, digest } = await authored(deps);
    await call('migration_script_set', { ...ref, script: `${SCRIPT}\n// v2` });
    const asManager = await connect(deps, manager);
    const stale = await asManager('migration_template_approve', { ...ref, reviewed: digest });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/changed after it was reviewed/);
    expect(driver.calls).toEqual([]);

    const pages = (await call('migration_pages', { run: ref.run })).body as {
      items: { id: string }[];
    };
    const ids = pages.items.map((p) => p.id);
    expect((await call('migration_script_try', { ...ref, pageIds: ids.slice(0, 6) })).isError).toBe(
      true,
    );
    expect(sandbox.runs).toHaveLength(0);
    expect((await call('migration_script_try', { ...ref, pageIds: ids.slice(0, 5) })).isError).toBe(
      false,
    );
    expect(sandbox.runs).toHaveLength(5);
  });

  it('reopen an approved template, as the route does', async () => {
    const { deps } = await setup();
    const { call, ref, digest } = await authored(deps);
    const asManager = await connect(deps, manager);
    const early = await asManager('migration_template_reopen', { ...ref, reviewed: digest });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/Only an approved template is reopened/);
    await asManager('migration_template_approve', { ...ref, reviewed: digest });
    const stale = await asManager('migration_template_reopen', {
      ...ref,
      reviewed: '0'.repeat(64),
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/read it again/);
    expect(
      (await asManager('migration_template_reopen', { ...ref, reviewed: digest })).body,
    ).toMatchObject({ status: 'authoring', contentTypeId: 'article', approvedBy: null });
    const renamed = await call('migration_propose_model', {
      ...ref,
      model: { ...MODEL, apiId: 'other' },
    });
    expect(renamed.isError).toBe(true);
    expect(renamed.text).toMatch(/must stay/);
    await call('migration_script_set', { ...ref, script: `${SCRIPT}\n// v2` });
    const read = (await call('migration_template_get', ref)).body as { reviewDigest: string };
    expect(
      (await asManager('migration_template_approve', { ...ref, reviewed: read.reviewDigest })).body,
    ).toMatchObject({ template: { status: 'approved' } });
    expect((await call('migration_template_get', ref)).body).toMatchObject({
      pageVersions: { toTransform: 12, loadedEarlier: 0 },
    });
  });

  it('start the driver once as the caller, and send it the go-ahead', async () => {
    const { deps, driver } = await setup();
    const { call, ref } = await authored(deps);
    const asPublisher = await connect(deps, publisher);
    const early = await asPublisher('migration_publish', { run: ref.run });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/Migration driver .* was not found/);
    expect((await call('migration_start', { run: ref.run })).body).toEqual({ started: true });
    expect((await call('migration_start', { run: ref.run })).body).toEqual({ started: false });
    expect((await asPublisher('migration_publish', { run: ref.run })).body).toEqual({
      accepted: true,
      signalled: true,
    });
    // One a run: the same again is answered again, another's is a conflict.
    expect((await asPublisher('migration_publish', { run: ref.run })).isError).toBeFalsy();
    const taken = await (await connect(deps, admin))('migration_publish', { run: ref.run });
    expect(taken.isError).toBe(true);
    expect(taken.text).toMatch(/go_ahead_taken/);
    expect(
      ((await call('migration_status', { run: ref.run })).body as { driver: unknown }).driver,
    ).toMatchObject({
      state: 'waiting',
      startedBy: { kind: 'key', keyId: 'key-runner' },
      startedByYou: true,
      goAhead: {
        status: 'given',
        approvedBy: { kind: 'key', keyId: 'key-publisher' },
        delivered: true,
      },
    });
    expect(driver.calls.map((c) => c.payload)).toEqual([
      {
        scope: { spaceId: SPACE, environmentId: 'main' },
        runId: ref.run,
        startedBy: { kind: 'key', keyId: 'key-runner' },
        recorded: true,
      },
      {
        scope: { spaceId: SPACE, environmentId: 'main' },
        runId: ref.run,
        startedBy: { kind: 'key', keyId: 'key-runner' },
        recorded: true,
      },
      { approvedBy: { kind: 'key', keyId: 'key-publisher' }, recorded: true },
      { approvedBy: { kind: 'key', keyId: 'key-publisher' }, recorded: true },
    ]);
  });

  it('check the same scopes as the routes, sending nothing when they refuse', async () => {
    const { deps, driver } = await setup();
    const { ref, digest } = await authored(deps);
    const refusals: [Principal, string, Record<string, unknown>][] = [
      [editor, 'migration_template_get', ref],
      [editor, 'migration_script_get', ref],
      [manager, 'migration_propose_model', { ...ref, model: MODEL }],
      [manager, 'migration_script_set', { ...ref, script: SCRIPT }],
      [manager, 'migration_script_try', ref],
      [editor, 'migration_template_approve', { ...ref, reviewed: digest }],
      [runner, 'migration_template_approve', { ...ref, reviewed: digest }],
      [editor, 'migration_template_reopen', { ...ref, reviewed: digest }],
      [runner, 'migration_template_reopen', { ...ref, reviewed: digest }],
      [manager, 'migration_transform', ref],
      [runner, 'migration_load', ref],
      [editor, 'migration_load', ref],
      [runner, 'migration_relink', { run: ref.run }],
      [editor, 'migration_relink', { run: ref.run }],
      [runner, 'migration_redirects', { run: ref.run }],
      [runner, 'migration_publish_entries', { run: ref.run }],
      [publisher, 'migration_publish_entries', { run: ref.run, viaRelease: true }],
      [manager, 'migration_start', { run: ref.run }],
      [runner, 'migration_publish', { run: ref.run }],
      [publisher, 'migration_publish', { run: ref.run, viaRelease: true }],
    ];
    for (const [principal, tool, args] of refusals) {
      const res = await (await connect(deps, principal))(tool, args);
      expect(res.isError, `${tool} as ${principal.keyId}`).toBe(true);
      expect(res.text, `${tool} as ${principal.keyId}`).toMatch(/forbidden|scope/i);
    }
    expect(driver.calls).toEqual([]);
    // Listed for whoever holds one of the scopes the handler checks.
    expect(toolListedFor(manager, 'migration_template_approve')).toBe(true);
    expect(toolListedFor(publisher, 'migration_publish')).toBe(true);
    expect(toolListedFor(editor, 'migration_start')).toBe(false);
    expect(TOOL_SCOPES.migration_load).toContain(SCOPES.assetsWrite);
  });

  it('keep every step to its environment', async () => {
    const { ctx, deps, driver } = await setup();
    const { ref, digest } = await authored(deps);
    await createEnvironment(ctx, SPACE, 'staging');
    const call = await connect(deps, admin);
    const env = { environment: 'staging' };
    for (const [tool, args] of [
      ['migration_template_get', ref],
      ['migration_script_get', ref],
      ['migration_propose_model', { ...ref, model: MODEL }],
      ['migration_script_set', { ...ref, script: SCRIPT }],
      ['migration_script_try', ref],
      ['migration_template_approve', { ...ref, reviewed: digest }],
      ['migration_template_reopen', { ...ref, reviewed: digest }],
      ['migration_transform', ref],
      ['migration_load', ref],
      ['migration_relink', { run: ref.run }],
      ['migration_redirects', { run: ref.run }],
      ['migration_publish_entries', { run: ref.run }],
      ['migration_start', { run: ref.run }],
      ['migration_publish', { run: ref.run }],
    ] as const) {
      const res = await call(tool, { ...args, ...env });
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toMatch(/not_found|was not found/);
    }
    expect(driver.calls).toEqual([]);
  });

  it('answer not_configured without a runner or a sandbox, as the routes answer 501', async () => {
    const { deps } = await setup({ runner: false, sandbox: false });
    const { call, ref, digest } = await authored(deps);
    for (const [tool, args, as] of [
      ['migration_start', { run: ref.run }, runner],
      ['migration_publish', { run: ref.run }, publisher],
      ['migration_script_try', ref, runner],
    ] as const) {
      const res = await (await connect(deps, as))(tool, args);
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toMatch(/not_configured|not configured/);
    }
    // With no driver bound, approval still stands and says why it told none.
    const approved = await (await connect(deps, manager))('migration_template_approve', {
      ...ref,
      reviewed: digest,
    });
    expect(approved.body).toMatchObject({ signalled: false, reason: 'no-driver' });
    expect((await call('migration_template_get', ref)).body).toMatchObject({ status: 'approved' });
  });

  it('report signalled and its reason on approval, as the route does', async () => {
    const { deps, driver } = await setup();
    const { ref, digest } = await authored(deps);
    const asManager = await connect(deps, manager);
    driver.failSignals = 'broken';
    expect(
      (await asManager('migration_template_approve', { ...ref, reviewed: digest })).body,
    ).toMatchObject({ template: { status: 'approved' }, signalled: false, reason: 'unreachable' });
    driver.failSignals = 'missing';
    expect(
      (await asManager('migration_template_approve', { ...ref, reviewed: digest })).body,
    ).toMatchObject({ signalled: false, reason: 'no-driver' });
    driver.failSignals = undefined;
    driver.finished.add(ref.run);
    expect(
      (await asManager('migration_template_approve', { ...ref, reviewed: digest })).body,
    ).toMatchObject({ signalled: false, reason: 'driver-finished' });
    driver.finished.clear();
    const told = (await asManager('migration_template_approve', { ...ref, reviewed: digest }))
      .body as { signalled: boolean; reason?: string };
    expect(told.signalled).toBe(true);
    expect(told).not.toHaveProperty('reason');
  });

  it('take the approver from the caller, never from an argument', async () => {
    const { deps, driver } = await setup();
    const { call, ref } = await authored(deps);
    await call('migration_start', { run: ref.run });
    const res = await (await connect(deps, publisher))('migration_publish', {
      run: ref.run,
      approvedBy: { kind: 'deployment' },
    });
    expect(res.isError).toBe(false);
    expect(driver.calls.at(-1)?.payload).toEqual({
      approvedBy: { kind: 'key', keyId: 'key-publisher' },
      recorded: true,
    });
  });

  it('refuse a release named without viaRelease, and a finished driver', async () => {
    const { deps, driver } = await setup();
    const { call, ref } = await authored(deps);
    const asReleaser = await connect(
      deps,
      key('releaser', [SCOPES.contentPublish, SCOPES.contentWrite]),
    );
    for (const tool of ['migration_publish', 'migration_publish_entries']) {
      const res = await asReleaser(tool, { run: ref.run, releaseTitle: 'Launch' });
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toMatch(/viaRelease/);
    }
    driver.finished.add(ref.run);
    const start = await call('migration_start', { run: ref.run });
    expect(start.isError).toBe(true);
    expect(start.text).toMatch(/has finished/);
  });
});
