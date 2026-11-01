import { InvalidStateError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  getPublishedEntry,
  publishContentType,
  publishEntry,
  publishRelease,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): { ctx: AppContext; store: InMemoryContentStore } {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { ctx: { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') }, store };
}

async function seedType(ctx: AppContext) {
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
  });
  await publishContentType(ctx, scope, 'article');
}

const draft = (ctx: AppContext, title: string) =>
  createEntry(ctx, scope, { contentTypeApiId: 'article', fields: { title: { 'en-US': title } } });

describe('releases', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  beforeEach(async () => {
    ({ ctx, store } = makeContext());
    await seedType(ctx);
  });

  it('publishes every member of a release atomically in one transaction', async () => {
    const a = await draft(ctx, 'A');
    const b = await draft(ctx, 'B');
    const release = await createRelease(ctx, scope, { title: 'Launch' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id });
    await addEntryToRelease(ctx, scope, release.id, { entityId: b.entry.id });

    // Neither is on the Delivery read model yet.
    await expect(getPublishedEntry(ctx, scope, a.entry.id)).rejects.toThrow(/not.*found/i);

    const shipped = await publishRelease(ctx, scope, release.id);
    expect(shipped.release.status).toBe('published');
    expect(shipped.release.publishedAt).toBeDefined();

    // Both are now published, each with its own entry.published event.
    expect((await getPublishedEntry(ctx, scope, a.entry.id)).fields.title?.['en-US']).toBe('A');
    expect((await getPublishedEntry(ctx, scope, b.entry.id)).fields.title?.['en-US']).toBe('B');
    const published = store.allEvents().filter((e) => e.type === 'entry.published');
    expect(published).toHaveLength(2);
    expect(store.allEvents().some((e) => e.type === 'release.published')).toBe(true);
  });

  it('rolls back the whole release if any member fails (all-or-nothing)', async () => {
    const a = await draft(ctx, 'A');
    const release = await createRelease(ctx, scope, { title: 'Bad batch' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id });
    // Inject a member that cannot publish (entry does not exist) by writing the
    // item directly, bypassing the existence check addEntryToRelease enforces.
    await store.releases.addItem(scope, release.id, {
      entityType: 'Entry',
      entityId: 'ghost',
      action: 'publish',
    });

    await expect(publishRelease(ctx, scope, release.id)).rejects.toThrow(/not.*found/i);

    // The valid member did NOT publish — the transaction rolled back.
    await expect(getPublishedEntry(ctx, scope, a.entry.id)).rejects.toThrow(/not.*found/i);
    const reloaded = await store.releases.get(scope, release.id);
    expect(reloaded?.status).toBe('open');
  });

  it('supports unpublish actions inside a release', async () => {
    const a = await draft(ctx, 'A');
    await publishEntry(ctx, scope, a.entry.id);
    const release = await createRelease(ctx, scope, { title: 'Takedown' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id, action: 'unpublish' });

    await publishRelease(ctx, scope, release.id);
    await expect(getPublishedEntry(ctx, scope, a.entry.id)).rejects.toThrow(/not.*found/i);
  });

  it('rejects publishing an empty release', async () => {
    const release = await createRelease(ctx, scope, { title: 'Empty' });
    await expect(publishRelease(ctx, scope, release.id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('rejects modifying a release after it has shipped', async () => {
    const a = await draft(ctx, 'A');
    const release = await createRelease(ctx, scope, { title: 'Done' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id });
    await publishRelease(ctx, scope, release.id);
    const b = await draft(ctx, 'B');
    await expect(
      addEntryToRelease(ctx, scope, release.id, { entityId: b.entry.id }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});
