import { ConflictError, type FieldDefinition } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneEnvironment,
  contentTypeDependents,
  createContentType,
  createEntry,
  createEnvironment,
  createMenu,
  deleteContentType,
  deliveryReads,
  exportSnapshot,
  getContentType,
  importSnapshot,
  listDeliveredRedirects,
  listDeliveredRoutes,
  listPublishedEntries,
  mergeEnvironments,
  previewMenu,
  publishContentType,
  publishEntry,
  updateContentType,
  updateEntry,
  writeSnapshotModel,
} from '../src';

/** The test-kit's half of 0030_published_definition; `packages/db/test` holds D1 to the same. */
const scope = { spaceId: 's1', environmentId: 'main' };
const copy = { spaceId: 's1', environmentId: 'copy' };

const field = (
  apiId: string,
  type: FieldDefinition['type'],
  position: number,
): FieldDefinition => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});
const fields = [field('title', 'Symbol', 0), field('slug', 'Slug', 1)];
const subtitle = [...fields, field('subtitle', 'Symbol', 2)];

let store: InMemoryContentStore;
let ctx: AppContext;

const delivered = async (at = scope) =>
  ((await deliveryReads(ctx).read(at, { contentTypes: true })).contentTypes ?? []).find(
    (t) => t.apiId === 'page',
  );
const events = () => store.allEvents().filter((e) => e.type.startsWith('content_type.'));

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('p') };
  await createEnvironment(ctx, 's1', 'copy');
  await createContentType(ctx, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    urlPattern: '/{slug}',
    fields,
  });
  await publishContentType(ctx, scope, 'page');
});

describe('a draft revision of a live type', () => {
  it('changes nothing Delivery serves, so it announces nothing', async () => {
    const before = events().length;
    await updateContentType(ctx, scope, 'page', { fields: subtitle, urlPattern: '/p/{slug}' });
    expect(events()).toHaveLength(before);
    expect(await delivered()).toMatchObject({
      name: 'Page',
      urlPattern: '/{slug}',
      version: 1,
      status: 'published',
    });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it('reaches Delivery with its publish, which announces it', async () => {
    await updateContentType(ctx, scope, 'page', { urlPattern: '/p/{slug}' });
    const before = events().length;
    await publishContentType(ctx, scope, 'page');
    expect(events()).toHaveLength(before + 1);
    expect(await delivered()).toMatchObject({ urlPattern: '/p/{slug}', version: 2 });
    expect((await store.contentTypes.publishedDefinitions(scope)).size).toBe(0);
  });

  it('stays the draft on a Management read', async () => {
    await updateContentType(ctx, scope, 'page', { urlPattern: '/p/{slug}' });
    expect(await getContentType(ctx, scope, 'page')).toMatchObject({
      urlPattern: '/p/{slug}',
      version: 2,
      status: 'draft',
    });
  });

  it('keeps the first published definition through later drafts', async () => {
    await updateContentType(ctx, scope, 'page', { name: 'Two' });
    await updateContentType(ctx, scope, 'page', { name: 'Three' });
    expect(await delivered()).toMatchObject({ name: 'Page', version: 1 });
  });

  it('rolls back with a failed unit', async () => {
    const page = await getContentType(ctx, scope, 'page');
    await expect(
      store.withTransaction(async (tx) => {
        await tx.contentTypes.save(scope, { ...page, version: 2, status: 'draft' });
        throw new Error('lost');
      }),
    ).rejects.toThrow('lost');
    expect((await store.contentTypes.publishedDefinitions(scope)).size).toBe(0);
  });

  it('goes with the type', async () => {
    await createContentType(ctx, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields,
    });
    await publishContentType(ctx, scope, 'note');
    await updateContentType(ctx, scope, 'note', { name: 'Two' });
    expect((await store.contentTypes.publishedDefinitions(scope)).has('note')).toBe(true);
    await deleteContentType(ctx, scope, 'note');
    expect((await store.contentTypes.publishedDefinitions(scope)).has('note')).toBe(false);
  });

  it('holds a delete back by the URL pattern Delivery serves, though a draft cleared it', async () => {
    await updateContentType(ctx, scope, 'page', { urlPattern: null });
    expect((await contentTypeDependents(ctx, scope, 'page')).urlPattern).toBe('/{slug}');
    await expect(deleteContentType(ctx, scope, 'page')).rejects.toBeInstanceOf(ConflictError);
  });

  it('is kept per environment', async () => {
    await updateContentType(ctx, scope, 'page', { name: 'Two' });
    expect((await store.contentTypes.publishedDefinitions(copy)).size).toBe(0);
  });

  it('survives a merge of a draft, and yields to a merge of a published type', async () => {
    await createContentType(ctx, copy, {
      apiId: 'page',
      name: 'Other',
      displayField: 'title',
      urlPattern: '/o/{slug}',
      fields,
    });
    await mergeEnvironments(ctx, 's1', 'copy', 'main', { contentTypes: ['page'] });
    expect(await delivered()).toMatchObject({ name: 'Page', urlPattern: '/{slug}' });

    await publishContentType(ctx, copy, 'page');
    await mergeEnvironments(ctx, 's1', 'copy', 'main', { contentTypes: ['page'] });
    expect(await delivered()).toMatchObject({ name: 'Other', urlPattern: '/o/{slug}' });
  });
});

describe('a type that was never published', () => {
  it('is delivered as it stands, status draft, out of the routes', async () => {
    await createContentType(ctx, scope, {
      apiId: 'event',
      name: 'Event',
      displayField: 'title',
      urlPattern: '/e/{slug}',
      fields,
    });
    const { contentTypes = [] } = await deliveryReads(ctx).read(scope, { contentTypes: true });
    expect(contentTypes.find((t) => t.apiId === 'event')).toMatchObject({
      status: 'draft',
      urlPattern: '/e/{slug}',
    });
    expect((await listDeliveredRoutes(ctx, scope)).map((r) => r.contentType)).toEqual(['page']);
  });
});

describe('Management reads that say what Delivery does', () => {
  async function published(slug: string) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': slug }, slug: { 'en-US': slug } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  }

  it('answers a reference filter by the links as last published', async () => {
    await createContentType(ctx, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        field('title', 'Symbol', 0),
        { ...field('author', 'Link', 1), linkType: 'Entry' } as FieldDefinition,
      ],
    });
    await publishContentType(ctx, scope, 'post');
    const ann = await published('ann');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { author: { 'en-US': { id: ann, linkType: 'Entry' } } },
    });
    await publishEntry(ctx, scope, entry.id);
    const query = {
      contentTypeApiId: 'post',
      filters: [{ field: 'author', op: 'ref' as const, value: ann }],
    };
    const ids = async () => (await listPublishedEntries(ctx, scope, query)).map((e) => e.id);
    expect(await ids()).toEqual([entry.id]);
    await updateContentType(ctx, scope, 'post', {
      fields: [field('title', 'Symbol', 0), field('author', 'Symbol', 1)],
    });
    expect(await ids()).toEqual([entry.id]);
  });

  it('moves a slug by the published URL pattern while a draft has another', async () => {
    const id = await published('team');
    await updateContentType(ctx, scope, 'page', { urlPattern: '/p/{slug}' });
    await updateEntry(ctx, scope, id, {
      title: { 'en-US': 'team' },
      slug: { 'en-US': 'people' },
    });
    await publishEntry(ctx, scope, id);
    expect(
      (await listDeliveredRedirects(ctx, scope)).map((r) => [r.source, r.destination]),
    ).toEqual([['/team', '/people']]);
  });

  it('moves no slug for a type with nothing kept and no pattern', async () => {
    await createContentType(ctx, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields,
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'a' }, slug: { 'en-US': 'a' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'a' }, slug: { 'en-US': 'b' } });
    await publishEntry(ctx, scope, entry.id);
    expect(await listDeliveredRedirects(ctx, scope)).toEqual([]);
  });

  it('previews a menu item of a live type as live through a draft', async () => {
    const id = await published('about');
    const menu = await createMenu(ctx, scope, {
      handle: 'main',
      name: 'Main',
      items: [{ id: 'about', link: { type: 'entry', entryId: id } }],
    });
    await updateContentType(ctx, scope, 'page', { name: 'Two' });
    expect((await previewMenu(ctx, scope, menu.id)).items[0]).toMatchObject({
      status: 'live',
      url: '/about',
    });
  });
});

describe('copying a live type with a draft', () => {
  beforeEach(async () => {
    await updateContentType(ctx, scope, 'page', { fields: subtitle, urlPattern: '/p/{slug}' });
  });

  const expectBoth = async () => {
    expect(await delivered(copy)).toMatchObject({ urlPattern: '/{slug}', status: 'published' });
    expect((await delivered(copy))?.fields.map((f) => f.apiId)).toEqual(['title', 'slug']);
    const working = await getContentType(ctx, copy, 'page');
    expect(working).toMatchObject({ urlPattern: '/p/{slug}', status: 'draft' });
    expect(working.fields.map((f) => f.apiId)).toEqual(['title', 'slug', 'subtitle']);
  };

  it('carries the published definition in the snapshot', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    expect(snapshot.contentTypes[0]?.published).toMatchObject({
      urlPattern: '/{slug}',
      version: 1,
    });
    expect(snapshot.snapshotVersion).toBe(1);
  });

  it('leaves a type with no draft as it was in the snapshot', async () => {
    await publishContentType(ctx, scope, 'page');
    expect((await exportSnapshot(ctx, scope)).contentTypes[0]).not.toHaveProperty('published');
  });

  it('restores both through an import', async () => {
    await importSnapshot(ctx, copy, await exportSnapshot(ctx, scope));
    await expectBoth();
  });

  it('restores both through a clone', async () => {
    await cloneEnvironment(ctx, scope, copy);
    await expectBoth();
  });

  it('writes the model again without going back through the published definition', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    await importSnapshot(ctx, copy, snapshot);
    await createEntry(ctx, copy, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'a' }, subtitle: { 'en-US': 'held' } },
    });
    await writeSnapshotModel(ctx, copy, snapshot, []);
    await expectBoth();
  });

  it('restores the published singleton flag', async () => {
    await createContentType(ctx, scope, {
      apiId: 'home',
      name: 'Home',
      displayField: 'title',
      fields,
      singleton: true,
    });
    await publishContentType(ctx, scope, 'home');
    await updateContentType(ctx, scope, 'home', { singleton: false });
    await cloneEnvironment(ctx, scope, copy);
    const { contentTypes = [] } = await deliveryReads(ctx).read(copy, { contentTypes: true });
    expect(contentTypes.find((t) => t.apiId === 'home')?.singleton).toBe(true);
    expect((await getContentType(ctx, copy, 'home')).singleton).toBeUndefined();
  });

  it('restores a snapshot written before these were kept, as a plain draft', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    await importSnapshot(ctx, copy, {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map(({ published: _old, ...ct }) => ct),
    });
    expect(await getContentType(ctx, copy, 'page')).toMatchObject({ status: 'draft' });
    expect((await store.contentTypes.publishedDefinitions(copy)).size).toBe(0);
    expect(await listDeliveredRoutes(ctx, copy)).toEqual([]);
  });
});
