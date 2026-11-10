import {
  type AppContext,
  approvePromotion,
  createContentType,
  createEnvironment,
  createSpace,
  getEffectiveBlockRules,
  publishContentType,
  pushBlockCatalog,
  requestPromotion,
  SYSTEM_CALLER,
  setBlockConfig,
} from '@contentworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@contentworker/domain';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Promotions carrying the block catalog and config on D1: the pinned blocks
 * (0039_promotion_blocks) kept across the wait for approval and copied on apply, and a promotion
 * without them read as before. Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-11-09T00:00:00.000Z';

const admin: Principal = {
  spaceId: '*',
  kind: 'user',
  subject: 'admin@example.com',
  scopes: [SCOPES.contentManage, SCOPES.contentPublish, SCOPES.contentWrite],
};

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const BLOCKS = [
  { id: 'hero', name: 'Hero', fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }] },
  {
    id: 'grid',
    name: 'Grid',
    fields: [],
    slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], max: 6 }],
  },
  {
    id: 'card',
    name: 'Card',
    fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
    allowedParents: ['grid'],
  },
];
const TARGETS = [{ contentTypeApiId: 'page', field: 'body' }];
const NARROWING = {
  targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'] }],
  blocks: [{ block: 'grid', slots: { items: { max: 2, locked: true } } }],
};

async function harness(envs: readonly string[]) {
  const ctx: AppContext = { store, clock: new FixedClock(new Date(AT)), ids: { newId: uid } };
  const spaceId = `travel-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Travel', defaultLocale: 'en-US', locales: ['en-US'] });
  for (const env of envs) await createEnvironment(ctx, spaceId, env);
  const as = { ...admin, spaceId };
  const seed = async (environmentId: string) => {
    const scope = { spaceId, environmentId };
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
              {
                apiId: 'hero',
                name: 'Hero',
                fields: [field({ apiId: 'heading', type: 'Symbol' })],
              },
            ],
          },
        }),
      ],
    });
    await publishContentType(ctx, scope, 'page');
    await pushBlockCatalog(ctx, as, scope, { blocks: BLOCKS, targets: TARGETS });
    return scope;
  };
  return { ctx, spaceId, as, seed };
}

const rulesOf = async (ctx: AppContext, scope: { spaceId: string; environmentId: string }) => {
  const { targets, blocks } = await getEffectiveBlockRules(ctx, scope);
  return { targets, blocks };
};

describe('promoting blocks on D1', () => {
  it('promoted: the pinned blocks survive the wait for approval, then land in the target', async () => {
    const { ctx, spaceId, as, seed } = await harness(['staging', 'qa']);
    const staging = await seed('staging');
    const qa = await seed('qa');
    await setBlockConfig(ctx, as, staging, { expectedVersion: 0, ...NARROWING });

    const p = await requestPromotion(ctx, as, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [],
      blocks: true,
    });
    expect(p.status).toBe('awaiting_approval');
    expect((await store.promotions.get(spaceId, p.id))?.blocks).toEqual({
      catalogVersion: 1,
      configVersion: 1,
      targetCatalogVersion: 1,
      targetConfigVersion: 0,
    });

    const done = await approvePromotion(
      ctx,
      { ...as, subject: 'grace@example.com' },
      spaceId,
      p.id,
    );
    expect(done).toMatchObject({
      status: 'completed',
      blocks: { catalogVersion: 1, configVersion: 1 },
      result: { blocks: { catalog: false, config: true } },
    });
    expect(await rulesOf(ctx, qa)).toEqual(await rulesOf(ctx, staging));
  });

  it('reads a promotion with no blocks as it was', async () => {
    const { ctx, spaceId, seed } = await harness(['staging', 'qa']);
    await seed('staging');
    await seed('qa');
    await createContentType(
      ctx,
      SYSTEM_CALLER,
      { spaceId, environmentId: 'staging' },
      {
        apiId: 'note',
        name: 'Note',
        displayField: 'title',
        fields: [field({ apiId: 'title', type: 'Symbol' })],
      },
    );
    const p = await requestPromotion(ctx, { ...admin, spaceId }, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['note'],
    });
    const stored = await store.promotions.get(spaceId, p.id);
    expect(stored).not.toHaveProperty('blocks');
    expect(stored?.status).toBe('completed');
  });
});
