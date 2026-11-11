import {
  type AppContext,
  createSpace,
  getAiSettings,
  SYSTEM_CALLER,
  setAiSettings,
} from '@contentworker/application';
import {
  type AiSettings,
  ConflictError,
  DEFAULT_AI_SETTINGS,
  ValidationError,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * A space's AI settings on D1 (0043_space_ai_settings): one row per space, rewritten whole at each
 * set; its version the compare-and-set a set rides with (the first set inserting, each later one
 * updating at the version it read), failing a lost race; isolated per space and shared by every
 * environment. Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-11-11T00:00:00.000Z';

const settings = (version: number, over: Partial<AiSettings> = {}): AiSettings => ({
  ...DEFAULT_AI_SETTINGS,
  version,
  capabilities: {
    ...DEFAULT_AI_SETTINGS.capabilities,
    translation: { enabled: false, tier: null, guidance: null },
    drafting: { enabled: true, tier: 'fast', guidance: 'British English.\nShort sentences.' },
  },
  updatedAt: AT,
  updatedBy: 'admin@example.com',
  ...over,
});

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(new Date(AT)), ids: { newId: uid } };
  const spaceId = `ai-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'AI', defaultLocale: 'en-US', locales: ['en-US'] });
  return { ctx, spaceId };
}

describe('AI settings on D1', () => {
  it('reads nothing before the first set, then the settings as written', async () => {
    const { spaceId } = await harness();
    expect(await store.aiSettings.get(spaceId)).toBeNull();
    await store.aiSettings.save(spaceId, settings(1));
    expect(await store.aiSettings.get(spaceId)).toEqual(settings(1));
    await store.aiSettings.save(spaceId, settings(2, { updatedBy: null }));
    expect(await store.aiSettings.get(spaceId)).toEqual(settings(2, { updatedBy: null }));
  });

  it('fails a lost race: a second first set, and a set from a version no longer stored', async () => {
    const { spaceId } = await harness();
    await store.aiSettings.save(spaceId, settings(1));
    await expect(store.aiSettings.save(spaceId, settings(1))).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await store.aiSettings.save(spaceId, settings(2));
    await expect(store.aiSettings.save(spaceId, settings(2))).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    expect((await store.aiSettings.get(spaceId))?.version).toBe(2);
  });

  it('keeps each space to itself', async () => {
    const a = await harness();
    const b = await harness();
    await store.aiSettings.save(a.spaceId, settings(1));
    expect(await store.aiSettings.get(b.spaceId)).toBeNull();
  });

  it('sets through the use-case with the version as the compare-and-set', async () => {
    const { ctx, spaceId } = await harness();
    expect(await getAiSettings(ctx, spaceId)).toEqual(DEFAULT_AI_SETTINGS);
    const set = await setAiSettings(ctx, SYSTEM_CALLER, spaceId, {
      expectedVersion: 0,
      capabilities: { media: { enabled: false } },
    });
    expect(set.settings.version).toBe(1);
    expect((await getAiSettings(ctx, spaceId)).capabilities.media.enabled).toBe(false);
    await expect(
      setAiSettings(ctx, SYSTEM_CALLER, spaceId, {
        expectedVersion: 0,
        capabilities: { media: { enabled: true } },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      setAiSettings(ctx, SYSTEM_CALLER, spaceId, {
        expectedVersion: 1,
        capabilities: { media: { enabled: true, guidance: 'x'.repeat(2001) } },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('reads a capability the stored document predates as on', async () => {
    const { spaceId } = await harness();
    const { workflows: _w, ...older } = settings(1).capabilities;
    await store.aiSettings.save(spaceId, { ...settings(1), capabilities: older as never });
    const read = await store.aiSettings.get(spaceId);
    expect(read?.capabilities.workflows).toEqual({ enabled: true, tier: null, guidance: null });
    expect(read?.capabilities.translation.enabled).toBe(false);
  });
});
