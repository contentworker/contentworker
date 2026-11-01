import { NotFoundError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  compareEnvironments,
  createContentType,
  createEntry,
  getEntry,
  listContentTypes,
  mergeEnvironments,
} from '../src/index.js';

const ARTICLE = {
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
} as const;

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  // Two environments in one space.
  store.seedSpace({ spaceId: 'shop', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

const main = { spaceId: 'shop', environmentId: 'main' };
const staging = { spaceId: 'shop', environmentId: 'staging' };

describe('branch compare/merge', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('classifies added/changed/unchanged content types and entries', async () => {
    // staging has the type + an entry; main has neither.
    await createContentType(ctx, staging, ARTICLE);
    const a = await createEntry(ctx, staging, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
    });

    const before = await compareEnvironments(ctx, 'shop', 'staging', 'main');
    expect(before.contentTypes).toEqual([{ apiId: 'article', kind: 'added' }]);
    expect(before.entries).toEqual([
      { entryId: a.entry.id, contentTypeApiId: 'article', kind: 'added' },
    ]);
  });

  it('merges selected content types and entries source→target (additive)', async () => {
    await createContentType(ctx, staging, ARTICLE);
    const a = await createEntry(ctx, staging, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
    });

    const result = await mergeEnvironments(ctx, 'shop', 'staging', 'main', {
      contentTypes: ['article'],
      entries: [a.entry.id],
    });
    expect(result.mergedContentTypes).toEqual(['article']);
    expect(result.mergedEntries).toEqual([a.entry.id]);

    // The content type and entry (same id, same fields) now exist in main.
    expect((await listContentTypes(ctx, main)).map((c) => c.apiId)).toEqual(['article']);
    const merged = await getEntry(ctx, main, a.entry.id);
    expect(merged.fields).toEqual({ title: { 'en-US': 'Hello' } });

    // Re-comparing shows the entry as unchanged between the two environments.
    const diff = await compareEnvironments(ctx, 'shop', 'staging', 'main');
    expect(diff.entries.find((e) => e.entryId === a.entry.id)?.kind).toBe('unchanged');
  });

  it('appends a new version when merging onto an existing target entry', async () => {
    await createContentType(ctx, main, ARTICLE);
    await createContentType(ctx, staging, ARTICLE);
    const a = await createEntry(ctx, main, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'v1' } },
    });
    // Same id in staging with different content (simulate a branched edit).
    await ctx.store.entries.create(
      staging,
      {
        id: a.entry.id,
        contentTypeApiId: 'article',
        status: 'draft',
        currentVersion: 1,
        publishedVersion: null,
      },
      { entryId: a.entry.id, version: 1, fields: { title: { 'en-US': 'v2' } } },
    );

    await mergeEnvironments(ctx, 'shop', 'staging', 'main', { entries: [a.entry.id] });
    const merged = await getEntry(ctx, main, a.entry.id);
    expect(merged.fields).toEqual({ title: { 'en-US': 'v2' } });
    expect(merged.entry.currentVersion).toBe(2); // a new version was appended
  });

  it('rejects merging an entry whose content type is missing in the target', async () => {
    await createContentType(ctx, staging, ARTICLE);
    const a = await createEntry(ctx, staging, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
    });
    await expect(
      mergeEnvironments(ctx, 'shop', 'staging', 'main', { entries: [a.entry.id] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
