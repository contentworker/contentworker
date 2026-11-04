import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createMenu,
  createSpace,
  deliveryReads,
  getDeliveredMenu,
  listDeliveredRoutes,
  listDeliveredSitemap,
  mergeEnvironments,
  publishContentType,
  publishEntry,
  updateContentType,
} from '@contentworker/application';
import type { FieldDefinition } from '@contentworker/domain';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * What Delivery should serve while a live type has an unpublished revision, on D1: the definition
 * as last published, whatever the row's draft says. `it.fails` because it doesn't yet: the row
 * holds one definition, so the published one is overwritten by the draft save. Each turns red when
 * Delivery gets a published definition to read; drop the `.fails` then. Each test makes its own
 * space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
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
const definition = { apiId: 'page', name: 'Page', displayField: 'title', fields };

/** A published `page` at `/{slug}` with one published entry, in a menu. */
async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `ct-draft-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Draft', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, scope, { ...definition, urlPattern: '/{slug}' });
  await publishContentType(ctx, scope, 'page');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'page',
    fields: { title: { 'en-US': 'About' }, slug: { 'en-US': 'about' } },
  });
  await publishEntry(ctx, scope, entry.id);
  await createMenu(ctx, scope, {
    handle: 'main',
    name: 'Main',
    items: [{ id: 'about', link: { type: 'entry', entryId: entry.id } }],
  });
  return { ctx, scope };
}

describe('a draft revision of a live content type on D1', () => {
  it.fails('leaves Delivery’s definition as last published', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, scope, 'page', {
      fields: [...fields, field('subtitle', 'Symbol', 2)],
    });
    const { contentTypes = [] } = await deliveryReads(ctx).read(scope, { contentTypes: true });
    expect(contentTypes.find((t) => t.apiId === 'page')?.fields.map((f) => f.apiId)).toEqual([
      'title',
      'slug',
    ]);
  });

  it.fails('keeps the type in the routes', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, scope, 'page', { name: 'Pages' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it.fails('keeps the type’s entries in the sitemap', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, scope, 'page', { name: 'Pages' });
    expect((await listDeliveredSitemap(ctx, scope)).items).toHaveLength(1);
  });

  it.fails('keeps the entry’s URL in a menu', async () => {
    const { ctx, scope } = await harness();
    expect((await getDeliveredMenu(ctx, scope, 'main')).items[0]).toMatchObject({ url: '/about' });
    await updateContentType(ctx, scope, 'page', { name: 'Pages' });
    expect((await getDeliveredMenu(ctx, scope, 'main')).items[0]).toMatchObject({ url: '/about' });
  });

  it.fails('keeps serving the URL pattern as last published', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, scope, 'page', { urlPattern: '/pages/{slug}' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it.fails('keeps a live target routed through a merge of the source’s draft', async () => {
    const { ctx, scope } = await harness();
    await createEnvironment(ctx, scope.spaceId, 'staging');
    const staging = { ...scope, environmentId: 'staging' };
    await createContentType(ctx, staging, { ...definition, urlPattern: '/{slug}' });
    await mergeEnvironments(ctx, scope.spaceId, 'staging', 'main', { contentTypes: ['page'] });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });
});
