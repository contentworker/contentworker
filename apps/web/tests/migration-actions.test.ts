import type { ContentTypeDraft } from '@contentworker/domain';
import { checkTemplateModel, MigrationDriverFinishedError } from '@contentworker/domain';
import { describe, expect, it, vi } from 'vitest';
import { MODEL_SCAFFOLD } from '~/cms/components/migrations/TemplateModel';
import { ApiError } from '~/cms/lib/management';
import {
  addFailures,
  approvalLine,
  batchUntilDone,
  driverRefusal,
  FAILURES_KEPT,
  fetchFailures,
  lockedReason,
  migrationRights,
  NO_FAILURES,
  pendingPages,
  worthRetrying,
} from '~/cms/lib/migrations';

const conflict = (retryable = true) =>
  new ApiError(409, 'POST … → 409', { error: { code: 'conflict', message: 'x', retryable } });
const refusal = (status: number, code: string, message: string) =>
  new ApiError(status, `POST … → ${status}`, { error: { code, message } });

describe('what a role may do with a run, as the API checks it', () => {
  it('is unknown until the role is', () => expect(migrationRights(undefined)).toBeUndefined());

  it('runs with migration:run, and loads only with both content scopes too', () => {
    expect(migrationRights(['migration:run'])).toEqual({
      run: true,
      manage: false,
      load: false,
      relink: false,
      publish: false,
      publishViaRelease: false,
    });
    const writer = migrationRights(['migration:run', 'content:write']);
    // assets:write comes with content:write (IMPLIED_SCOPES).
    expect(writer).toMatchObject({ load: true, relink: true, publish: false });
    expect(migrationRights(['content:write'])).toMatchObject({ load: false, relink: false });
  });

  it('approves and redirects with content:manage, and publishes with content:publish', () => {
    expect(migrationRights(['content:manage'])).toMatchObject({ run: false, manage: true });
    expect(migrationRights(['content:publish'])).toMatchObject({
      publish: true,
      publishViaRelease: false,
    });
    expect(migrationRights(['content:publish', 'content:write'])?.publishViaRelease).toBe(true);
  });
});

describe('batch after batch', () => {
  const opts = (signal = new AbortController().signal) => ({
    signal,
    start: 0,
    add: (n: number, r: { n: number; next?: string }) => n + r.n,
    next: (r: { n: number; next?: string }) => ({ more: !!r.next, after: r.next }),
  });

  it('goes on from each answer’s cursor until there is none', async () => {
    const batch = vi
      .fn()
      .mockResolvedValueOnce({ n: 10, next: 'a' })
      .mockResolvedValueOnce({ n: 10, next: 'b' })
      .mockResolvedValueOnce({ n: 3 });
    const out = await batchUntilDone(batch, opts());
    expect(out).toEqual({ kind: 'done', batches: 3, totals: 23 });
    expect(batch.mock.calls.map((c) => c[0])).toEqual([undefined, 'a', 'b']);
  });

  it('sends a lost race again at the same cursor, and gives up after three', async () => {
    const batch = vi
      .fn()
      .mockResolvedValueOnce({ n: 1, next: 'a' })
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ n: 1 });
    expect(await batchUntilDone(batch, opts())).toMatchObject({ kind: 'done', totals: 2 });
    expect(batch.mock.calls.map((c) => c[0])).toEqual([undefined, 'a', 'a']);

    const lost = vi.fn().mockRejectedValue(conflict());
    expect(await batchUntilDone(lost, opts())).toMatchObject({ kind: 'failed', totals: 0 });
    expect(lost).toHaveBeenCalledTimes(3);
  });

  it('never resends a refusal, and keeps what the batches before it did', async () => {
    const no = refusal(400, 'invalid_state', 'no');
    const batch = vi.fn().mockResolvedValueOnce({ n: 10, next: 'a' }).mockRejectedValueOnce(no);
    expect(await batchUntilDone(batch, opts())).toEqual({
      kind: 'failed',
      batches: 1,
      totals: 10,
      error: no,
    });
  });

  it('stops when asked, the batch in flight included', async () => {
    const ctl = new AbortController();
    const out = batchUntilDone(
      (_after, signal) =>
        new Promise<{ n: number }>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        }),
      opts(ctl.signal),
    );
    ctl.abort();
    expect(await out).toEqual({ kind: 'stopped', batches: 0, totals: 0 });
  });

  it('stops rather than ask forever: a cursor that stands still, a batch that moved nothing', async () => {
    const same = vi.fn().mockResolvedValue({ n: 0, next: 'a' });
    expect(await batchUntilDone(same, opts())).toMatchObject({ kind: 'stalled', batches: 2 });
    const none = vi.fn().mockResolvedValue({ n: 0 });
    expect(
      await batchUntilDone(none, { ...opts(), next: () => ({ more: true, stalled: true }) }),
    ).toMatchObject({ kind: 'stalled', batches: 1 });
  });
});

describe('what the screens say', () => {
  it('counts a fetch failure only where the page has no HTML', () => {
    const counts = { total: 10, fetched: 10, failed: 3, byStage: { 'needs-fix': 3 } } as const;
    expect(fetchFailures(counts)).toBe(0);
    expect(pendingPages(counts)).toBe(0);
    expect(
      pendingPages({
        total: 10,
        fetched: 4,
        failed: 5,
        byStage: { discovered: 6, 'needs-fix': 4 },
      }),
    ).toBe(1);
  });

  it('keeps the first failures and counts the rest', () => {
    const f = { pageId: 'p', url: 'https://x.test/', error: 'no' };
    const kept = addFailures(NO_FAILURES, Array(FAILURES_KEPT + 5).fill(f));
    expect(kept.items).toHaveLength(FAILURES_KEPT);
    expect(kept.total).toBe(FAILURES_KEPT + 5);
  });

  it('says why a template is locked', () => {
    expect(lockedReason({ status: 'approved' }, undefined)).toMatch(/is approved/);
    expect(lockedReason({ status: 'approving' }, undefined)).toMatch(/being approved/);
    expect(lockedReason({ status: 'authoring' }, undefined)).toBeUndefined();
  });

  it('says in plain words what an approval told the driver', () => {
    const t = {} as never;
    expect(approvalLine({ template: t, signalled: true })).toMatch(/was told/);
    expect(approvalLine({ template: t, signalled: false, reason: 'no-driver' })).toMatch(
      /Nothing is running/,
    );
    expect(approvalLine({ template: t, signalled: false, reason: 'driver-finished' })).toMatch(
      /already finished/,
    );
    expect(approvalLine({ template: t, signalled: false, reason: 'unreachable' })).toMatch(
      /couldn’t be reached/,
    );
  });

  it('says why a driver didn’t take a start or a go-ahead, and leaves the rest to the API', () => {
    expect(driverRefusal(refusal(501, 'not_configured', 'x'))).toMatch(/isn’t set up/);
    expect(driverRefusal(refusal(404, 'not_found', 'x'))).toMatch(/Nothing is running/);
    expect(
      driverRefusal(refusal(400, 'invalid_state', new MigrationDriverFinishedError('r').message)),
    ).toMatch(/already finished/);
    expect(
      driverRefusal(refusal(400, 'invalid_state', 'The run has stopped (no go-ahead): …')),
    ).toMatch(/stopped/);
    expect(driverRefusal(refusal(400, 'invalid_state', 'Cannot add'))).toBeUndefined();
    expect(worthRetrying(refusal(501, 'not_configured', 'x'))).toBe(false);
    expect(worthRetrying(refusal(503, 'site_unavailable', 'x'))).toBe(true);
  });

  it('starts a new model from one the API’s own check takes', () => {
    expect(() => checkTemplateModel(MODEL_SCAFFOLD as unknown as ContentTypeDraft)).not.toThrow();
  });
});
