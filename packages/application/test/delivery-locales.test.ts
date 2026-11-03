import {
  type FieldDefinition,
  ForbiddenError,
  NotFoundError,
  type Principal,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  consumeEvent,
  createContentType,
  createEntry,
  createSpace,
  createTag,
  epochTag,
  getLocaleSettings,
  getPreviewEntry,
  getPublishedEntry,
  listDeliveredSitemap,
  listDeliveredTags,
  listPublishedEntries,
  publishContentType,
  publishEntry,
  setLocaleSettings,
} from '../src/index';

/**
 * Delivery locales: a locale an editor turns off stays editable and previewable, and Delivery
 * stops serving it (404 when named, skipped by fallbacks, left out of all-locale responses and
 * the sitemap's alternates), in every environment of the space.
 */
const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };
const other = { spaceId: 'other', environmentId: 'main' };
const admin: Principal = { spaceId: 'site', kind: 'cma', scopes: Object.values(SCOPES) };
const editor: Principal = { spaceId: 'site', kind: 'cma', scopes: [SCOPES.contentWrite] };

let store: InMemoryContentStore;
let ctx: AppContext;

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({ name: over.apiId, localized: true, required: false, position: 0, ...over }) as FieldDefinition;

async function seed(at = scope) {
  await createContentType(ctx, at, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    urlPattern: '/{locale}/{slug}',
    fields: [field({ apiId: 'title', type: 'Symbol' }), field({ apiId: 'slug', type: 'Slug' })],
  });
  await publishContentType(ctx, at, 'page');
  const { entry } = await createEntry(ctx, at, {
    contentTypeApiId: 'page',
    fields: {
      title: { en: 'Hello', fr: 'Bonjour', 'fr-CA': 'Allô' },
      slug: { en: 'hello', fr: 'bonjour' },
    },
  });
  await publishEntry(ctx, at, entry.id);
  return entry.id;
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('l') };
  for (const spaceId of ['site', 'other']) {
    await createSpace(ctx, {
      spaceId,
      name: spaceId,
      defaultLocale: 'en',
      locales: ['en', 'fr', 'fr-CA', 'ar'],
      fallbacks: { 'fr-CA': 'fr', fr: 'en' },
      environments: ['main', 'staging'],
    });
  }
});

describe('locale settings', () => {
  it('resolves every locale: delivered unless turned off, direction from the language', async () => {
    const view = await getLocaleSettings(ctx, scope);
    expect(view.localeSettings).toEqual({
      en: { delivered: true, direction: 'ltr' },
      fr: { delivered: true, direction: 'ltr' },
      'fr-CA': { delivered: true, direction: 'ltr' },
      ar: { delivered: true, direction: 'rtl' },
    });
  });

  it('changes the named locales only, with one event for the purge, and for space admins', async () => {
    await setLocaleSettings(ctx, admin, scope, { ar: { direction: 'ltr' } });
    const view = await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    expect(view.localeSettings.fr).toEqual({ delivered: false, direction: 'ltr' });
    expect(view.localeSettings.ar).toEqual({ delivered: true, direction: 'ltr' });
    const events = store.allEvents().filter((e) => e.type === 'space_locales.changed');
    expect(events.map((e) => ('undelivered' in e ? e.undelivered : null))).toEqual([[], ['fr']]);

    await expect(setLocaleSettings(ctx, editor, scope, { fr: {} })).rejects.toThrow(ForbiddenError);
    await expect(
      setLocaleSettings(ctx, admin, scope, { en: { delivered: false } }),
    ).rejects.toThrow(ValidationError);
    // Another space is untouched.
    expect((await getLocaleSettings(ctx, other)).localeSettings.fr?.delivered).toBe(true);
  });
});

describe('a locale settings change', () => {
  it('evicts what every environment of the space cached, once, even when delivered again', async () => {
    const cache = new InMemoryCache();
    for (const environmentId of ['main', 'staging']) {
      await cache.set(`render:${environmentId}`, 'cached', {
        tags: [epochTag({ spaceId: 'site', environmentId })],
      });
    }
    await cache.set('render:other', 'cached', { tags: [epochTag(other)] });
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const event = store.allEvents().find((e) => e.type === 'space_locales.changed');
    const deps = { sender: new RecordingWebhookSender(), cache };
    await consumeEvent(ctx, deps, event as never);
    expect(await cache.get('render:main')).toBeNull();
    expect(await cache.get('render:staging')).toBeNull();
    expect(await cache.get('render:other')).toBe('cached');
    // Redelivered: nothing more to evict, and nothing fails.
    await consumeEvent(ctx, deps, event as never);
  });
});

describe('Delivery with a locale turned off', () => {
  it('refuses the locale by name, skips it in fallbacks and leaves it out of every map', async () => {
    const id = await seed();
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });

    await expect(getPublishedEntry(ctx, scope, id, { locale: 'fr' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      listPublishedEntries(ctx, scope, { contentTypeApiId: 'page' }, { locale: 'fr' }),
    ).rejects.toThrow(NotFoundError);
    // fr-CA falls back past fr to en: the fr values are never reached.
    const canadian = await getPublishedEntry(ctx, scope, id, { locale: 'fr-CA' });
    expect(canadian.fields).toEqual({ title: 'Allô', slug: 'hello' });
    // All locales: fr is not among them.
    const all = await getPublishedEntry(ctx, scope, id);
    expect(all.fields.title).toEqual({ en: 'Hello', 'fr-CA': 'Allô' });
    // A locale the space doesn't have resolves as it always has.
    expect((await getPublishedEntry(ctx, scope, id, { locale: 'de' })).fields.title).toBe('Hello');

    // Editors still write and preview it.
    expect((await getPreviewEntry(ctx, scope, id, { locale: 'fr' })).fields.title).toBe('Bonjour');
  });

  it('applies in every environment of the space, and to the sitemap’s alternates', async () => {
    await seed();
    const elsewhere = await seed(staging);
    const before = await listDeliveredSitemap(ctx, staging);
    expect(before.items[0]?.urls).toContainEqual({ path: '/fr/bonjour', locale: 'fr' });
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const after = await listDeliveredSitemap(ctx, staging);
    expect(after.items.map((e) => e.entryId)).toEqual([elsewhere]);
    // fr-CA's slug no longer falls back to fr's: its path is en's slug under its own locale.
    expect(after.items[0]?.urls).toEqual([
      { path: '/en/hello', locale: 'en' },
      { path: '/fr-CA/hello', locale: 'fr-CA' },
      { path: '/ar/hello', locale: 'ar' },
    ]);
  });

  it('leaves the locale out of taxonomy labels and refuses it by name there too', async () => {
    await createTag(ctx, scope, { name: 'News', labels: { fr: 'Actualités', ar: 'أخبار' } });
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    const [tag] = await listDeliveredTags(ctx, scope);
    expect(tag?.labels).toEqual({ en: 'News', ar: 'أخبار' });
    await expect(listDeliveredTags(ctx, scope, { locale: 'fr' })).rejects.toThrow(NotFoundError);
  });
});
