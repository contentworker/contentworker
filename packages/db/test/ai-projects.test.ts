import { type AppContext, createSpace, setDefaultAiProject } from '@contentworker/application';
import { type AiProject, ConflictError } from '@contentworker/domain';
import { type AiReferenceExtraction, TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * AI projects on D1 (0045_ai_projects): one row per project, rewritten whole at its version's
 * compare-and-set; unique by case-folded name and holding at most one default per environment;
 * the reference extraction records claimed on their primary key; the project ids AI actions and
 * schedules store. Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-11-11T00:00:00.000Z';

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(new Date(AT)), ids: { newId: uid } };
  const spaceId = `aip-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'P', defaultLocale: 'en-US', locales: ['en-US'] });
  return { ctx, scope: { spaceId, environmentId: 'main' } };
}

const project = (over: Partial<AiProject> = {}): AiProject => ({
  id: uid(),
  name: `Project ${uid().slice(0, 8)}`,
  description: 'Shown in pickers',
  instructions: 'Say "spec sheet".',
  writer: { name: 'Northwind team', description: 'Plain and confident.' },
  reader: null,
  references: [{ assetId: 'a1', version: 2 }],
  isDefault: false,
  version: 1,
  createdAt: AT,
  createdBy: 'ed@example.com',
  updatedAt: AT,
  updatedBy: 'ed@example.com',
  ...over,
});

describe('AI projects on D1', () => {
  it('writes and reads a project whole, and lists by name', async () => {
    const { scope } = await harness();
    const b = project({ name: 'beta' });
    const a = project({
      name: 'Alpha',
      reader: { name: 'Procurement lead', description: 'Busy.' },
    });
    await store.aiProjects.save(scope, b);
    await store.aiProjects.save(scope, a);
    expect(await store.aiProjects.get(scope, a.id)).toEqual(a);
    expect((await store.aiProjects.list(scope)).map((p) => p.name)).toEqual(['Alpha', 'beta']);
    expect(await store.aiProjects.getDefault(scope)).toBeNull();
  });

  it('keeps each environment’s projects apart', async () => {
    const { scope } = await harness();
    const other = { ...scope, environmentId: 'staging' };
    const p = project();
    await store.aiProjects.save(scope, p);
    expect(await store.aiProjects.get(other, p.id)).toBeNull();
    expect(await store.aiProjects.list(other)).toEqual([]);
  });

  it('holds names unique ignoring case', async () => {
    const { scope } = await harness();
    await store.aiProjects.save(scope, project({ name: 'Northwind' }));
    await expect(store.aiProjects.save(scope, project({ name: 'NORTHWIND' }))).rejects.toThrow(
      ConflictError,
    );
  });

  it('fails a lost compare-and-set, directly and at commit', async () => {
    const { scope } = await harness();
    const p = project();
    await store.aiProjects.save(scope, p);
    await store.aiProjects.save(scope, { ...p, version: 2, instructions: 'v2' }, 1);
    await expect(
      store.aiProjects.save(scope, { ...p, version: 2, instructions: 'stale' }, 1),
    ).rejects.toThrow(TransactionConflictError);
    await expect(
      store.withTransaction(async (tx) => {
        await tx.aiProjects.save(scope, { ...p, version: 3 }, 1);
      }),
    ).rejects.toThrow(TransactionConflictError);
    await expect(store.aiProjects.delete(scope, p.id, 1)).rejects.toThrow(TransactionConflictError);
    expect((await store.aiProjects.get(scope, p.id))?.instructions).toBe('v2');
    await store.aiProjects.delete(scope, p.id, 2);
    expect(await store.aiProjects.get(scope, p.id)).toBeNull();
  });

  it('holds one default per environment, moved in one unit', async () => {
    const { ctx, scope } = await harness();
    const a = project();
    const b = project();
    await store.aiProjects.save(scope, a);
    await store.aiProjects.save(scope, b);
    const admin = { spaceId: '*', kind: 'admin' as const, scopes: ['space:admin'] };
    await setDefaultAiProject(ctx, scope, admin, a.id);
    expect((await store.aiProjects.getDefault(scope))?.id).toBe(a.id);
    await setDefaultAiProject(ctx, scope, admin, b.id);
    const after = await store.aiProjects.list(scope);
    expect(after.filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.id]);
    // Both moved a version: the one cleared and the one set.
    expect(after.find((p) => p.id === a.id)?.version).toBe(3);
    // A second default written outside the use-case is refused by the partial unique index.
    const reloaded = (await store.aiProjects.get(scope, a.id)) as AiProject;
    await expect(
      store.aiProjects.save(scope, { ...reloaded, isDefault: true, version: 4 }, 3),
    ).rejects.toThrow(ConflictError);
  });

  it('names the AI actions and schedules that store a project', async () => {
    const { scope } = await harness();
    const p = project();
    await store.aiProjects.save(scope, p);
    await store.aiActions.create(scope, {
      id: 'act-1',
      name: 'Tagline',
      promptTemplate: 'Write one',
      variables: [],
      tier: 'balanced',
      projectId: p.id,
      createdAt: AT,
    });
    await store.aiActions.create(scope, {
      id: 'act-2',
      name: 'Other',
      promptTemplate: 'x',
      variables: [],
      tier: 'balanced',
      createdAt: AT,
    });
    await store.agentSchedules.create(scope, {
      id: 'sch-1',
      workflow: 'enrich',
      cron: '0 * * * *',
      enabled: true,
      autoApply: false,
      projectId: p.id,
      nextRunAt: AT,
      createdAt: AT,
    });
    expect(await store.aiProjects.usedBy(scope, p.id)).toEqual({
      aiActions: ['act-1'],
      agentSchedules: ['sch-1'],
    });
    expect((await store.aiActions.get(scope, 'act-1'))?.projectId).toBe(p.id);
    expect((await store.aiActions.get(scope, 'act-2'))?.projectId).toBeUndefined();
    expect((await store.agentSchedules.get(scope, 'sch-1'))?.projectId).toBe(p.id);
  });
});

describe('AI reference extraction records on D1', () => {
  const record = (assetId: string, fileVersion: number): AiReferenceExtraction => ({
    assetId,
    fileVersion,
    status: 'pending',
    reason: null,
    triggeredBy: 'ed@example.com',
    updatedAt: AT,
  });

  it('claims a version once: a second claim, a redelivery, starts nothing', async () => {
    const { scope } = await harness();
    expect(await store.aiReferenceExtractions.claim(scope, record('a1', 1))).toBe(true);
    expect(await store.aiReferenceExtractions.claim(scope, record('a1', 1))).toBe(false);
    // Another version of the same asset is its own record.
    expect(await store.aiReferenceExtractions.claim(scope, record('a1', 2))).toBe(true);
  });

  it('records an outcome over the claim, and drops an asset’s records with it', async () => {
    const { scope } = await harness();
    await store.aiReferenceExtractions.claim(scope, record('a1', 1));
    await store.aiReferenceExtractions.record(scope, {
      ...record('a1', 1),
      status: 'skipped',
      reason: 'media_off',
    });
    expect(
      await store.aiReferenceExtractions.getMany(scope, [{ assetId: 'a1', version: 1 }]),
    ).toEqual([{ ...record('a1', 1), status: 'skipped', reason: 'media_off' }]);
    await store.aiReferenceExtractions.deleteForAsset(scope, 'a1');
    expect(
      await store.aiReferenceExtractions.getMany(scope, [{ assetId: 'a1', version: 1 }]),
    ).toEqual([]);
  });

  it('reads any number of versions in one statement, past the parameter cap', async () => {
    const { scope } = await harness();
    const keys = Array.from({ length: 150 }, (_, i) => ({ assetId: `a${i}`, version: 1 }));
    for (const k of keys.slice(0, 120)) {
      await store.aiReferenceExtractions.claim(scope, record(k.assetId, k.version));
    }
    const found = await store.aiReferenceExtractions.getMany(scope, keys);
    expect(found).toHaveLength(120);
    // A version not asked for isn't read: the pair is matched whole.
    expect(
      await store.aiReferenceExtractions.getMany(scope, [{ assetId: 'a1', version: 2 }]),
    ).toEqual([]);
  });

  it('keeps each environment’s records apart', async () => {
    const { scope } = await harness();
    await store.aiReferenceExtractions.claim(scope, record('a1', 1));
    const other = { ...scope, environmentId: 'staging' };
    expect(await store.aiReferenceExtractions.claim(other, record('a1', 1))).toBe(true);
    expect(
      await store.aiReferenceExtractions.getMany({ ...scope, environmentId: 'x' }, [
        { assetId: 'a1', version: 1 },
      ]),
    ).toEqual([]);
  });
});
