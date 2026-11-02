import type { FieldDefinition } from '@contentworker/domain';
import type { DeliveryReadRequest } from '@contentworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEnvironment,
  createSpace,
  deliveryReads,
  listDeliveredRoutes,
  publishContentType,
  updateContentType,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

let store: InMemoryContentStore;
let ctx: AppContext;
/** Every request the store's batched read received, in order. */
let sent: DeliveryReadRequest[];

const defineType = async (
  apiId: string,
  urlPattern: string | undefined,
  opts: { publish?: boolean; at?: typeof scope } = {},
) => {
  const at = opts.at ?? scope;
  await createContentType(ctx, at, {
    apiId,
    name: apiId,
    displayField: 'title',
    ...(urlPattern !== undefined ? { urlPattern } : {}),
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'slug', type: 'Slug', position: 1 }),
    ],
  });
  if (opts.publish !== false) await publishContentType(ctx, at, apiId);
};

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('t') };
  await createSpace(ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
  sent = [];
  const inner = store.delivery.read;
  (store as { delivery: typeof store.delivery }).delivery = {
    read: async (s, request) => {
      sent.push(request);
      return inner(s, request);
    },
  };
});

describe('listDeliveredRoutes', () => {
  it('lists published types with a URL pattern, by content type', async () => {
    await defineType('page', '/{slug}');
    await defineType('article', '/blog/{slug}');
    await defineType('author', undefined);
    await defineType('event', '/events/{slug}', { publish: false });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'article', urlPattern: '/blog/{slug}' },
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it('keeps the published route through a revision, and moves it only on a publish', async () => {
    await defineType('article', '/blog/{slug}');
    const blog = [{ contentType: 'article', urlPattern: '/blog/{slug}' }];
    // An unpublished revision, of the pattern or of anything else, leaves the route alone.
    await updateContentType(ctx, scope, 'article', { urlPattern: '/news/{slug}' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual(blog);
    await updateContentType(ctx, scope, 'article', { name: 'Articles' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual(blog);
    await publishContentType(ctx, scope, 'article');
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'article', urlPattern: '/news/{slug}' },
    ]);
    // Clearing the pattern is a revision too: the route goes only with the publish.
    await updateContentType(ctx, scope, 'article', { urlPattern: null });
    expect(await listDeliveredRoutes(ctx, scope)).toHaveLength(1);
    await publishContentType(ctx, scope, 'article');
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([]);
  });

  it('serves a pattern added to a published type only once it is published', async () => {
    await defineType('event', undefined);
    await updateContentType(ctx, scope, 'event', { urlPattern: '/events/{slug}' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([]);
    await publishContentType(ctx, scope, 'event');
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'event', urlPattern: '/events/{slug}' },
    ]);
  });

  it('leaves out the types the caller may not read', async () => {
    await defineType('page', '/{slug}');
    await defineType('article', '/blog/{slug}');
    expect(await listDeliveredRoutes(ctx, scope, { readable: (t) => t === 'page' })).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it('answers each environment with its own types', async () => {
    await defineType('page', '/{slug}');
    await createEnvironment(ctx, 'site', 'staging');
    await defineType('article', '/blog/{slug}', { at: staging });
    expect((await listDeliveredRoutes(ctx, scope)).map((r) => r.contentType)).toEqual(['page']);
    expect((await listDeliveredRoutes(ctx, staging)).map((r) => r.contentType)).toContain(
      'article',
    );
    expect(await listDeliveredRoutes(ctx, { spaceId: 'other', environmentId: 'main' })).toEqual([]);
  });

  it('reuses content types the request already read', async () => {
    await defineType('page', '/{slug}');
    const reads = deliveryReads(ctx);
    await reads.read(scope, { config: true, contentTypes: true });
    expect(await listDeliveredRoutes(ctx, scope, { reads })).toHaveLength(1);
    expect(sent).toEqual([{ config: true, contentTypes: true }]);
  });
});
