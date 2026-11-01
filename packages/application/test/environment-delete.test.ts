import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type Principal,
  ValidationError,
} from '@contentworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemorySearchIndex,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  deleteEnvironment,
  dispatchEvent,
  publishContentType,
  publishEntry,
  setEnvironmentAlias,
  visibleSearchHits,
} from '../src/index.js';

const main = { spaceId: 's1', environmentId: 'main' };
const admin = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;
const staging = { spaceId: 's1', environmentId: 'staging' };
let ctx: AppContext;
let store: InMemoryContentStore;

async function seed(scope: typeof main) {
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
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
  } as Parameters<typeof createContentType>[2]);
  await publishContentType(ctx, scope, 'article');
  const a = await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'Published' } },
  });
  await publishEntry(ctx, scope, a.entry.id);
  await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'Draft' } },
  });
  return a.entry.id;
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createSpace(ctx, { spaceId: 's1', name: 'S1', defaultLocale: 'en-US' });
  await createEnvironment(ctx, 's1', 'staging');
});

describe('deleting an environment', () => {
  it('removes everything in it, leaves other environments alone, and announces the cleanup', async () => {
    await seed(main);
    const published = await seed(staging);

    const result = await deleteEnvironment(ctx, 's1', 'staging', {
      confirm: 'staging',
      principal: admin,
    });
    expect(result).toEqual({ environmentId: 'staging', publishedEntries: 1 });

    expect(await store.contentTypes.list(staging)).toEqual([]);
    expect(await store.entries.list(staging, {})).toEqual([]);
    expect(await store.entries.getPublished(staging, published)).toBeNull();
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toEqual(['main']);
    // main is untouched.
    expect(await store.contentTypes.list(main)).toHaveLength(1);
    expect(await store.entries.list(main, {})).toHaveLength(2);
    // The engine is told which published entries to drop from search and vectors.
    const pending = await store.outbox.readPending(100);
    const deleted = pending.filter((e) => e.type === 'environment.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ scope: staging, entryIds: [published] });
    // Recorded with the deletion, naming who did it.
    const audit = await store.audit.list('s1', { environmentId: 'staging' });
    expect(audit.find((a) => a.action === 'environment.deleted')).toMatchObject({
      actor: 'admin-token',
      targetId: 'staging',
    });
  });

  it('announces even an empty environment, so its delivery cache is purged', async () => {
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    const pending = await store.outbox.readPending(100);
    expect(pending.filter((e) => e.type === 'environment.deleted')).toMatchObject([
      { scope: staging, entryIds: [] },
    ]);
  });

  it('needs the environment id repeated as confirmation', async () => {
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { principal: admin }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { confirm: 'main', principal: admin }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toContain('staging');
  });

  it('refuses an API key, even one holding space:admin', async () => {
    const key = { spaceId: 's1', kind: 'cma', scopes: ['space:admin'] } as unknown as Principal;
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: key }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toContain('staging');
  });

  it('refuses main, an unknown environment, and one an alias points at', async () => {
    await expect(
      deleteEnvironment(ctx, 's1', 'main', { confirm: 'main', principal: admin }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      deleteEnvironment(ctx, 's1', 'nope', { confirm: 'nope', principal: admin }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await setEnvironmentAlias(ctx, 's1', 'live', 'staging');
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('cleaning up after a deleted environment', () => {
  it('drops each published entry from the search index and the vectors', async () => {
    const searchIndex = new InMemorySearchIndex();
    const vectors = new InMemoryVectorStore();
    const embeddings = new LocalEmbeddingsProvider(32);
    const deps = {
      sender: new RecordingWebhookSender(),
      searchIndex,
      rag: { embeddings, vectors },
    };
    await searchIndex.index(staging, {
      entryId: 'gone',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'gone forever' },
      entryVersion: 1,
    });
    await vectors.upsert([
      {
        scope: staging,
        entryId: 'gone',
        locale: 'en-US',
        chunkIndex: 0,
        chunkText: 'gone forever',
        embedding: (await embeddings.embed(['gone forever']))[0] as number[],
        entryVersion: 1,
      },
    ]);
    await dispatchEvent(ctx, deps, {
      id: 'evt-del',
      type: 'environment.deleted',
      scope: staging,
      occurredAt: '2026-01-01T00:00:00.000Z',
      entryIds: ['gone'],
    });
    expect(await searchIndex.search(staging, 'gone', { topK: 5 })).toEqual([]);
    expect(
      await vectors.query(staging, (await embeddings.embed(['gone forever']))[0] as number[], {
        topK: 5,
      }),
    ).toEqual([]);
  });
});

describe('search results after content goes away', () => {
  it('drops hits on entries no longer published, for every caller', async () => {
    const published = await seed(staging);
    const hits = [
      { entryId: published, score: 1, snippet: 'live' },
      { entryId: 'deleted-or-unpublished', score: 0.9, snippet: 'stale snippet' },
    ];
    // An index or vector store that still holds a document (a missed unpublish, a deleted
    // environment) must not serve its snippet, restricted or not.
    expect(await visibleSearchHits(ctx, staging, admin, hits)).toEqual([hits[0]]);
  });
});

describe("a deleted environment's files", () => {
  it("go, except any another environment's asset records still point at", async () => {
    const blob = new FakeBlobStore();
    await blob.put('s1/staging/only-here/x.png', 'x', 'image/png');
    await blob.put('s1/staging/cloned/y.png', 'y', 'image/png');
    await blob.put('s1/main/m1/z.png', 'z', 'image/png');
    // main holds an asset record with the staging file's id, as a clone of staging would.
    await store.assets.create(main, {
      id: 'cloned',
      status: 'draft',
      file: { url: '/media/s1/staging/cloned/y.png', fileName: 'y.png', contentType: 'image/png' },
      title: {},
      description: {},
      metadata: { altText: {}, tags: [] },
    } as never);
    await dispatchEvent(
      ctx,
      { sender: new RecordingWebhookSender(), blob },
      {
        id: 'evt-files',
        type: 'environment.deleted',
        scope: staging,
        occurredAt: '2026-01-01T00:00:00.000Z',
        entryIds: [],
      },
    );
    expect(blob.keys().sort()).toEqual(['s1/main/m1/z.png', 's1/staging/cloned/y.png']);
  });
});
