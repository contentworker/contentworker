import type { FieldDefinition } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  publishContentType,
  restoreVersion,
  SYSTEM_CALLER,
  updateEntry,
} from '../src/index';

/**
 * A block's `_responsive` before anything declares breakpoints: every save takes it and drops
 * it, a create, an edit and a copy (a restored version) alike, so content written by a later
 * release saves here and only loses its overrides.
 */

const scope = { spaceId: 'site', environmentId: 'main' };
const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const hero = (key: string, overrides?: unknown) => ({
  _type: 'hero',
  _key: key,
  size: 'md',
  ...(overrides !== undefined ? { _responsive: overrides } : {}),
});
const body = (...blocks: unknown[]) => ({ title: { 'en-US': 'Home' }, body: { 'en-US': blocks } });

describe('_responsive before breakpoints', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('r') };
    await createSpace(ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        field({ apiId: 'title', type: 'Symbol' }),
        field({
          apiId: 'body',
          type: 'Array',
          position: 1,
          items: {
            type: 'Component',
            variants: [
              { apiId: 'hero', name: 'Hero', fields: [field({ apiId: 'size', type: 'Symbol' })] },
            ],
          },
        }),
      ],
    });
    await publishContentType(ctx, scope, 'page');
  });

  it('saves a create, an edit and a copy that carry it, and stores none of it', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } })),
    });
    expect((await getEntry(ctx, scope, entry.id)).fields.body?.['en-US']).toEqual([hero('a')]);

    const edited = await updateEntry(ctx, scope, entry.id, body(hero('a', { base: 'junk' })));
    expect(edited.fields.body?.['en-US']).toEqual([hero('a')]);

    // Fields written by a later release come back as a copy, and save.
    const later = body(hero('a', { lg: { size: 'xl' } }));
    const copied = await updateEntry(ctx, scope, entry.id, later, { copy: true });
    expect(copied.fields.body?.['en-US']).toEqual([hero('a')]);
    const restored = await restoreVersion(ctx, scope, entry.id, 1);
    expect(restored.fields.body?.['en-US']).toEqual([hero('a')]);
  });
});
