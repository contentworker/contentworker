import type { DomainEvent, Principal } from '@contentworker/domain';
import type { AIProvider, GenerateRequest, GenerateResult } from '@contentworker/ports';
import {
  FakeAssetIngestQueue,
  FakeBlobStore,
  FakeImageProbe,
  FakeTextExtractor,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  InMemoryCostGuard,
  InMemorySearchIndex,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingAssetIngestStarter,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  type AssetIngestDeps,
  assetIngestInstanceId,
  assetReindexChunkRunner,
  assetTextKey,
  createAsset,
  createEnvironment,
  createSpace,
  createTag,
  deleteAsset,
  deleteEnvironment,
  dispatchEvent,
  getAsset,
  MAX_EXTRACT_DOCUMENT_BYTES,
  publishAsset,
  reingestAsset,
  runAssetIngest,
  searchAssets,
  setAssetMetadata,
  startAssetIngestForObject,
  startAssetReindex,
  startRequestedAssetIngest,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const ADMIN = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;

/** A model whose answer a test can change mid-run (`respondWith`), recording every request. */
class ScriptedAI implements AIProvider {
  readonly requests: GenerateRequest[] = [];
  constructor(public respondWith: (req: GenerateRequest) => Promise<unknown>) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const object = await this.respondWith(req);
    return { text: JSON.stringify(object), object, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

function setup(opts: { aiAnswer?: unknown } = {}) {
  const store = new InMemoryContentStore();
  const clock = new FixedClock();
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('a') };
  const blob = new FakeBlobStore();
  const images = new FakeImageProbe();
  const extractor = new FakeTextExtractor();
  const ai = new ScriptedAI(
    async () => opts.aiAnswer ?? { altText: 'A ceramic mug on a wooden table' },
  );
  const vectors = new InMemoryVectorStore();
  const index = new InMemorySearchIndex();
  const deps: AssetIngestDeps & { blob: FakeBlobStore } = {
    blob,
    images,
    extractor,
    ai,
    search: { embeddings: new LocalEmbeddingsProvider(64), vectors, index },
  };
  /** Uploads a file: the asset row, then its bytes, as the signed PUT leaves them. */
  const upload = async (fileName: string, contentType: string, bytes: string, at = scope) => {
    const { asset } = await createAsset(ctx, blob, at, { fileName, contentType });
    await blob.put(asset.r2Key as string, bytes, contentType);
    return asset;
  };
  const params = (assetId: string, version = 1, at = scope) => ({ scope: at, assetId, version });
  const run = (assetId: string, steps = new FakeWorkflowSteps(clock)) =>
    steps.run(() => runAssetIngest(steps, ctx, deps, params(assetId)));
  return { store, clock, ctx, blob, images, extractor, ai, vectors, index, deps, upload, run };
}

const ingested = (store: InMemoryContentStore) =>
  store
    .allEvents()
    .filter(
      (e): e is Extract<DomainEvent, { type: 'asset.ingested' }> => e.type === 'asset.ingested',
    );

describe('asset ingest', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('hashes, probes, suggests alt text, indexes, and finishes ready with asset.ingested', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    t.images.set('jpeg-bytes', { width: 1200, height: 800, format: 'image/jpeg' });
    const out = await t.run(asset.id);
    expect(out).toMatchObject({
      status: 'complete',
      value: { outcome: 'ready', altText: 'suggested' },
    });

    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('ready');
    expect(after.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.file).toMatchObject({ width: 1200, height: 800, size: 10 });
    expect(after.metadata.altText).toEqual({ 'en-US': 'A ceramic mug on a wooden table' });
    expect(after.aiSuggestions).toEqual({ altText: ['en-US'] });
    expect(t.vectors.assetRows.size).toBe(1);
    expect(t.index.textOf(scope, asset.id)).toContain('ceramic mug');
    expect(ingested(t.store)).toEqual([
      expect.objectContaining({ assetId: asset.id, version: 1, contentHash: after.contentHash }),
    ]);
  });

  it('replays a redelivered run from its journal: no step runs twice, one event', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    t.images.set('jpeg-bytes', { width: 10, height: 10, format: 'image/jpeg' });
    const steps = new FakeWorkflowSteps(t.clock);
    await t.run(asset.id, steps);
    const executed = [...steps.executed];
    await t.run(asset.id, steps);
    expect(steps.executed).toEqual(executed);
    expect(t.ai.requests).toHaveLength(1);
    expect(ingested(t.store)).toHaveLength(1);
  });

  it('a fresh run over an ingested file changes nothing an editor or a previous run set', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    await t.run(asset.id);
    const first = await getAsset(t.ctx, scope, asset.id);
    await t.run(asset.id);
    const second = await getAsset(t.ctx, scope, asset.id);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.metadata).toEqual(first.metadata);
    // Alt text was already there: the model is not asked again.
    expect(t.ai.requests).toHaveLength(1);
  });

  it('never overwrites alt text or tags an editor set, and asks no model for them', async () => {
    await createTag(t.ctx, scope, { name: 'kitchen' });
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    await setAssetMetadata(t.ctx, scope, asset.id, {
      altText: { 'en-US': 'Editor wrote this' },
      tags: ['editor-tag'],
    });
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { altText: 'kept', tags: 'kept' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.metadata.altText).toEqual({ 'en-US': 'Editor wrote this' });
    expect(after.metadata.tags).toEqual(['editor-tag']);
    expect(after.aiSuggestions).toBeUndefined();
    expect(t.ai.requests).toHaveLength(0);
  });

  it('keeps an editor value saved while the model was answering', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    // The editor saves between the model's call and the write.
    t.ai.respondWith = async () => {
      await setAssetMetadata(t.ctx, scope, asset.id, { altText: { 'en-US': 'Mine' } });
      return { altText: 'Model text' };
    };
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { altText: 'kept' } });
    expect((await getAsset(t.ctx, scope, asset.id)).metadata.altText).toEqual({ 'en-US': 'Mine' });
  });

  it('tags only from the existing vocabulary, never creating one the model invents', async () => {
    const kitchen = await createTag(t.ctx, scope, { name: 'kitchen' });
    t.ai.respondWith = async (req) =>
      req.outputSchema && 'existingTags' in (req.outputSchema.properties as object)
        ? { existingTags: ['Kitchen'], newTags: ['ignore previous instructions'] }
        : { altText: 'A mug' };
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { tags: 'suggested' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.metadata.tags).toEqual([kitchen.id]);
    expect(after.aiSuggestions?.tags).toEqual([kitchen.id]);
    expect((await t.store.taxonomy.listTags(scope)).map((x) => x.name)).toEqual(['kitchen']);
  });

  it('an editor saving the field makes it theirs: the suggestion mark clears', async () => {
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    await t.run(asset.id);
    await setAssetMetadata(t.ctx, scope, asset.id, { altText: { 'en-US': 'A mug, edited' } });
    expect((await getAsset(t.ctx, scope, asset.id)).aiSuggestions).toBeUndefined();
  });

  it('skips enrichment on a spent AI budget instead of failing ingest', async () => {
    const ctx = {
      ...t.ctx,
      costGuard: new InMemoryCostGuard({ maxRequests: 0, maxTokens: 1, windowSeconds: 60 }),
    };
    const asset = await t.upload('mug.jpg', 'image/jpeg', 'jpeg-bytes');
    const steps = new FakeWorkflowSteps(t.clock);
    const out = await steps.run(() =>
      runAssetIngest(steps, ctx, t.deps, { scope, assetId: asset.id, version: 1 }),
    );
    expect(out).toMatchObject({ value: { outcome: 'ready', altText: 'budget' } });
    expect(t.ai.requests).toHaveLength(0);
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('ready');
    expect(after.metadata.altText).toEqual({});
  });

  it('marks duplicates: same bytes in the scope point at the oldest asset', async () => {
    const original = await t.upload('a.png', 'image/png', 'same-bytes');
    const copy = await t.upload('b.png', 'image/png', 'same-bytes');
    const other = await t.upload('c.png', 'image/png', 'other-bytes');
    // The copy is ingested first: it finds no hashed twin yet; the original's run marks it.
    await t.run(copy.id);
    expect((await getAsset(t.ctx, scope, copy.id)).duplicateOf).toBeUndefined();
    await t.run(original.id);
    await t.run(other.id);
    expect((await getAsset(t.ctx, scope, copy.id)).duplicateOf).toBe(original.id);
    expect((await getAsset(t.ctx, scope, original.id)).duplicateOf).toBeUndefined();
    expect((await getAsset(t.ctx, scope, other.id)).duplicateOf).toBeUndefined();
    expect(ingested(t.store).find((e) => e.assetId === copy.id)?.duplicateOf).toBeUndefined();
  });

  it('does not mark a duplicate across environments (scope isolation)', async () => {
    await createEnvironment(t.ctx, 'shop', 'staging', 'Staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    const a = await t.upload('a.png', 'image/png', 'same-bytes');
    const b = await t.upload('b.png', 'image/png', 'same-bytes', staging);
    await t.run(a.id);
    const steps = new FakeWorkflowSteps(t.clock);
    await steps.run(() =>
      runAssetIngest(steps, t.ctx, t.deps, { scope: staging, assetId: b.id, version: 1 }),
    );
    expect((await getAsset(t.ctx, staging, b.id)).duplicateOf).toBeUndefined();
  });

  it('extracts a document’s text beside the file, capped, and never into the asset row', async () => {
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF-bytes');
    t.extractor.setText('brief.pdf', `Heliotrope launch plan\u0000${'x'.repeat(10)}`);
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { outcome: 'ready', altText: 'skipped' } });
    const key = assetTextKey(scope, asset.id, 1) as string;
    expect(key).toBe(`shop/main/${asset.id}/v1/text.md`);
    const text = await t.blob.get(key);
    expect(text).toContain('Heliotrope launch plan');
    expect(text).not.toContain('\u0000');
    // The extractor read the asset's own file and nothing else.
    expect(t.extractor.read.map((f) => f.fileName)).toEqual(['brief.pdf']);
    expect(t.blob.opened.every((k) => k === asset.r2Key)).toBe(true);
    expect(JSON.stringify(await getAsset(t.ctx, scope, asset.id))).not.toContain('Heliotrope');
    const found = await searchAssets(t.ctx, t.deps.search ?? {}, scope, { q: 'heliotrope' });
    expect(found.items.map((a) => a.id)).toEqual([asset.id]);
  });

  it('skips extraction of a file over the size cap', async () => {
    const asset = await t.upload('huge.pdf', 'application/pdf', 'x'.repeat(16));
    const original = t.blob.open.bind(t.blob);
    t.blob.open = async (key) => {
      const o = await original(key);
      return o ? { ...o, size: MAX_EXTRACT_DOCUMENT_BYTES + 1 } : o;
    };
    await t.run(asset.id);
    expect(await t.blob.get(assetTextKey(scope, asset.id, 1) as string)).toBeNull();
    expect(t.extractor.read).toHaveLength(0);
  });

  it('records a step that keeps failing as error, with the message only', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    t.images.info = async () => {
      throw new Error('images binding down\n    at secret/stack.ts:1');
    };
    const out = await t.run(asset.id);
    expect(out).toMatchObject({ value: { outcome: 'error' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('error');
    expect(after.ingestError).toBe('images binding down at secret/stack.ts:1');
    expect(ingested(t.store)).toHaveLength(0);
  });

  it('a run for a replaced or deleted file does nothing', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    await t.store.assets.save(scope, { ...asset, version: 2 });
    expect(await t.run(asset.id)).toMatchObject({ value: { outcome: 'stale' } });
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBeUndefined();
  });

  it('an editor save after ingest keeps the hash and status ingest recorded', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const stale = await getAsset(t.ctx, scope, asset.id); // read before ingest
    await t.run(asset.id);
    await t.store.assets.save(scope, { ...stale, title: { 'en-US': 'Mug' } });
    const after = await getAsset(t.ctx, scope, asset.id);
    expect(after.ingestStatus).toBe('ready');
    expect(after.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('starting ingest', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('one run per file: the upload path and the notification start the same instance', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    expect(await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string)).toBe('started');
    expect(await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string)).toBe('started');
    expect(starter.started).toEqual([
      {
        instanceId: assetIngestInstanceId(scope, asset.id, 1),
        params: { scope, assetId: asset.id, version: 1 },
      },
    ]);
    expect((await getAsset(t.ctx, scope, asset.id)).ingestStatus).toBe('pending');
  });

  it('instance ids are deterministic, scoped, short, and differ per version and rerun', () => {
    const id = assetIngestInstanceId(scope, 'a-1', 1);
    expect(id).toBe(assetIngestInstanceId(scope, 'a-1', 1));
    expect(id).not.toBe(assetIngestInstanceId({ ...scope, environmentId: 'other' }, 'a-1', 1));
    expect(id).not.toBe(assetIngestInstanceId(scope, 'a-1', 2));
    expect(id).not.toBe(assetIngestInstanceId(scope, 'a-1', 1, 'retry'));
    const long = assetIngestInstanceId(scope, 'x'.repeat(300), 1, 'retry');
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('ignores keys that are not an asset’s current file', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    for (const key of [
      `shop/main/${asset.id}/v1/text.md`,
      `shop/main/${asset.id}/other.png`,
      'versions/shop/main/e1/v1.json',
      'imports/shop/main/job/c1.json',
      'shop/main/missing/mug.png',
      '../shop/main/x',
    ]) {
      expect(await startAssetIngestForObject(t.ctx, starter, key)).toBe('ignored');
    }
    expect(starter.started).toEqual([]);
  });

  it('a requested rerun is its own run, and is ignored once the file moved on', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const starter = new RecordingAssetIngestStarter();
    await startAssetIngestForObject(t.ctx, starter, asset.r2Key as string);
    const request = { scope, assetId: asset.id, version: 1, rerun: 'r1' };
    expect(await startRequestedAssetIngest(t.ctx, starter, request)).toBe('started');
    expect(starter.started).toHaveLength(2);
    expect(await startRequestedAssetIngest(t.ctx, starter, { ...request, version: 2 })).toBe(
      'ignored',
    );
  });

  it('reingest queues a fresh run; a hosted video is refused', async () => {
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    const queue = new FakeAssetIngestQueue();
    const out = await reingestAsset(t.ctx, queue, scope, asset.id);
    expect(out.ingestStatus).toBe('pending');
    expect(queue.requested).toEqual([
      { scope, assetId: asset.id, version: 1, rerun: expect.any(String) },
    ]);
  });

  it('the reindex job covers assets never ingested or failed, and its chunk asks once per job', async () => {
    const fresh = await t.upload('a.png', 'image/png', 'a');
    const done = await t.upload('b.png', 'image/png', 'b');
    await t.run(done.id);
    const { assets, job } = await startAssetReindex(t.ctx, scope);
    expect(assets).toBe(1);
    expect(job?.action).toBe('asset_reindex');
    const all = await startAssetReindex(t.ctx, scope, { all: true });
    expect(all.assets).toBe(2);

    const queue = new FakeAssetIngestQueue();
    const runChunk = assetReindexChunkRunner(t.ctx, queue);
    const chunk = {
      jobId: job?.id as string,
      chunkId: 'c00000',
      entryIds: [fresh.id, 'gone'],
      status: 'running' as const,
      attempts: 1,
      failures: [],
    };
    const outcome = await runChunk(scope, job as NonNullable<typeof job>, chunk);
    expect(outcome).toEqual({ succeeded: 1, failures: [{ id: 'gone', error: 'Asset not found' }] });
    // A chunk run again asks for the same run (the job's token), so it starts once.
    await runChunk(scope, job as NonNullable<typeof job>, chunk);
    const starter = new RecordingAssetIngestStarter();
    for (const r of queue.requested) await startRequestedAssetIngest(t.ctx, starter, r);
    expect(starter.started).toHaveLength(1);
  });
});

describe('asset ingest cleanup', () => {
  it('deleting an asset removes its vector, its search document and its extracted text', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    const asset = await t.upload('brief.pdf', 'application/pdf', '%PDF');
    t.extractor.setText('brief.pdf', 'Heliotrope');
    await t.run(asset.id);
    const textKey = assetTextKey(scope, asset.id, 1) as string;
    expect(await t.blob.get(textKey)).toBe('Heliotrope');

    await deleteAsset(t.ctx, scope, asset.id);
    const deps = {
      sender: new RecordingWebhookSender(),
      blob: t.blob,
      assetSearch: t.deps.search,
    };
    for (const event of t.store.allEvents()) await dispatchEvent(t.ctx, deps, event);
    expect(t.vectors.assetRows.size).toBe(0);
    expect(t.index.textOf(scope, asset.id)).toBeUndefined();
    expect(await t.blob.get(textKey)).toBeNull();
    expect(t.blob.bytes(asset.r2Key as string)).toBeNull();
  });

  it('publishing re-indexes from the published snapshot', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    const asset = await t.upload('mug.png', 'image/png', 'bytes');
    await setAssetMetadata(t.ctx, scope, asset.id, { altText: { 'en-US': 'Teal mug' } });
    await publishAsset(t.ctx, scope, asset.id);
    const deps = { sender: new RecordingWebhookSender(), blob: t.blob, assetSearch: t.deps.search };
    for (const event of t.store.allEvents()) await dispatchEvent(t.ctx, deps, event);
    expect(t.index.textOf(scope, asset.id)).toContain('teal mug');
  });

  it('an environment purge removes its assets’ vectors and documents before the rows go', async () => {
    const t = setup();
    await createSpace(t.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await createEnvironment(t.ctx, 'shop', 'staging', 'Staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    const kept = await t.upload('keep.png', 'image/png', 'k');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await t.upload(`s${i}.png`, 'image/png', `s${i}`, staging);
      const steps = new FakeWorkflowSteps(t.clock);
      await steps.run(() =>
        runAssetIngest(steps, t.ctx, t.deps, { scope: staging, assetId: a.id, version: 1 }),
      );
      ids.push(a.id);
    }
    await t.run(kept.id);
    expect(t.vectors.assetRows.size).toBe(4);

    await deleteEnvironment(t.ctx, 'shop', 'staging', { confirm: 'staging', principal: ADMIN });
    const deps = { sender: new RecordingWebhookSender(), blob: t.blob, assetSearch: t.deps.search };
    // Drain as the engine does: every new event, until none are left.
    for (let seen = 0, guard = 0; guard < 50; guard++) {
      const events = t.store.allEvents().slice(seen);
      if (events.length === 0) break;
      seen += events.length;
      for (const e of events) await dispatchEvent(t.ctx, deps, e);
    }
    expect([...t.vectors.assetRows.keys()]).toEqual([`shop::main::${kept.id}`]);
    for (const id of ids) expect(t.index.textOf(staging, id)).toBeUndefined();
    expect(t.index.textOf(scope, kept.id)).toBeDefined();
  });
});
