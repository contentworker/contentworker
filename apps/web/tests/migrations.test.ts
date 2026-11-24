import type { MigrationRun } from '@contentworker/domain';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type MigrationFetchResult, type MigrationRunView } from '~/cms/lib/management';
import {
  fetchUntilDone,
  globsFrom,
  isRetryableConflict,
  pendingPages,
  retryingConflicts,
  runSteps,
  siteUnavailableOf,
  sourceIssues,
} from '~/cms/lib/migrations';

const run = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  id: 'run-1',
  name: 'example.com',
  source: {
    kind: 'sitemap',
    url: 'https://example.com/sitemap.xml',
    include: [],
    exclude: [],
    maxPages: 500,
  },
  status: 'created',
  threshold: 0.8,
  inventory: null,
  error: null,
  releaseId: null,
  version: 1,
  createdAt: '2026-11-20T10:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-11-20T10:00:00.000Z',
  ...over,
});

const view = (
  over: Partial<MigrationRun> = {},
  pages: Partial<MigrationRunView['pages']> = {},
  templates: MigrationRunView['templates'] = [],
): MigrationRunView => ({
  run: run(over),
  pages: { total: 0, fetched: 0, failed: 0, byStage: {}, ...pages },
  templates,
});

const conflict = () =>
  new ApiError(409, 'POST … → 409', {
    error: { code: 'conflict', message: 'Another step wrote the run first', retryable: true },
  });

const batch = (over: Partial<MigrationFetchResult> = {}): MigrationFetchResult => ({
  fetched: 10,
  failed: 0,
  added: 0,
  more: true,
  ...over,
});

describe('a run’s steps', () => {
  it('waits on its inventory first, with fetching and clustering saying why they wait', () => {
    const steps = runSteps(view());
    expect(steps.next).toBe('inventory');
    expect(steps.inventory.available).toBe(true);
    expect(steps.fetch).toEqual({ available: false, reason: 'Inventory the source first.' });
    expect(steps.cluster).toEqual({ available: false, reason: 'Inventory the source first.' });
  });

  it('waits on fetching while pages are waiting, and can cluster what it has', () => {
    const steps = runSteps(view({ status: 'inventoried' }, { total: 30, fetched: 10, failed: 2 }));
    expect(steps.next).toBe('fetch');
    expect(steps.fetch.available).toBe(true);
    expect(steps.cluster.available).toBe(true);
    // A failed page keeps its error and is not tried again: it isn't waiting.
    expect(pendingPages({ total: 30, fetched: 10, failed: 2, byStage: {} })).toBe(18);
  });

  it('keeps a stopped run’s list and grouping, as the API does', () => {
    const steps = runSteps(view({ status: 'stopped' }, { total: 5, fetched: 5, failed: 0 }));
    expect(steps.inventory.available).toBe(false);
    expect(steps.cluster).toEqual({
      available: false,
      reason: 'Its background run stopped, so the grouping is kept.',
    });
  });

  it('waits on clustering once every page is read, and keeps the list once clustered', () => {
    expect(
      runSteps(view({ status: 'inventoried' }, { total: 5, fetched: 4, failed: 1 })).next,
    ).toBe('cluster');
    const clustered = runSteps(view({ status: 'clustered' }, { total: 5, fetched: 5 }));
    expect(clustered.next).toBeNull();
    expect(clustered.inventory.available).toBe(false);
    expect(clustered.fetch.reason).toBe('No pages are waiting to be fetched.');
    expect(clustered.cluster.available).toBe(true);
  });

  it('never clusters over a template being authored or approved', () => {
    const authoring = runSteps(
      view({ status: 'clustered' }, { total: 5, fetched: 5 }, [
        {
          id: 't1',
          runId: 'run-1',
          label: 'Article',
          status: 'authoring',
          pageCount: 5,
          samplePageIds: [],
          contentTypeId: null,
          script: null,
          proposal: null,
          lastTry: null,
          approvedBy: null,
          reviewDigest: 'd'.repeat(64),
          version: 1,
          createdAt: '',
          updatedAt: '',
        },
      ]),
    );
    expect(authoring.cluster.reason).toBe(
      'A template is being authored or approved, so the grouping is kept.',
    );
    // Nothing read yet: the API would cluster it into nothing, so it isn't the primary.
    const unread = runSteps(view({ status: 'inventoried' }, { total: 5, failed: 5 }));
    expect(unread.cluster.available).toBe(true);
    expect(unread.next).toBeNull();
  });

  it('neither inventories nor clusters once the run failed, as the API refuses both', () => {
    const steps = runSteps(view({ status: 'failed' }, { total: 5 }));
    expect(steps.next).toBeNull();
    expect([steps.inventory, steps.cluster].every((s) => s.reason === 'The run failed.')).toBe(
      true,
    );
    // Fetching asks nothing of the run's status: its waiting pages can still be read.
    expect(steps.fetch.available).toBe(true);
  });
});

describe('a refused source', () => {
  it('lands each issue on the field it names, a glob’s on its line', () => {
    const err = new ApiError(422, 'POST … → 422', {
      error: {
        code: 'validation_failed',
        issues: [
          {
            field: 'source.url',
            message: 'must not target a loopback, link-local, or private address',
          },
          { field: 'source.include[1]', message: 'must start with "/"' },
          { field: 'source.exclude.0', message: 'Too long' },
          { field: 'source.maxPages', message: 'must be at most 10000' },
          { field: 'threshold', message: 'must be a number from 0 to 1' },
        ],
      },
    });
    expect(sourceIssues(err)).toEqual({
      url: 'must not target a loopback, link-local, or private address',
      include: 'Line 2: must start with "/"',
      exclude: 'Line 1: Too long',
      maxPages: 'must be at most 10000',
      form: 'must be a number from 0 to 1',
    });
  });

  it('names nothing for any other failure', () => {
    expect(sourceIssues(new ApiError(500, 'boom'))).toEqual({});
    expect(sourceIssues(new TypeError('Failed to fetch'))).toEqual({});
  });

  it('reads globs one a line, blank lines dropped', () => {
    expect(globsFrom(' /blog/**\n\n/products/* \n')).toEqual(['/blog/**', '/products/*']);
  });
});

describe('errors a step can meet', () => {
  it('tells a lost race from any other conflict', () => {
    expect(isRetryableConflict(conflict())).toBe(true);
    expect(
      isRetryableConflict(
        new ApiError(409, 'x', { error: { code: 'conflict', message: 'taken' } }),
      ),
    ).toBe(false);
  });

  it('reads a site that can’t be read now from its 503', () => {
    const err = new ApiError(503, 'x', {
      error: { code: 'site_unavailable', message: 'robots.txt answered 503', retryable: true },
    });
    expect(siteUnavailableOf(err)).toBe('robots.txt answered 503');
    // The API's message leads with what the notice's title already says.
    const full = new ApiError(503, 'x', {
      error: {
        code: 'site_unavailable',
        message: 'The site can’t be read now: robots.txt answered 503',
      },
    });
    expect(siteUnavailableOf(full)).toBe('robots.txt answered 503');
    expect(siteUnavailableOf(new ApiError(503, 'x', { error: { code: 'ai_unavailable' } }))).toBe(
      undefined,
    );
  });

  it('sends a step that lost a race again, and says the loss only after three', async () => {
    const once = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce('ok');
    await expect(retryingConflicts(once)).resolves.toBe('ok');
    expect(once).toHaveBeenCalledTimes(2);

    const always = vi.fn().mockRejectedValue(conflict());
    await expect(retryingConflicts(always)).rejects.toBeInstanceOf(ApiError);
    expect(always).toHaveBeenCalledTimes(3);

    const refused = vi.fn().mockRejectedValue(new ApiError(400, 'invalid_state'));
    await expect(retryingConflicts(refused)).rejects.toBeInstanceOf(ApiError);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('fetching until done', () => {
  it('asks again while the API says more, adding up every batch', async () => {
    const step = vi
      .fn()
      .mockResolvedValueOnce(batch({ added: 3 }))
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce(batch({ failed: 1, fetched: 9 }))
      .mockResolvedValueOnce(batch({ fetched: 4, more: false }));
    const seen: number[] = [];
    const outcome = await fetchUntilDone(step, {
      signal: new AbortController().signal,
      onBatch: (_r, totals) => {
        seen.push(totals.fetched);
      },
    });
    expect(outcome).toEqual({
      kind: 'done',
      totals: { batches: 3, fetched: 23, failed: 1, added: 3 },
    });
    // The lost race was sent again, quietly: one extra call, no batch counted for it.
    expect(step).toHaveBeenCalledTimes(4);
    expect(seen).toEqual([10, 19, 23]);
  });

  it('stops when the site can’t be read, having written nothing more', async () => {
    const step = vi.fn().mockResolvedValueOnce(batch()).mockResolvedValueOnce({
      fetched: 0,
      failed: 0,
      added: 0,
      more: true,
      unavailable: 'robots.txt answered 500',
    });
    const outcome = await fetchUntilDone(step, { signal: new AbortController().signal });
    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: 'robots.txt answered 500',
      totals: { batches: 1, fetched: 10, failed: 0, added: 0 },
    });
  });

  it('stops at once when asked, the batch in flight aborted', async () => {
    const stop = new AbortController();
    const step = vi.fn((signal: AbortSignal) => {
      if (step.mock.calls.length === 1) return Promise.resolve(batch());
      // The second batch is under way when Stop is pressed: its request is aborted.
      return new Promise<MigrationFetchResult>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        stop.abort();
      });
    });
    const outcome = await fetchUntilDone(step, { signal: stop.signal });
    expect(outcome).toEqual({
      kind: 'stopped',
      totals: { batches: 1, fetched: 10, failed: 0, added: 0 },
    });
  });

  it('never asks forever when the API says more but moves nothing', async () => {
    const step = vi.fn().mockResolvedValue(batch({ fetched: 0 }));
    const outcome = await fetchUntilDone(step, { signal: new AbortController().signal });
    expect(outcome.kind).toBe('stalled');
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('lets any other failure through to be said', async () => {
    const step = vi.fn().mockRejectedValue(new ApiError(500, 'boom'));
    await expect(fetchUntilDone(step, { signal: new AbortController().signal })).rejects.toThrow(
      'boom',
    );
  });
});
