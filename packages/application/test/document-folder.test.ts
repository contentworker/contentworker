import {
  FakeAssetIngestQueue,
  FakeBlobStore,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  RecordingAssetIngestStarter,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { expect, it, vi } from 'vitest';
import {
  commitAssetFile,
  createAsset,
  createSpace,
  importDocumentInbox,
  prepareReplacement,
  queueScheduledDocuments,
  scanDocumentInbox,
} from '../src';

it('queues only uploaded documents in the scheduled folder and checkpoints each firing', async () => {
  const scope = { spaceId: 'library', environmentId: 'main' };
  const ctx = {
    clock: new FixedClock(),
    store: new InMemoryContentStore(),
    ids: new SequenceIdGenerator('schedule'),
  };
  await createSpace(ctx, { spaceId: 'library', name: 'Library', defaultLocale: 'en-US' });
  const blob = new FakeBlobStore();
  const queue = new FakeAssetIngestQueue();
  for (const fileName of ['book.pdf', 'absent.pdf', 'image.png']) {
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName,
      contentType: fileName.endsWith('pdf') ? 'application/pdf' : 'image/png',
    });
    if (fileName !== 'absent.pdf') await blob.put(asset.r2Key!, 'source', asset.file.contentType);
  }
  const rule = { ...scope, folderId: null, cron: '0 * * * *' };
  const minute = Date.parse('2026-01-01T12:00:00Z');
  expect(await queueScheduledDocuments(ctx, blob, queue, rule, minute - 60000)).toBe(0);
  expect(await queueScheduledDocuments(ctx, blob, queue, rule, minute)).toBe(1);
  expect(await queueScheduledDocuments(ctx, blob, queue, rule, minute)).toBe(0);
  expect(queue.requested).toHaveLength(1);
});

it('imports an inbox object once, keeps its own immutable DAM bytes, and picks up replacements', async () => {
  const scope = { spaceId: 'inbox', environmentId: 'main' };
  const clock = new FixedClock();
  const ctx = { clock, store: new InMemoryContentStore(), ids: new SequenceIdGenerator('inbox') };
  await createSpace(ctx, { spaceId: 'inbox', name: 'Inbox', defaultLocale: 'en-US' });
  const blob = new FakeBlobStore();
  const starter = new RecordingAssetIngestStarter();
  const queue = new FakeAssetIngestQueue();
  const key = 'imports/document-inbox/inbox/main/deck.pptx';
  await blob.put(key, 'first', 'application/octet-stream');
  await scanDocumentInbox(ctx, blob, starter, scope, null);
  await scanDocumentInbox(ctx, blob, starter, scope, null);
  expect(starter.started).toHaveLength(1);
  const params = starter.started[0]!.params;
  const steps = new FakeWorkflowSteps(clock);
  await steps.run(() => importDocumentInbox(steps, ctx, blob, queue, params));
  const imported = await ctx.store.assets.get(scope, params.assetId);
  expect(imported).toMatchObject({ status: 'draft', file: { fileName: 'deck.pptx', size: 5 } });
  expect(queue.created).toHaveLength(1);
  await blob.put(key, 'replacement', 'application/octet-stream');
  expect(await blob.get(imported!.r2Key!)).toBe('first');
  await scanDocumentInbox(ctx, blob, starter, scope, null);
  expect(starter.started[1]?.params.assetId).not.toBe(params.assetId);
});

it.each([false, true])(
  'recovers a failed handoff without a second copy (file replaced: %s)',
  async (replaced) => {
    const scope = { spaceId: 'inbox', environmentId: 'main' };
    const clock = new FixedClock();
    const ctx = { clock, store: new InMemoryContentStore(), ids: new SequenceIdGenerator('retry') };
    await createSpace(ctx, { spaceId: 'inbox', name: 'Inbox', defaultLocale: 'en-US' });
    const blob = new FakeBlobStore();
    const runs = new RecordingAssetIngestStarter();
    const failed = new Set<string>();
    const starter = {
      start: runs.start.bind(runs),
      hasFailed: async (id: string) => failed.has(id),
    };
    const scan = () => scanDocumentInbox(ctx, blob, starter, scope, null);
    const queue = new FakeAssetIngestQueue();
    const send = vi.spyOn(queue, 'objectCreated').mockRejectedValue(new Error('Queue unavailable'));
    const open = vi.spyOn(blob.multipart, 'create');
    await blob.put('imports/document-inbox/inbox/main/brief.pdf', 'source', 'application/pdf');
    await scan();
    const first = runs.started[0]!;
    const steps = new FakeWorkflowSteps(clock);
    expect(
      (await steps.run(() => importDocumentInbox(steps, ctx, blob, queue, first.params))).status,
    ).toBe('errored');
    failed.add(first.instanceId);
    send.mockRestore();
    if (replaced) {
      const { key, commit } = await prepareReplacement(ctx, scope, first.params.assetId, {
        fileName: 'edited.pdf',
        contentType: 'application/pdf',
      });
      await blob.put(key, 'new bytes', commit.contentType);
      await commitAssetFile(ctx, blob, scope, first.params.assetId, commit);
    }
    await Promise.all([scan(), scan()]);
    expect(runs.started).toHaveLength(2);
    const second = runs.started[1]!;
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(second.params).toEqual(first.params);
    // Once the draft exists, a new creation hook cannot redirect or veto its recovery.
    const recovering = {
      ...ctx,
      hooks: { dispatch: vi.fn().mockRejectedValue(new Error('New hook')) },
    };
    const retry = new FakeWorkflowSteps(clock);
    expect(
      (await retry.run(() => importDocumentInbox(retry, recovering, blob, queue, second.params)))
        .status,
    ).toBe('complete');
    await scan();
    expect(runs.started).toHaveLength(2);
    expect(recovering.hooks.dispatch).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(queue.created).toHaveLength(replaced ? 0 : 1);
    expect((await ctx.store.assets.list(scope, {})).items).toHaveLength(1);
  },
);

it('copies a logical 1 TB inbox object in contiguous ranges under the Workflow step budget', async () => {
  const size = 1_000_000_000_000;
  const scope = { spaceId: 'large', environmentId: 'main' };
  const clock = new FixedClock();
  const ctx = { clock, store: new InMemoryContentStore(), ids: new SequenceIdGenerator('large') };
  await createSpace(ctx, { spaceId: 'large', name: 'Large', defaultLocale: 'en-US' });
  const blob = new FakeBlobStore();
  let position = 0,
    partCount = 0,
    completed = false;
  blob.multipart.copyPart = async (_source, etag, offset, length, _key, _upload, n) => {
    expect(etag).toBe('pinned');
    expect(offset).toBe(position);
    expect(length).toBeLessThanOrEqual(256 * 1024 * 1024);
    position += length;
    partCount++;
    return { partNumber: n, etag: String(n) };
  };
  blob.multipart.complete = async (_key, _upload, parts) => {
    expect(parts).toHaveLength(partCount);
    completed = true;
    return { size, etag: 'original' };
  };
  blob.head = async () => (completed ? { size, etag: 'original' } : null);
  const steps = new FakeWorkflowSteps(clock);
  const queue = new FakeAssetIngestQueue();
  const key = 'imports/document-inbox/large/main/large.pdf';
  const result = await steps.run(() =>
    importDocumentInbox(steps, ctx, blob, queue, {
      scope,
      assetId: 'large-file',
      version: 1,
      inbox: { key, etag: 'pinned', size, folderId: null },
    }),
  );
  expect(result.status).toBe('complete');
  expect(position).toBe(size);
  expect(Math.ceil(partCount / 8) + 2).toBeLessThan(500);
  expect(queue.created).toHaveLength(1);
});
