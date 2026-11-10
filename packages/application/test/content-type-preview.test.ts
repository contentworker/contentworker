import {
  ConflictError,
  type ContentTypeDraft,
  ForbiddenError,
  type Principal,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  getContentType,
  publishContentType,
  SYSTEM_CALLER,
  setContentTypePreview,
  updateContentType,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const other = { spaceId: 's2', environmentId: 'main' };
const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';

const post: ContentTypeDraft = {
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
    { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: false, position: 1 },
  ],
};

let store: InMemoryContentStore;
let ctx: AppContext;

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en', locales: ['en'] });
  store.seedSpace({ spaceId: 's2', defaultLocale: 'en', locales: ['en'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('g') };
  await createContentType(ctx, SYSTEM_CALLER, scope, post);
});

const publishedEvents = async () =>
  (await store.outbox.readPending(100)).filter((e) => e.type === 'content_type.published');

describe('setting a content type’s preview URL', () => {
  it('sets and clears the template, leaving the rest of the definition alone', async () => {
    const set = await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', TEMPLATE);
    expect(set.preview).toEqual({ urlTemplate: TEMPLATE });
    expect(set.fields.map((f) => f.apiId)).toEqual(['title', 'slug']);
    expect((await getContentType(ctx, scope, 'post')).preview?.urlTemplate).toBe(TEMPLATE);

    const cleared = await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', null);
    expect(cleared.preview).toBeUndefined();
    expect((await getContentType(ctx, scope, 'post')).preview).toBeUndefined();
  });

  it('keeps a published type published, with its event, and a draft a draft', async () => {
    // Never published: the template lands on the draft and nothing is announced.
    const draft = await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', TEMPLATE);
    expect(draft.status).toBe('draft');
    expect(await publishedEvents()).toHaveLength(0);

    await publishContentType(ctx, scope, 'post');
    const before = (await publishedEvents()).length;
    const kept = await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', null);
    expect(kept.status).toBe('published');
    const events = await publishedEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ contentTypeApiId: 'post', version: kept.version });

    // Unpublished changes stay unpublished: setting the template doesn't ship them.
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'post', { name: 'Article' });
    const still = await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', TEMPLATE);
    expect(still.status).toBe('draft');
    expect(still.name).toBe('Article');
  });

  it('leaves a draft when the save would also change what an older definition stored', async () => {
    await publishContentType(ctx, scope, 'post');
    const stored = await getContentType(ctx, scope, 'post');
    // Stored before blank guidance was dropped on save: a revision normalizes it away.
    await store.contentTypes.save(scope, {
      ...stored,
      fields: stored.fields.map((f, i) => (i === 0 ? { ...f, help: '  ' } : f)),
    });
    const before = (await publishedEvents()).length;
    const set = await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', TEMPLATE);
    expect(set.status).toBe('draft');
    expect(await publishedEvents()).toHaveLength(before);
  });

  it('refuses a template the domain refuses', async () => {
    await expect(
      setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', 'http://site.example/?t={token}'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', 'https://site.example/{id}'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('needs read on the type to point its preview tokens somewhere', async () => {
    const restricted: Principal = {
      spaceId: 's1',
      kind: 'cma',
      scopes: [SCOPES.contentManage],
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    } as Principal;
    await expect(
      setContentTypePreview(ctx, restricted, scope, 'post', TEMPLATE),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Clearing points tokens nowhere, so it needs nothing more.
    await expect(
      setContentTypePreview(ctx, restricted, scope, 'post', null),
    ).resolves.toMatchObject({ apiId: 'post' });
  });

  it('is held to the version it read', async () => {
    const realGet = store.contentTypes.get.bind(store.contentTypes);
    const stale = await realGet(scope, 'post');
    // A revision lands between this call's read and its write.
    store.contentTypes.get = async () => {
      store.contentTypes.get = realGet;
      await updateContentType(ctx, SYSTEM_CALLER, scope, 'post', { name: 'Raced' });
      return stale;
    };
    await expect(
      setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', TEMPLATE),
    ).rejects.toBeInstanceOf(ConflictError);
    const now = await getContentType(ctx, scope, 'post');
    expect(now.name).toBe('Raced');
    expect(now.preview).toBeUndefined();
  });

  it('touches only its own scope', async () => {
    await expect(
      setContentTypePreview(ctx, SYSTEM_CALLER, other, 'post', TEMPLATE),
    ).rejects.toThrow(/not found/i);
    await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', TEMPLATE);
    await createContentType(ctx, SYSTEM_CALLER, other, post);
    expect((await getContentType(ctx, other, 'post')).preview).toBeUndefined();
  });
});
