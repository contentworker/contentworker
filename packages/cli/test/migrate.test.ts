import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const T = `${R}/r1/templates/t1`;
const DIGEST = 'a'.repeat(64);
const template = (status = 'authoring') => ({
  id: 't1',
  runId: 'r1',
  label: 'Template 1',
  status,
  pageCount: 2,
  samplePageIds: ['p1'],
  contentTypeId: status === 'approved' ? 'article' : null,
  script: { sha256: 'b'.repeat(64), bytes: 120 },
  proposal: { apiId: 'article', name: 'Article', displayField: 'title', fields: [{}, {}] },
  lastTry: {
    at: '2026-11-01T12:00:00.000Z',
    scriptSha256: 'b'.repeat(64),
    pages: 2,
    ok: 2,
    passed: 1,
    meanScore: 0.85,
    problems: ['https://old.test/b: lost 1 link'],
  },
  approvedBy: null,
  reviewDigest: DIGEST,
  version: 3,
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-01T12:00:00.000Z',
});

describe('migrate, authoring and publishing', () => {
  it('shows a template with its review digest', async () => {
    const h = await harness({ [`GET ${T}`]: () => template() }, { env: ENV });
    const shown = await h.run('migrate', 'template', 'r1', 't1');
    expect(shown.code).toBe(EXIT.ok);
    expect(shown.stdout).toMatch(/model:\s+article \(2 fields\)/);
    expect(shown.stdout).toMatch(/lastTry:\s+2\/2 ok, 1 passed, mean 0\.85/);
    expect(shown.stdout).toContain(DIGEST);
    expect(shown.stdout).toMatch(/problem: https:\/\/old\.test\/b: lost 1 link/);
  });

  it('stores a script from a file, and tries one without storing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-script-'));
    const file = join(dir, 'import.js');
    await writeFile(
      file,
      'export default () => ({ fields: {}, blocks: [], assets: [], links: [] });',
    );
    const h = await harness(
      {
        [`PUT ${T}/script`]: () => template(),
        [`POST ${T}/try`]: () => ({
          summary: { pages: 1, ok: 0, passed: 0, meanScore: 0, problems: [] },
          results: [
            {
              pageId: 'p1',
              url: 'https://old.test/a',
              ok: false,
              issues: [],
              error: 'threw: x',
              logs: [],
            },
          ],
        }),
      },
      { env: ENV },
    );
    const set = await h.run('migrate', 'script', 'set', 'r1', 't1', file);
    expect(set.code).toBe(EXIT.ok);
    expect(JSON.parse(h.calls[0]?.body ?? '')).toEqual({
      script: 'export default () => ({ fields: {}, blocks: [], assets: [], links: [] });',
    });
    expect(set.stdout).toMatch(/Next: contentworker migrate script try r1 t1/);

    const tried = await h.run(
      'migrate',
      'script',
      'try',
      'r1',
      't1',
      '--file',
      file,
      '--page',
      'p1',
    );
    expect(tried.code).toBe(EXIT.ok);
    expect(JSON.parse(h.calls[1]?.body ?? '')).toMatchObject({ pageIds: ['p1'] });
    expect(tried.stdout).toMatch(/Tried 1: 0 ok/);
    expect(tried.stdout).toMatch(/threw: x/);
    const many = await h.run(
      'migrate',
      'script',
      'try',
      'r1',
      't1',
      ...['1', '2', '3', '4', '5', '6'].flatMap((p) => ['--page', p]),
    );
    expect(many.code).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(2);
  });

  it('refuses a script over 256 KiB before sending it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-script-'));
    const file = join(dir, 'big.js');
    await writeFile(file, 'x'.repeat(256 * 1024 + 1));
    const h = await harness({}, { env: ENV });
    const res = await h.run('migrate', 'script', 'set', 'r1', 't1', file);
    expect(res.code).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
  });

  it('approves with the digest given, or the one read now once confirmed', async () => {
    const approved = () => ({ template: template('approved'), signalled: true });
    const h = await harness(
      { [`GET ${T}`]: () => template(), [`POST ${T}/approve`]: approved },
      { env: ENV },
    );
    const given = await h.run('migrate', 'approve', 'r1', 't1', '--reviewed', DIGEST);
    expect(given.code).toBe(EXIT.ok);
    expect(given.stdout).toMatch(/Approved Template 1 as article\. The run’s driver goes on/);
    expect(JSON.parse(h.calls[0]?.body ?? '')).toEqual({ reviewed: DIGEST });

    // Off a terminal, nothing can be confirmed: nothing is approved.
    const unconfirmed = await h.run('migrate', 'approve', 'r1', 't1');
    expect(unconfirmed.code).toBe(EXIT.usage);
    expect(h.calls.map((c) => c.method)).toEqual(['POST', 'GET']);

    const asked = await harness(
      { [`GET ${T}`]: () => template(), [`POST ${T}/approve`]: approved },
      { env: ENV, interactive: true, answers: ['y'] },
    );
    expect((await asked.run('migrate', 'approve', 'r1', 't1')).code).toBe(EXIT.ok);
    expect(JSON.parse(asked.calls[1]?.body ?? '')).toEqual({ reviewed: DIGEST });
  });

  it('reopens with the digest given, or the one read now once confirmed', async () => {
    const routes = {
      [`GET ${T}`]: () => template('approved'),
      [`POST ${T}/reopen`]: () => template(),
    };
    const h = await harness(routes, { env: ENV });
    const given = await h.run('migrate', 'reopen', 'r1', 't1', '--reviewed', DIGEST);
    expect(given.code).toBe(EXIT.ok);
    expect(given.stdout).toMatch(/Reopened Template 1\. .*migrate approve r1 t1/);
    expect(JSON.parse(h.calls[0]?.body ?? '')).toEqual({ reviewed: DIGEST });

    // Off a terminal, nothing can be confirmed: nothing is reopened.
    expect((await h.run('migrate', 'reopen', 'r1', 't1')).code).toBe(EXIT.usage);
    expect(h.calls.map((c) => c.method)).toEqual(['POST', 'GET']);

    const asked = await harness(routes, { env: ENV, interactive: true, answers: ['y'] });
    expect((await asked.run('migrate', 'reopen', 'r1', 't1')).code).toBe(EXIT.ok);
    expect(JSON.parse(asked.calls[1]?.body ?? '')).toEqual({ reviewed: DIGEST });
    const declined = await harness(routes, { env: ENV, interactive: true, answers: ['n'] });
    await declined.run('migrate', 'reopen', 'r1', 't1');
    expect(declined.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('surfaces a stale review as the api’s conflict', async () => {
    const h = await harness(
      {
        [`POST ${T}/approve`]: () =>
          status(409, {
            error: { code: 'conflict', message: 'The template’s model or script changed' },
          }),
      },
      { env: ENV },
    );
    const res = await h.run('migrate', 'approve', 'r1', 't1', '--reviewed', DIGEST);
    expect(res.code).toBe(EXIT.failure);
    expect(res.stderr).toMatch(/changed/);
  });

  it('starts a run, and says when it was running', async () => {
    let started = true;
    const h = await harness(
      {
        [`POST ${R}/r1/start`]: () => ({
          started: (() => {
            const s = started;
            started = false;
            return s;
          })(),
        }),
      },
      { env: ENV },
    );
    expect((await h.run('migrate', 'start', 'r1')).stdout).toMatch(/Started run r1/);
    expect((await h.run('migrate', 'start', 'r1')).stdout).toMatch(/running already/);
  });

  it('sends the go-ahead, or publishes batch by batch with --now', async () => {
    let page = 0;
    const h = await harness(
      {
        [`POST ${R}/r1/publish-approval`]: () => ({ accepted: true }),
        [`POST ${R}/r1/publish`]: () =>
          ++page === 1
            ? { published: 50, added: 0, failed: [], next: 'p50' }
            : {
                published: 3,
                added: 0,
                failed: [{ pageId: 'p9', url: 'https://old.test/x', error: 'no' }],
              },
      },
      { env: ENV },
    );
    const ahead = await h.run(
      'migrate',
      'publish',
      'r1',
      '--via-release',
      '--release-title',
      'Launch',
    );
    expect(ahead.code).toBe(EXIT.ok);
    expect(JSON.parse(h.calls[0]?.body ?? '')).toEqual({
      viaRelease: true,
      releaseTitle: 'Launch',
    });

    const now = await h.run('migrate', 'publish', 'r1', '--now');
    expect(now.code).toBe(EXIT.failure);
    expect(now.stdout).toMatch(/Published 53, 1 failed/);
    expect(JSON.parse(h.calls[2]?.body ?? '')).toEqual({ after: 'p50' });

    const bad = await h.run('migrate', 'publish', 'r1', '--release', 'rel1');
    expect(bad.code).toBe(EXIT.usage);
  });

  it('cleans the site’s text from the review and the failures it prints', async () => {
    const hostile = {
      ...template(),
      lastTry: { ...template().lastTry, problems: ['x: \u001b]8;;https://x.test\u0007ok'] },
    };
    const h = await harness(
      {
        [`GET ${T}`]: () => hostile,
        [`POST ${T}/approve`]: () => ({ template: template('approved'), signalled: false }),
        [`POST ${R}/r1/publish`]: () => ({
          published: 0,
          added: 0,
          failed: [{ pageId: 'p1', url: 'https://old.test/a', error: '\u001b[2Jgone' }],
        }),
      },
      { env: ENV, interactive: true, answers: ['y'] },
    );
    const approved = await h.run('migrate', 'approve', 'r1', 't1');
    expect(approved.code).toBe(EXIT.ok);
    expect(approved.stderr).toMatch(/problem: x: \]8;;https:\/\/x\.testok/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking none got through.
    expect(approved.stderr).not.toMatch(/[\u001b\u0007]/);
    const published = await h.run('migrate', 'publish', 'r1', '--now');
    expect(published.stderr).toMatch(/failed: https:\/\/old\.test\/a: \[2Jgone/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking none got through.
    expect(published.stderr).not.toMatch(/[\u001b\u0007]/);
  });
});
