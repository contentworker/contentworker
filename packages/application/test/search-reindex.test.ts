import {
  type BulkChunkDueEvent,
  type Principal,
  SCOPES,
  type Scope,
  type SearchToggledEvent,
} from '@contentworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  consumeEvent,
  createAsset,
  createContentType,
  createEntry,
  createSpace,
  getAiSettings,
  getSearchReindexJob,
  indexAssetForSearch,
  indexEntryEmbeddings,
  publishEntry,
  SYSTEM_CALLER,
  setAiSettings,
  startSearchReindex,
} from '../src/index';

/**
 * Turning search on or off in Settings → AI reindexes every environment of the space: off deletes
 * the vectors of published entries and of assets, on embeds them again (published entries only).
 * The job is started from an event that commits with the setting, by the system, and a later
 * toggle supersedes it.
 */
const main: Scope = { spaceId: 'blog', environmentId: 'main' };
const staging: Scope = { spaceId: 'blog', environmentId: 'staging' };
const admin: Principal = {
  kind: 'user',
  subject: 'ada@example.com',
  scopes: [SCOPES.spaceAdmin],
} as Principal;

async function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('r') };
  const blob = new FakeBlobStore();
  const embeddings = new LocalEmbeddingsProvider();
  const vectors = new InMemoryVectorStore();
  const rag = { embeddings, vectors };
  const assetSearch = { embeddings, vectors };
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await store.spaces.createEnvironment('blog', 'staging', 'Staging');
  for (const scope of [main, staging]) {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
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
      ],
    });
  }
  const entry = async (title: string, publish: boolean) => {
    const { entry } = await createEntry(ctx, main, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': title } },
    });
    if (publish) {
      await publishEntry(ctx, main, entry.id);
      await indexEntryEmbeddings(rag, main, {
        entryId: entry.id,
        fields: { title: { 'en-US': title } },
        entryVersion: 1,
      });
    }
    return entry.id;
  };
  const published = await entry('Greetings from the harbour', true);
  const draft = await entry('A draft nobody embedded', false);
  const { asset } = await createAsset(ctx, blob, main, {
    fileName: 'harbour.jpg',
    contentType: 'image/jpeg',
  });
  await indexAssetForSearch(ctx, assetSearch, blob, main, asset.id);

  /** Every event appended since `from`, consumed as the engine would (twice for a redelivery). */
  let seen = store.allEvents().length;
  const drain = async (opts: { twice?: boolean } = {}) => {
    for (;;) {
      const fresh = store.allEvents().slice(seen);
      if (fresh.length === 0) return;
      seen += fresh.length;
      for (const e of fresh) {
        for (let i = 0; i < (opts.twice ? 2 : 1); i++) {
          await consumeEvent(
            ctx,
            { sender: new RecordingWebhookSender(), rag, assetSearch, blob },
            e as never,
          );
        }
      }
    }
  };
  const indexed = async (scope: Scope) => {
    const [probe] = await embeddings.embed(['x']);
    const hits = await vectors.query(scope, probe as number[], { topK: 100, minScore: -2 });
    return [...new Set(hits.map((h) => h.entryId))];
  };
  const assetIndexed = (scope: Scope) =>
    [...vectors.assetRows.keys()].filter((k) =>
      k.startsWith(`${scope.spaceId}::${scope.environmentId}::`),
    ).length;
  const toggled = () =>
    store
      .allEvents()
      .filter((e) => (e as { type?: string }).type === 'search.toggled') as SearchToggledEvent[];
  const turn = async (enabled: boolean) => {
    const current = await getAiSettings(ctx, 'blog');
    return setAiSettings(ctx, admin, 'blog', {
      expectedVersion: current.version,
      capabilities: { search: { enabled } },
    });
  };
  return {
    ctx,
    store,
    rag,
    assetSearch,
    drain,
    indexed,
    assetIndexed,
    toggled,
    turn,
    published,
    draft,
    asset,
  };
}

describe('search reindex on a toggle of the search setting', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    h = await setup();
  });

  it('appends one search.toggled per environment with the set, and none for other changes', async () => {
    const set = await h.turn(false);
    expect(
      h.toggled().map((e) => [e.scope.environmentId, e.enabled, e.settingsVersion, e.actor]),
    ).toEqual([
      ['main', false, set.settings.version, 'ada@example.com'],
      ['staging', false, set.settings.version, 'ada@example.com'],
    ]);
    // A change that leaves search as it was starts nothing; neither does setting it off again.
    await setAiSettings(h.ctx, admin, 'blog', {
      expectedVersion: set.settings.version,
      capabilities: { drafting: { enabled: true, tier: 'fast' } },
    });
    await h.turn(false);
    expect(h.toggled()).toHaveLength(2);
  });

  it('off deletes the vectors of published entries and of assets, in the system’s name', async () => {
    expect(await h.indexed(main)).toEqual([h.published]);
    expect(h.assetIndexed(main)).toBe(1);
    await h.turn(false);
    await h.drain();
    expect(await h.indexed(main)).toEqual([]);
    expect(h.assetIndexed(main)).toBe(0);
    const job = await getSearchReindexJob(h.ctx, main);
    expect(job).toMatchObject({
      action: 'search_reindex',
      status: 'completed',
      totalItems: 2,
      succeeded: 2,
      failed: 0,
      config: { enabled: false, actor: 'ada@example.com' },
    });
    // Nobody's access is re-checked before its chunks: the job realizes the space's setting.
    expect(job?.config?.startedBy).toBeUndefined();
    // The staging environment has nothing published: no job there.
    expect(await getSearchReindexJob(h.ctx, staging)).toBeNull();
  });

  it('on embeds published entries and assets again, never a draft', async () => {
    await h.turn(false);
    await h.drain();
    await h.turn(true);
    await h.drain();
    expect(await h.indexed(main)).toEqual([h.published]);
    expect(await h.indexed(main)).not.toContain(h.draft);
    expect(h.assetIndexed(main)).toBe(1);
    expect(await getSearchReindexJob(h.ctx, main)).toMatchObject({
      status: 'completed',
      config: { enabled: true },
    });
  });

  it('runs each event and chunk once however often it is delivered', async () => {
    await h.turn(false);
    await h.drain({ twice: true });
    const jobs = (await h.store.bulkJobs.listJobs(main)).filter(
      (j) => j.action === 'search_reindex',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'completed', succeeded: 2 });
  });

  it('a second toggle while one runs cancels it and starts another', async () => {
    await h.turn(false);
    const [off] = h.toggled();
    const first = await startSearchReindex(
      h.ctx,
      { rag: h.rag, assetSearch: h.assetSearch },
      off as SearchToggledEvent,
    );
    expect(first?.status).toBe('running');

    await h.turn(true);
    const on = h
      .toggled()
      .find((e) => e.enabled && e.scope.environmentId === 'main') as SearchToggledEvent;
    const second = await startSearchReindex(h.ctx, { rag: h.rag, assetSearch: h.assetSearch }, on);
    expect(second?.id).not.toBe(first?.id);
    expect((await h.store.bulkJobs.getJob(main, first?.id as string))?.status).toBe('cancelled');
    // Redelivered, the later event finds its job; the earlier one, overtaken, starts nothing.
    expect(
      (await startSearchReindex(h.ctx, { rag: h.rag, assetSearch: h.assetSearch }, on))?.id,
    ).toBe(second?.id);
    expect(
      await startSearchReindex(
        h.ctx,
        { rag: h.rag, assetSearch: h.assetSearch },
        off as SearchToggledEvent,
      ),
    ).toBeNull();
    expect((await getSearchReindexJob(h.ctx, main))?.id).toBe(second?.id);
  });

  it('a chunk of an overtaken job acts on the setting in force, never the one that started it', async () => {
    await h.turn(false);
    const [off] = h.toggled();
    const job = await startSearchReindex(
      h.ctx,
      { rag: h.rag, assetSearch: h.assetSearch },
      off as SearchToggledEvent,
    );
    // Search goes back on before the off job's chunk runs (and before its own event is consumed).
    await h.turn(true);
    const chunk: BulkChunkDueEvent = {
      id: 'chunk-event',
      type: 'bulk.chunk_due',
      scope: main,
      occurredAt: new Date().toISOString(),
      jobId: job?.id as string,
      chunkId: 'c00000',
    };
    await consumeEvent(h.ctx, { sender: new RecordingWebhookSender(), ...h }, chunk);
    expect(await h.indexed(main)).toEqual([h.published]);
    expect(h.assetIndexed(main)).toBe(1);
  });

  it('starts nothing where no vectors are bound', async () => {
    await h.turn(false);
    const [off] = h.toggled();
    expect(await startSearchReindex(h.ctx, {}, off as SearchToggledEvent)).toBeNull();
  });
});
