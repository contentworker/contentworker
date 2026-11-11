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
 * A block's `_responsive` on a field that declares no breakpoints: a copy (a restored version, a
 * migration of stored content) saves and drops it, so stored overrides never block a save; a new
 * edit that brings one is told it can't, since nothing takes it. The release before overrides
 * were kept dropped it on every save, so a rollback lands on entries that save.
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

  it('saves a copy that carries it, storing none of it, and refuses a new one', async () => {
    await expect(
      createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: body(hero('a', { lg: { size: 'xl' } })),
      }),
    ).rejects.toMatchObject({ issues: [{ code: 'override_undeclared' }] });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a')),
    });
    expect((await getEntry(ctx, scope, entry.id)).fields.body?.['en-US']).toEqual([hero('a')]);

    // Fields stored with overrides come back as a copy, and save.
    const later = body(hero('a', { lg: { size: 'xl' } }));
    const copied = await updateEntry(ctx, scope, entry.id, later, { copy: true });
    expect(copied.fields.body?.['en-US']).toEqual([hero('a')]);
    const restored = await restoreVersion(ctx, scope, entry.id, 1);
    expect(restored.fields.body?.['en-US']).toEqual([hero('a')]);
  });
});
