import type { Asset } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * What asset ingest writes on D1 (0011_asset_ingest): `recordIngest` touches only ingest's
 * columns and the file's measurements, only while the asset is on the run's version; `save`
 * leaves ingest's columns as ingest wrote them; the duplicate lookup by hash. Each test makes
 * its own space.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const freshScope = () => ({ spaceId: `ingest-${uid()}`, environmentId: 'main' });

const asset = (over: Partial<Asset> = {}): Asset => {
  const id = over.id ?? uid();
  return {
    id,
    status: 'draft',
    file: {
      url: `/media/s/main/${id}/f.bin`,
      fileName: 'f.bin',
      contentType: 'application/octet-stream',
    },
    title: { 'en-US': 'Original title' },
    description: {},
    metadata: { altText: {}, tags: [] },
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
};

describe('asset ingest columns on D1', () => {
  it('records findings, measurements and a sniffed type without touching editorial fields', async () => {
    const scope = freshScope();
    const a = asset();
    await store.assets.create(scope, a);
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'ready',
      contentHash: 'ab'.repeat(32),
      duplicateOf: 'orig',
      size: 2048,
      width: 640,
      height: 480,
      contentType: 'image/png',
    });
    const got = await store.assets.get(scope, a.id);
    expect(got).toMatchObject({
      ingestStatus: 'ready',
      contentHash: 'ab'.repeat(32),
      duplicateOf: 'orig',
      title: { 'en-US': 'Original title' },
      file: {
        url: a.file.url,
        fileName: 'f.bin',
        contentType: 'image/png',
        size: 2048,
        width: 640,
        height: 480,
      },
    });
    // The columns the library filters on follow the sniffed type.
    const images = await store.assets.list(scope, { filters: { kind: 'image' } });
    expect(images.items.map((x) => x.id)).toEqual([a.id]);
    // null clears; an omitted key is left.
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'error',
      error: 'boom',
      duplicateOf: null,
    });
    expect(await store.assets.get(scope, a.id)).toMatchObject({
      ingestStatus: 'error',
      ingestError: 'boom',
      contentHash: 'ab'.repeat(32),
    });
    expect((await store.assets.get(scope, a.id))?.duplicateOf).toBeUndefined();
  });

  it('drops findings for a version the asset has moved past', async () => {
    const scope = freshScope();
    const a = asset({ version: 2 });
    await store.assets.create(scope, a);
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'ready',
      contentHash: 'cd'.repeat(32),
    });
    const got = await store.assets.get(scope, a.id);
    expect(got?.ingestStatus).toBeUndefined();
    expect(got?.contentHash).toBeUndefined();
  });

  it('a save from a read taken before ingest keeps what ingest recorded', async () => {
    const scope = freshScope();
    const a = asset();
    await store.assets.create(scope, a);
    const stale = (await store.assets.get(scope, a.id)) as Asset;
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'ready',
      contentHash: 'ef'.repeat(32),
    });
    await store.assets.save(scope, {
      ...stale,
      title: { 'en-US': 'Edited' },
      aiSuggestions: { altText: ['en-US'] },
    });
    expect(await store.assets.get(scope, a.id)).toMatchObject({
      title: { 'en-US': 'Edited' },
      ingestStatus: 'ready',
      contentHash: 'ef'.repeat(32),
      aiSuggestions: { altText: ['en-US'] },
    });
  });

  it('finds assets by hash in their own scope only, oldest first', async () => {
    const scope = freshScope();
    const other = freshScope();
    const hash = '12'.repeat(32);
    const older = asset({ createdAt: '2025-01-01T00:00:00.000Z' });
    const newer = asset({ createdAt: '2026-06-01T00:00:00.000Z' });
    const elsewhere = asset();
    for (const [s, x] of [
      [scope, older],
      [scope, newer],
      [other, elsewhere],
    ] as const) {
      await store.assets.create(s, x);
      await store.assets.recordIngest(s, x.id, 1, { contentHash: hash });
    }
    await store.assets.create(scope, asset());
    const page = await store.assets.list(scope, {
      filters: { contentHash: hash, status: 'all' },
      sort: { field: 'createdAt', direction: 'asc' },
    });
    expect(page.items.map((x) => x.id)).toEqual([older.id, newer.id]);
  });
});
