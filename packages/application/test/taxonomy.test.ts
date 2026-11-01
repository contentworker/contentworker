import { InvalidStateError, NotFoundError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createConcept,
  createContentType,
  createEntry,
  createScheme,
  createTag,
  listPublishedEntries,
  publishContentType,
  publishEntry,
  setConceptBroader,
  setEntryMetadata,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

async function seedArticle(ctx: AppContext, title: string) {
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
  }).catch(() => {}); // idempotent across calls
  await publishContentType(ctx, scope, 'article').catch(() => {});
  return createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
}

describe('taxonomy vocabulary', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('builds a hierarchy and rejects cycles', async () => {
    const scheme = await createScheme(ctx, scope, { name: 'Topics' });
    const animals = await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'Animals' });
    const cats = await createConcept(ctx, scope, {
      schemeId: scheme.id,
      prefLabel: 'Cats',
      broaderId: animals.id,
    });
    expect(cats.broaderId).toBe(animals.id);

    // Making the parent point under its own child would cycle.
    await expect(setConceptBroader(ctx, scope, animals.id, cats.id)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('rejects associating an entry with an unknown tag', async () => {
    const entry = await seedArticle(ctx, 'A');
    await expect(
      setEntryMetadata(ctx, scope, entry.entry.id, { tags: ['ghost'] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('entry taxonomy associations', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('captures metadata in the published snapshot and filters by tag', async () => {
    const tagNews = await createTag(ctx, scope, { name: 'news' });
    const tagOpinion = await createTag(ctx, scope, { name: 'opinion' });

    const a = await seedArticle(ctx, 'A');
    const b = await seedArticle(ctx, 'B');
    await setEntryMetadata(ctx, scope, a.entry.id, { tags: [tagNews.id] });
    await setEntryMetadata(ctx, scope, b.entry.id, { tags: [tagOpinion.id] });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);

    // Delivered entries carry their metadata.
    const all = await listPublishedEntries(ctx, scope, {});
    const delivered = all.find((e) => e.id === a.entry.id);
    expect(delivered?.metadata?.tags).toEqual([tagNews.id]);

    // Filterable: metadata.tags membership.
    const newsOnly = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'metadata.tags', op: 'in', value: [tagNews.id] }],
    });
    expect(newsOnly.map((e) => e.id)).toEqual([a.entry.id]);
  });
});
