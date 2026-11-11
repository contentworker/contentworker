import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  getBlockConfig,
  pushBlockCatalog,
  SYSTEM_CALLER,
  setBlockConfig,
} from '@contentworker/application';
import {
  type BlockConfig,
  ConflictError,
  type FieldDefinition,
  ValidationError,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Block configs on D1 (0037_block_configs): one row per environment, rewritten whole at each set;
 * its version the compare-and-set a set rides with (the first set inserting, each later one
 * updating at the version it read), failing a lost race directly and at commit; isolated per
 * environment, enforced on an entry save, and cleared with its environment. Each test makes its
 * own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-11-08T00:00:00.000Z';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const config = (version: number, over: Partial<BlockConfig> = {}): BlockConfig => ({
  version,
  targets: [{ contentTypeApiId: 'page', field: 'body', locked: true }],
  blocks: [],
  updatedAt: AT,
  updatedBy: 'admin@example.com',
  ...over,
});

async function harness() {
  const clock = new FixedClock(new Date(AT));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `config-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Config', defaultLocale: 'en-US', locales: ['en-US'] });
  const scope = { spaceId, environmentId: 'main' };
  return { ctx, clock, spaceId, scope };
}

describe('block configs on D1', () => {
  it('reads nothing before the first set, then the config as written', async () => {
    const { scope } = await harness();
    expect(await store.blockConfigs.get(scope)).toBeNull();
    await store.blockConfigs.save(scope, config(1));
    expect(await store.blockConfigs.get(scope)).toEqual(config(1));
    await store.blockConfigs.save(scope, config(2, { targets: [], updatedBy: null }));
    expect(await store.blockConfigs.get(scope)).toEqual(
      config(2, { targets: [], updatedBy: null }),
    );
  });

  it('reads the config with the latest catalog version in one statement', async () => {
    const { scope } = await harness();
    expect(await store.blockConfigs.inForce(scope)).toBeNull();
    await store.blockConfigs.save(scope, config(1));
    expect(await store.blockConfigs.inForce(scope)).toEqual({ config: config(1), catalog: null });
    const catalog = (version: number) => ({
      version,
      hash: `h${version}`,
      blocks: [{ id: 'hero', name: 'Hero', fields: [] }],
      targets: [{ contentTypeApiId: 'page', field: 'body' }],
      breakpoints: [],
      changes: { added: [], changed: [], removed: [], renamed: [] },
      pushedAt: AT,
      pushedBy: null,
    });
    await store.blockCatalogs.save(scope, catalog(1));
    await store.blockCatalogs.save(scope, catalog(2));
    // Another environment's newer catalog is not this one's.
    await store.blockCatalogs.save({ ...scope, environmentId: 'other' }, catalog(3));
    const held = await store.blockConfigs.inForce(scope);
    expect(held?.config).toEqual(config(1));
    expect(held?.catalog).toMatchObject({ version: 2, hash: 'h2' });
  });

  it('keeps one environment’s config from another’s', async () => {
    const { ctx, spaceId, scope } = await harness();
    await createEnvironment(ctx, spaceId, 'staging');
    await store.blockConfigs.save(scope, config(1));
    expect(await store.blockConfigs.get({ spaceId, environmentId: 'staging' })).toBeNull();
  });

  it('refuses a version not next to the stored one: directly, and at commit inside a unit', async () => {
    const { scope } = await harness();
    await store.blockConfigs.save(scope, config(1));
    // A second first set loses on the primary key; a set from a stale read matches no row.
    await expect(store.blockConfigs.save(scope, config(1))).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(store.blockConfigs.save(scope, config(3))).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(
      store.withTransaction(async (tx) => {
        await tx.blockConfigs.save(scope, config(1, { updatedBy: 'loser' }));
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect((await store.blockConfigs.get(scope))?.updatedBy).toBe('admin@example.com');
    await store.withTransaction(async (tx) => {
      await tx.blockConfigs.save(scope, config(2, { updatedBy: 'winner' }));
    });
    expect(await store.blockConfigs.get(scope)).toMatchObject({ version: 2, updatedBy: 'winner' });
  });

  it('sets through the use-case and holds an entry save to it', async () => {
    const { ctx, scope } = await harness();
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
            variants: [{ apiId: 'x', name: 'X', fields: [field({ apiId: 'x', type: 'Symbol' })] }],
          },
        }),
      ],
    });
    await pushBlockCatalog(ctx, SYSTEM_CALLER, scope, {
      blocks: [
        {
          id: 'hero',
          name: 'Hero',
          fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }],
        },
        { id: 'quote', name: 'Quote', fields: [{ apiId: 'text', name: 'Text', type: 'Symbol' }] },
      ],
      targets: [{ contentTypeApiId: 'page', field: 'body' }],
      allowDestructive: true,
    });
    const set = await setBlockConfig(ctx, SYSTEM_CALLER, scope, {
      expectedVersion: 0,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero'] }],
      blocks: [],
    });
    expect(set.config).toMatchObject({ version: 1, updatedBy: null, updatedAt: AT });
    expect(await getBlockConfig(ctx, scope)).toEqual(set.config);
    await expect(
      setBlockConfig(ctx, SYSTEM_CALLER, scope, { expectedVersion: 0, targets: [], blocks: [] }),
    ).rejects.toThrow(ConflictError);
    const fields = (type: string) => ({
      body: { 'en-US': [{ _type: type, text: 'Q', heading: 'H' }] },
    });
    await expect(
      createEntry(ctx, scope, { contentTypeApiId: 'page', fields: fields('quote') }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: { body: { 'en-US': [{ _type: 'hero', heading: 'H' }] } },
      }),
    ).resolves.toBeDefined();
  });

  it('clears the row with its environment', async () => {
    const { ctx, clock, spaceId } = await harness();
    const env = `gone-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    await store.blockConfigs.save({ spaceId, environmentId: env }, config(1));
    await store.spaces.deleteEnvironment(spaceId, env, [], {
      id: uid(),
      spaceId,
      environmentId: env,
      at: clock.now().toISOString(),
      actor: 'test',
      action: 'environment.deleted',
      status: 200,
    });
    while ((await store.spaces.purgeEnvironmentStep(spaceId, env, 500, clock.now())) > 0) {}
    const n = await testDb
      .prepare('SELECT count(*) AS n FROM block_configs WHERE space_id = ? AND environment_id = ?')
      .bind(spaceId, env)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
