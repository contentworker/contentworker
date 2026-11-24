import { takeClustering } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { ApiConfig } from '@contentworker/platform/config';
import { TransactionConflictError } from '@contentworker/ports';
import { FakeSiteSource } from '@contentworker/test-kit';
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
  `<html><head><title>${title}</title></head><body><main><article><h1>${title}</h1><div class="body"><p>${title} text.</p></div></article></main></body></html>`;
const product = (name: string) =>
  `<html><body><main><section class="hero"><h2>${name}</h2></section><table><tr><td>1</td></tr></table></main></body></html>`;
const SITE = {
  [`${O}/blog/one`]: article('One'),
  [`${O}/blog/two`]: article('Two'),
  [`${O}/shop/kettle`]: product('Kettle'),
  [`${O}/blog/gone`]: 404,
};

const M = '/spaces/s1/environments/main';
const RUNS = `${M}/migrations/runs`;
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/** Keys holding one set of scopes each, seeded beside the dev keys. */
const KEYS = {
  runner: [SCOPES.migrationRun],
  manager: [SCOPES.contentManage, SCOPES.previewRead],
  editor: [SCOPES.contentWrite, SCOPES.previewRead],
  spaceAdmin: [SCOPES.spaceAdmin],
} as const;

function makeApp(pages: Record<string, string | number> = SITE) {
  const wired = wire(config);
  const store = wired.ctx.store as unknown as {
    seedApiKey(key: Record<string, unknown>): void;
  };
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
  const source = new FakeSiteSource(pages);
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
    { siteSource: source },
  );
  const send = (method: string, path: string, body?: unknown, token = 'runner') =>
    app.request(`${RUNS}${path}`, {
      method,
      headers: headers(token),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { app, wired, source, send };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Run {
  id: string;
  status: string;
  inventory: { added: number } | null;
}

async function createRun(send: ReturnType<typeof makeApp>['send'], token = 'runner') {
  const res = await send('POST', '', { source: { kind: 'sitemap', url: `${O}/` } }, token);
  expect(res.status).toBe(201);
  return json<Run>(res);
}

describe('site migration over HTTP', () => {
  it('takes a token cap for its agents, within bounds, and reads it back with what is spent', async () => {
    const { send, wired } = makeApp();
    const source = { kind: 'sitemap', url: `${O}/` };
    for (const agentTokenCap of [1, 249_999, 15_000_001, 300_000.5, '200000']) {
      expect((await send('POST', '', { source, agentTokenCap })).status).toBe(422);
    }
    const run = await json<Run>(await send('POST', '', { source, agentTokenCap: 250_000 }));
    const scope = { spaceId: 's1', environmentId: 'main' };
    const at = wired.ctx.clock.now();
    await wired.ctx.store.migrations.reserveAgentTokens(scope, run.id, {
      templateId: 't1',
      seq: 1,
      spent: 70_000,
      tokens: 30_000,
      at: at.toISOString(),
      until: new Date(at.getTime() + 60_000).toISOString(),
    });
    const line = { templateId: 't2', seq: 1, spent: 20_000, at: at.toISOString() };
    await wired.ctx.store.migrations.capAgentTokens(scope, run.id, line);
    // Whoever may read the run, approver or runner.
    for (const token of ['runner', 'manager']) {
      const view = await json<{ agentTokens: unknown }>(
        await send('GET', `/${run.id}`, undefined, token),
      );
      expect(view.agentTokens).toEqual({
        cap: 250_000,
        spent: 90_000,
        reserved: 30_000,
        stoppedTemplateIds: ['t2'],
      });
    }
    const usual = await createRun(send);
    expect(
      (await json<{ agentTokens: { cap: number } }>(await send('GET', `/${usual.id}`))).agentTokens
        .cap,
    ).toBe(12_000_000);
  });

  it('creates a run, inventories, fetches in batches, clusters, and reads it all back', async () => {
    const { send, source } = makeApp();
    const run = await createRun(send);
    expect(run.status).toBe('created');
    // Creating fetches nothing.
    expect(source.discoveries).toHaveLength(0);

    const inventoried = await json<Run>(await send('POST', `/${run.id}/inventory`));
    expect(inventoried).toMatchObject({ status: 'inventoried', inventory: { added: 4 } });

    const batches: { fetched: number; failed: number; more: boolean }[] = [];
    for (let more = true; more; ) {
      const res = await send('POST', `/${run.id}/fetch`, { limit: 3 });
      expect(res.status).toBe(200);
      const batch = await json<{ fetched: number; failed: number; more: boolean }>(res);
      batches.push(batch);
      more = batch.more;
    }
    // Ids here are UUIDv7s minted within one millisecond, so which batch takes the 404 varies.
    expect(batches.map((b) => b.more)).toEqual([true, false]);
    expect(batches.reduce((n, b) => n + b.fetched, 0)).toBe(3);
    expect(batches.reduce((n, b) => n + b.failed, 0)).toBe(1);

    const clustered = await json<{
      run: Run;
      pages: { total: number; fetched: number; failed: number };
      templates: { id: string; pageCount: number; fingerprint?: unknown }[];
    }>(await send('POST', `/${run.id}/cluster`, {}));
    expect(clustered.run.status).toBe('clustered');
    expect(clustered.pages).toMatchObject({ total: 4, fetched: 3, failed: 1 });
    expect(clustered.templates.map((t) => t.pageCount)).toEqual([2, 1]);
    // Clustering's working data stays on the server.
    expect(clustered.templates[0]).not.toHaveProperty('fingerprint');

    const status = await json<{ run: Run; templates: unknown[] }>(await send('GET', `/${run.id}`));
    expect(status.run.status).toBe('clustered');
    expect(status.templates).toHaveLength(2);
    const templates = await json<{ items: { id: string; samplePageIds: string[] }[] }>(
      await send('GET', `/${run.id}/templates`),
    );
    expect(templates.items.map((t) => t.id)).toEqual(clustered.templates.map((t) => t.id));
    const list = await json<{ items: Run[] }>(await send('GET', ''));
    expect(list.items.map((r) => r.id)).toEqual([run.id]);
  });

  it('refuses to cluster again what the run in the background has taken on', async () => {
    const { send, wired } = makeApp();
    const run = await createRun(send);
    expect(run).toMatchObject({ clusteringHeldAt: null });
    await send('POST', `/${run.id}/inventory`);
    await send('POST', `/${run.id}/fetch`, { limit: 10 });
    // By hand, with no driver: again in place.
    expect((await send('POST', `/${run.id}/cluster`, {})).status).toBe(200);
    expect((await send('POST', `/${run.id}/cluster`, {})).status).toBe(200);
    const scope = { spaceId: 's1', environmentId: 'main' };
    const taken = await takeClustering(wired.ctx, scope, run.id);

    const refused = await send('POST', `/${run.id}/cluster`, { threshold: 0.9 });
    expect(refused.status).toBe(400);
    const { error } = await json<{ error: { code: string; message: string; retryable?: true } }>(
      refused,
    );
    expect(error).toMatchObject({
      code: 'invalid_state',
      message: expect.stringMatching(/taken on in the background/),
    });
    expect(error.retryable).not.toBe(true);
    const view = await json<{ run: { clusteringHeldAt: string }; templates: { id: string }[] }>(
      await send('GET', `/${run.id}`),
    );
    expect(view.run.clusteringHeldAt).toEqual(expect.any(String));
    expect(view.templates.map((t) => t.id)).toEqual(taken.map((t) => t.id));
  });

  it('pages through pages by stage and template, never sending HTML or storage keys', async () => {
    const { send } = makeApp();
    const run = await createRun(send);
    await send('POST', `/${run.id}/inventory`);
    await send('POST', `/${run.id}/fetch`, { limit: 10 });
    const { templates } = await json<{ templates: { id: string; pageCount: number }[] }>(
      await send('POST', `/${run.id}/cluster`, {}),
    );

    type Page = { id: string; url: string; stage: string; html: unknown; error: string | null };
    const urls: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await send('GET', `/${run.id}/pages?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      const page = await json<{ items: Page[]; nextCursor?: string }>(res);
      expect(page.items).toHaveLength(1);
      urls.push(...page.items.map((p) => p.url));
      cursor = page.nextCursor;
    } while (cursor);
    expect(urls.sort()).toEqual(Object.keys(SITE).sort());

    const fetched = await json<{ items: Page[] }>(await send('GET', `/${run.id}/pages`));
    const one = fetched.items.find((p) => p.url === `${O}/blog/one`);
    expect(one?.html).toEqual({ sha256: expect.any(String), bytes: expect.any(Number) });
    expect(one).not.toHaveProperty('fingerprint');
    expect(JSON.stringify(fetched)).not.toMatch(/<html|migrations\/s1/);

    const failed = await json<{ items: Page[] }>(
      await send('GET', `/${run.id}/pages?stage=discovered`),
    );
    expect(failed.items.map((p) => [p.url, p.error])).toEqual([[`${O}/blog/gone`, 'answered 404']]);
    const largest = templates[0] as { id: string; pageCount: number };
    const ofTemplate = await json<{ items: Page[] }>(
      await send('GET', `/${run.id}/pages?template=${largest.id}`),
    );
    expect(ofTemplate.items).toHaveLength(largest.pageCount);

    const bad = await send('GET', `/${run.id}/pages?stage=finished`);
    expect(bad.status).toBe(422);
  });

  it('fetches at most ten pages a request, however many wait', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`${O}/blog/p${i}`, article(`P${i}`)]),
    );
    const { send, source } = makeApp(many);
    const run = await createRun(send);
    await send('POST', `/${run.id}/inventory`);
    const first = await json<{ fetched: number; more: boolean }>(
      await send('POST', `/${run.id}/fetch`, {}),
    );
    expect(first).toMatchObject({ fetched: 10, more: true });
    expect(source.fetched).toHaveLength(10);
  });

  it('needs migration:run to run a step, and migration:run or content:manage to read', async () => {
    const { send } = makeApp();
    // Not an editor, not a delivery key.
    for (const token of ['editor', 'cpa', 'cda']) {
      const refused = await send('POST', '', { source: { kind: 'crawl', url: `${O}/` } }, token);
      expect(refused.status, token).toBe(403);
    }
    // A content manager follows a run but can't make it fetch.
    const run = await createRun(send);
    const manager = 'manager';
    for (const path of [`/${run.id}/inventory`, `/${run.id}/fetch`, `/${run.id}/cluster`]) {
      expect((await send('POST', path, {}, manager)).status, path).toBe(403);
    }
    for (const path of ['', `/${run.id}`, `/${run.id}/pages`, `/${run.id}/templates`]) {
      expect((await send('GET', path, undefined, manager)).status, path).toBe(200);
      expect((await send('GET', path, undefined, 'editor')).status, path).toBe(403);
    }
    const refusal = await json<{ error: { message: string } }>(
      await send('GET', `/${run.id}`, undefined, 'editor'),
    );
    expect(refusal.error.message).toMatch(/"migration:run" or "content:manage"/);
    // A space administrator holds migration:run by implication; the dev CMA key holds it outright.
    await createRun(send, 'spaceAdmin');
    await createRun(send, 'cma');
  });

  it('keeps a run to its environment and space', async () => {
    const { app, send } = makeApp();
    const run = await createRun(send);
    const created = await app.request('/spaces/s1/environments', {
      method: 'POST',
      headers: headers('admin'),
      body: JSON.stringify({ id: 'staging' }),
    });
    expect(created.status).toBeLessThan(300);
    const staging = `/spaces/s1/environments/staging/migrations/runs`;
    expect((await app.request(`${staging}/${run.id}`, { headers: headers('admin') })).status).toBe(
      404,
    );
    const listed = await json<{ items: unknown[] }>(
      await app.request(staging, { headers: headers('admin') }),
    );
    expect(listed.items).toEqual([]);
    expect(
      (
        await app.request(`${staging}/${run.id}/inventory`, {
          method: 'POST',
          headers: headers('admin'),
        })
      ).status,
    ).toBe(404);
    // A key of space s1 reads nothing of another space.
    expect(
      (
        await app.request(`/spaces/s2/environments/main/migrations/runs`, {
          headers: headers('runner'),
        })
      ).status,
    ).toBe(403);
  });

  it('maps refusals: SSRF 422, a bad source 422, a step out of order 400, an unreadable site 503', async () => {
    const { send, source } = makeApp();
    for (const url of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest',
      'http://cms.internal/',
    ]) {
      const res = await send('POST', '', { source: { kind: 'crawl', url } });
      expect(res.status, url).toBe(422);
      const body = await json<{ error: { issues: { field: string }[] } }>(res);
      expect(body.error.issues.map((i) => i.field)).toEqual(['source.url']);
    }
    const shape = await send('POST', '', { source: { kind: 'ftp', url: `${O}/` }, threshold: 2 });
    expect(shape.status).toBe(422);
    const glob = await send('POST', '', {
      source: { kind: 'crawl', url: `${O}/`, include: ['blog'] },
    });
    expect(glob.status).toBe(422);

    const run = await createRun(send);
    const early = await send('POST', `/${run.id}/cluster`, {});
    expect(early.status).toBe(400);
    expect((await json<{ error: { code: string } }>(early)).error.code).toBe('invalid_state');
    expect((await send('POST', `/${run.id}/cluster`, { threshold: 3 })).status).toBe(422);
    expect((await send('POST', `/${run.id}/fetch`, { limit: 11 })).status).toBe(422);
    expect((await send('GET', '/nope')).status).toBe(404);

    source.unavailable = 'robots.txt answered 503';
    const unavailable = await send('POST', `/${run.id}/inventory`);
    expect(unavailable.status).toBe(503);
    expect(await json(unavailable)).toEqual({
      error: {
        code: 'site_unavailable',
        message: "The site can't be read now: robots.txt answered 503",
        retryable: true,
      },
    });
    // Nothing was written: the run is where it was.
    const status = await json<{ run: Run }>(await send('GET', `/${run.id}`));
    expect(status.run.status).toBe('created');
    // A fetch while the site is unreadable says so in its answer, and writes nothing.
    source.unavailable = undefined;
    await send('POST', `/${run.id}/inventory`);
    source.unavailable = 'robots.txt answered 503';
    expect(await json(await send('POST', `/${run.id}/fetch`, {}))).toEqual({
      fetched: 0,
      failed: 0,
      added: 0,
      more: true,
      unavailable: 'robots.txt answered 503',
    });
  });

  it('answers a lost compare-and-set as a retryable 409', async () => {
    const { send, wired } = makeApp();
    const run = await createRun(send);
    const migrations = wired.ctx.store.migrations;
    const saveRun = migrations.saveRun.bind(migrations);
    migrations.saveRun = async () => {
      throw new TransactionConflictError();
    };
    const lost = await send('POST', `/${run.id}/inventory`);
    migrations.saveRun = saveRun;
    expect(lost.status).toBe(409);
    expect((await json<{ error: { code: string; retryable: boolean } }>(lost)).error).toMatchObject(
      {
        code: 'conflict',
        retryable: true,
      },
    );
    // Sent again, it goes ahead.
    expect((await send('POST', `/${run.id}/inventory`)).status).toBe(200);
  });
});
