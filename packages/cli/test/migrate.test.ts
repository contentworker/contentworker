import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/output.js';
import { harness, status, URL_ } from './harness.js';

const ENV = { CONTENTWORKER_TOKEN: 'tok', CONTENTWORKER_URL: URL_, CONTENTWORKER_SPACE: 's1' };
const R = '/spaces/s1/environments/main/migrations/runs';

const run = (status = 'created') => ({
  id: 'r1',
  name: 'old.test',
  source: { kind: 'sitemap', url: 'https://old.test/', include: [], exclude: [], maxPages: 500 },
  status,
  threshold: 0.8,
  inventory:
    status === 'created'
      ? null
      : {
          discovered: 3,
          added: 3,
          skipped: { robots: 1, filtered: 0, offOrigin: 0, overLimit: 0, invalid: 0 },
          warnings: ['robots.txt asks a 2 s crawl delay'],
        },
  error: null,
  version: 1,
  createdAt: '2026-11-01T12:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-11-01T12:00:00.000Z',
});
const view = (status = 'created') => ({
  run: run(status),
  pages: { total: 3, fetched: 2, failed: 1, byStage: { clustered: 2, discovered: 1 } },
  templates:
    status === 'clustered'
      ? [{ id: 't1', label: 'Template 1', status: 'pending', pageCount: 2, samplePageIds: [] }]
      : [],
});

describe('migrate', () => {
  it('creates a run from a sitemap, or a crawl with globs', async () => {
    const h = await harness({ [`POST ${R}`]: () => run() }, { env: ENV });
    const created = await h.run('migrate', 'create', 'https://old.test/');
    expect(created.code).toBe(EXIT.ok);
    expect(created.stdout).toMatch(/Created run r1 .* contentworker migrate step r1/);
    expect(JSON.parse(h.calls[0]?.body ?? '')).toEqual({
      source: { kind: 'sitemap', url: 'https://old.test/' },
    });

    await h.run(
      'migrate',
      'create',
      'https://old.test/blog',
      '--crawl',
      '--include',
      '/blog/**',
      '--exclude',
      '/blog/tag/*',
      '--max-pages',
      '50',
      '--threshold',
      '0.7',
    );
    expect(JSON.parse(h.calls[1]?.body ?? '')).toEqual({
      source: {
        kind: 'crawl',
        url: 'https://old.test/blog',
        include: ['/blog/**'],
        exclude: ['/blog/tag/*'],
        maxPages: 50,
      },
      threshold: 0.7,
    });
    expect((await h.run('migrate', 'create')).code).toBe(EXIT.usage);
    expect((await h.run('migrate', 'create', 'https://old.test/', '--threshold', '2')).code).toBe(
      EXIT.usage,
    );
  });

  it('steps: inventories a new run, then fetches batch after batch until none wait', async () => {
    let batches = 0;
    const h = await harness(
      {
        [`GET ${R}/r1`]: () => view(),
        [`POST ${R}/r1/inventory`]: () => run('inventoried'),
        [`POST ${R}/r1/fetch`]: () => {
          batches += 1;
          return batches < 3
            ? { fetched: 2, failed: 0, added: 1, more: true }
            : { fetched: 1, failed: 1, added: 0, more: false };
        },
      },
      { env: ENV },
    );
    const done = await h.run('migrate', 'step', 'r1', '--batch', '2', '--json');
    expect(done.code).toBe(EXIT.ok);
    expect(h.json()).toEqual({
      run: 'r1',
      inventoried: true,
      fetched: 5,
      failed: 1,
      added: 2,
      batches: 3,
      more: false,
    });
    expect(h.calls.map((c) => `${c.method} ${c.path.replace(R, '')}`)).toEqual([
      'GET /r1',
      'POST /r1/inventory',
      'POST /r1/fetch',
      'POST /r1/fetch',
      'POST /r1/fetch',
    ]);
    expect(JSON.parse(h.calls[2]?.body ?? '')).toEqual({ limit: 2 });
  });

  it('steps without inventorying again, and stops at --max-batches saying pages wait', async () => {
    const h = await harness(
      {
        [`GET ${R}/r1`]: () => view('inventoried'),
        [`POST ${R}/r1/fetch`]: () => ({ fetched: 2, failed: 0, added: 0, more: true }),
      },
      { env: ENV },
    );
    const stopped = await h.run('migrate', 'step', 'r1', '--max-batches', '2');
    expect(stopped.code).toBe(EXIT.ok);
    expect(stopped.stdout).toBe('Fetched 4, failed 0. Pages are still waiting: run this again.');
    expect(stopped.stderr).toBe('Batch 1: 2 fetched, 0 failed\nBatch 2: 2 fetched, 0 failed');
    expect(h.calls.filter((c) => c.path.endsWith('/inventory'))).toEqual([]);
  });

  it('fails (exit 1) when the site can’t be read, saying nothing was written', async () => {
    const h = await harness(
      {
        [`GET ${R}/r1`]: () => view('inventoried'),
        [`POST ${R}/r1/fetch`]: () => ({
          fetched: 0,
          failed: 0,
          added: 0,
          more: true,
          unavailable: 'robots.txt answered 503',
        }),
      },
      { env: ENV },
    );
    const failed = await h.run('migrate', 'step', 'r1');
    expect(failed.code).toBe(EXIT.failure);
    expect(failed.stderr).toMatch(/robots\.txt answered 503\); nothing was written/);

    const h2 = await harness(
      {
        [`GET ${R}/r1`]: () => view(),
        [`POST ${R}/r1/inventory`]: () =>
          status(503, {
            error: { code: 'site_unavailable', message: 'The site can’t be read now: down' },
          }),
      },
      { env: ENV },
    );
    const refused = await h2.run('migrate', 'step', 'r1', '--json');
    expect(refused.code).toBe(EXIT.failure);
    expect(JSON.parse(refused.stderr).error).toMatchObject({
      code: 'site_unavailable',
      status: 503,
    });
  });

  it('clusters, shows status with templates, and pages through pages by stage', async () => {
    const h = await harness(
      {
        [`POST ${R}/r1/cluster`]: () => view('clustered'),
        [`GET ${R}/r1`]: () => view('clustered'),
        [`GET ${R}/r1/pages`]: () => ({
          items: [
            {
              id: 'p3',
              path: '/gone',
              stage: 'discovered',
              httpStatus: 404,
              error: 'answered 404',
            },
          ],
          nextCursor: 'p3',
        }),
      },
      { env: ENV },
    );
    await h.run('migrate', 'cluster', 'r1', '--threshold', '0.5');
    expect(JSON.parse(h.calls[0]?.body ?? '')).toEqual({ threshold: 0.5 });
    const shown = await h.run('migrate', 'status', 'r1');
    expect(shown.stdout).toMatch(/status: +clustered/);
    expect(shown.stdout).toMatch(/pages: +3 \(2 fetched, 1 failed\)/);
    expect(shown.stdout).toMatch(/skipped: +robots 1/);
    expect(shown.stdout).toMatch(/warning: robots\.txt asks a 2 s crawl delay/);
    expect(shown.stdout).toMatch(/t1 +Template 1 +pending +2/);

    const pages = await h.run('migrate', 'pages', 'r1', '--stage', 'discovered', '--limit', '1');
    expect(pages.stdout).toBe(
      'ID  PATH   STAGE       HTTPSTATUS  ERROR\np3  /gone  discovered  404         answered 404\n\nNext page: --cursor p3',
    );
    expect(new URL(h.calls.at(-1)?.url ?? '').search).toBe('?stage=discovered&limit=1');
    expect((await h.run('migrate', 'pages', 'r1', '--stage', 'done')).code).toBe(EXIT.usage);
  });

  it('prints a site’s text without the control characters it carries', async () => {
    const hostile = view('inventoried');
    const h = await harness(
      {
        [`GET ${R}/r1`]: () => ({
          ...hostile,
          run: {
            ...hostile.run,
            inventory: {
              ...hostile.run.inventory,
              warnings: ['left: \u001b]8;;https://x.test\u0007evil'],
            },
          },
        }),
      },
      { env: ENV },
    );
    const shown = await h.run('migrate', 'status', 'r1');
    expect(shown.stdout).toMatch(/warning: left: \]8;;https:\/\/x\.testevil/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking none got through.
    expect(shown.stdout).not.toMatch(/[\u001b\u0007]/);
  });

  it('names the migrate commands when one is missing', async () => {
    const h = await harness({}, { env: ENV });
    const missing = await h.run('migrate');
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toMatch(/contentworker migrate step <run>/);
  });
});
