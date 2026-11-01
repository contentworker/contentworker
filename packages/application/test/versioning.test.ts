import { NotFoundError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  diffVersions,
  getVersion,
  listVersions,
  publishContentType,
  publishEntry,
  restoreVersion,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

async function seedArticleType(ctx: AppContext) {
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
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
    ],
  });
  await publishContentType(ctx, scope, 'article');
}

describe('entry version history', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = makeContext();
    await seedArticleType(ctx);
  });

  it('records a version per save, newest first, with timestamps', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'v1' } },
    });
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'v2' } });
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'v3' } });

    const versions = await listVersions(ctx, scope, entry.id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.every((v) => typeof v.createdAt === 'string')).toBe(true);
    expect((await getVersion(ctx, scope, entry.id, 1)).fields).toEqual({
      title: { 'en-US': 'v1' },
    });
  });

  it('diffs two versions field-by-field', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
    });
    await updateEntry(ctx, scope, entry.id, {
      title: { 'en-US': 'Hello world' },
      body: { 'en-US': 'New body' },
    });

    const diff = await diffVersions(ctx, scope, entry.id, 1, 2);
    const byField = Object.fromEntries(diff.changes.map((c) => [c.field, c.kind]));
    expect(byField.title).toBe('changed');
    expect(byField.body).toBe('added');
  });

  it('restores an older version as a new draft (history preserved)', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'original' } },
    });
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'edited' } });

    const restored = await restoreVersion(ctx, scope, entry.id, 1);
    // A NEW version is appended (v3), carrying v1's fields — nothing is rewritten.
    expect(restored.entry.currentVersion).toBe(3);
    expect(restored.fields).toEqual({ title: { 'en-US': 'original' } });
    expect((await listVersions(ctx, scope, entry.id)).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('rejects reading an unknown version or entry', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'x' } },
    });
    await expect(getVersion(ctx, scope, entry.id, 99)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listVersions(ctx, scope, 'ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('restore re-validates against the current model', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'keep' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'changed' } });
    // Restoring v1 is valid and produces a fresh draft version.
    const restored = await restoreVersion(ctx, scope, entry.id, 1);
    expect(restored.fields).toEqual({ title: { 'en-US': 'keep' } });
  });
});
