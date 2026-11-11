import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  exportSnapshot,
  getBlockCatalog,
  getBlockConfig,
  getBulkJob,
  importChunkRunner,
  publishContentType,
  publishEntry,
  pushBlockCatalog,
  runBulkChunk,
  SNAPSHOT_JOB_CHUNK_SIZE,
  SYSTEM_CALLER,
  setBlockConfig,
  startEnvironmentClone,
} from '@contentworker/application';
import type { BulkChunkDueEvent } from '@contentworker/domain';
import type { Clock, IdGenerator } from '@contentworker/ports';
import { FakeBlobStore } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Environment clone as a job, on D1: the create job's chunks, then the publishing job, which the
 * last create chunk starts inside the unit of work that finalizes its job.
 */
const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };
const store = createD1Store(testDb);
const ctx: AppContext = { store, clock, ids };
const spaceId = `clone-${crypto.randomUUID().slice(0, 8)}`;
const source = { spaceId, environmentId: 'main' };
const target = { spaceId, environmentId: 'copy' };

/** Runs every pending `bulk.chunk_due`, as the engine's bulk consumer would. */
async function drain(blob: FakeBlobStore) {
  const ran = new Set<string>();
  for (let round = 0; round < 10; round++) {
    const due = (await store.outbox.readPending(1000)).filter(
      (e): e is BulkChunkDueEvent => 'type' in e && e.type === 'bulk.chunk_due' && !ran.has(e.id),
    );
    if (due.length === 0) break;
    for (const event of due) {
      ran.add(event.id);
      await runBulkChunk(ctx, event, { importChunk: importChunkRunner(ctx, blob) });
    }
  }
}

describe('cloning an environment as a job on D1', () => {
  it('creates every entry, then publishes them with links into later chunks resolved', async () => {
    await createSpace(ctx, { spaceId, name: 'Clone', defaultLocale: 'en-US', locales: ['en-US'] });
    await createEnvironment(ctx, spaceId, 'copy');
    await createContentType(ctx, SYSTEM_CALLER, source, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'next',
          name: 'Next',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, source, 'page');
    // One entry more than a chunk holds, so the chain crosses a chunk boundary. Each page is
    // created already linking to the one after it (built from the tail), which spares a second
    // write per page: the source's setup is hundreds of sequential D1 round trips, and on a busy
    // CI runner that setup, not the clone, used to eat the test's whole time budget.
    const count = SNAPSHOT_JOB_CHUNK_SIZE + 5;
    const pageIds: string[] = new Array(count);
    for (let i = count - 1; i >= 0; i--) {
      const next = pageIds[i + 1];
      const { entry } = await createEntry(ctx, source, {
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': `Page ${i}` },
          ...(next ? { next: { 'en-US': { id: next, linkType: 'Entry' } } } : {}),
        },
      });
      pageIds[i] = entry.id;
    }
    for (const id of pageIds) await publishEntry(ctx, source, id);
    expect((await exportSnapshot(ctx, SYSTEM_CALLER, source)).entries).toHaveLength(count);

    const blob = new FakeBlobStore();
    const started = await startEnvironmentClone(ctx, SYSTEM_CALLER, source, target);
    await drain(blob);

    expect(await getBulkJob(ctx, target, started.job.id)).toMatchObject({
      status: 'completed',
      succeeded: 1,
    });
    expect(await getBulkJob(ctx, target, started.createJobId)).toMatchObject({
      status: 'completed',
      succeeded: count,
    });
    expect(await getBulkJob(ctx, target, started.publishJobId)).toMatchObject({
      status: 'completed',
      succeeded: count,
      failed: 0,
    });
    const published = await store.entries.listPublished(target, { limit: 500 });
    expect(published).toHaveLength(count);
    // Every link resolved, wherever its target landed in the chunks.
    for (let i = 0; i + 1 < count; i++) {
      const page = await store.entries.getPublished(target, pageIds[i] as string);
      expect(page?.fields.next).toEqual({ 'en-US': { id: pageIds[i + 1], linkType: 'Entry' } });
    }
  });

  it('copies the block catalog and config in force, at version 1 in the copy', async () => {
    const space = `blocks-${crypto.randomUUID().slice(0, 8)}`;
    const from = { spaceId: space, environmentId: 'main' };
    const to = { spaceId: space, environmentId: 'copy' };
    await createSpace(ctx, { spaceId: space, name: 'Blocks', defaultLocale: 'en-US' });
    await createEnvironment(ctx, space, 'copy');
    const text = (apiId: string, position = 0) => ({
      apiId,
      name: apiId,
      type: 'Symbol' as const,
      localized: false,
      required: false,
      position,
    });
    await createContentType(ctx, SYSTEM_CALLER, from, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        text('title'),
        {
          ...text('body', 1),
          type: 'Array',
          items: {
            type: 'Component',
            variants: [{ apiId: 'hero', name: 'Hero', fields: [text('heading')] }],
          },
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, from, 'page');
    const blocks = [
      { id: 'hero', name: 'Hero', fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }] },
      { id: 'quote', name: 'Quote', fields: [{ apiId: 'text', name: 'Text', type: 'Symbol' }] },
    ];
    const targets = [{ contentTypeApiId: 'page', field: 'body' }];
    await pushBlockCatalog(ctx, SYSTEM_CALLER, from, { blocks, targets });
    // A second version, so the copy's restarting at 1 shows.
    const pushed = await pushBlockCatalog(ctx, SYSTEM_CALLER, from, {
      blocks: blocks.map((b) => ({ ...b, description: `The ${b.name}` })),
      targets,
    });
    const narrowing = [{ contentTypeApiId: 'page', field: 'body', blocks: ['quote'] }];
    await setBlockConfig(ctx, SYSTEM_CALLER, from, {
      expectedVersion: 0,
      targets: narrowing,
      blocks: [],
    });
    await createEntry(ctx, from, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'quote', _key: 'q1' }] } },
    });

    const started = await startEnvironmentClone(ctx, SYSTEM_CALLER, from, to);
    await drain(new FakeBlobStore());
    expect(await getBulkJob(ctx, to, started.createJobId)).toMatchObject({
      status: 'completed',
      succeeded: 1,
      failed: 0,
    });
    expect(await getBlockCatalog(ctx, to)).toMatchObject({
      version: 1,
      hash: pushed.hash,
      targets,
      pushedBy: null,
    });
    expect(await getBlockConfig(ctx, to)).toMatchObject({
      version: 1,
      targets: narrowing,
      blocks: [],
    });
    // The source keeps its own history.
    expect((await getBlockCatalog(ctx, from)).version).toBe(2);
  });
});
