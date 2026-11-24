import {
  checkMigrationSource,
  MIGRATION_DEFAULT_TOKEN_CAP,
  type MigrationRun,
} from '@contentworker/domain';
import { InMemoryMigrationStore } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * A run's token count (0054_migration_agent_tokens): a reservation decided and written by one
 * statement, an agent's own total rather than increments, and runs older than caps. Each case runs
 * on D1 and on the in-memory store, which the use-case tests stand on. Each uses its own scope.
 */
const uid = () => crypto.randomUUID();
const AT = '2026-11-24T00:00:00.000Z';
const UNTIL = '2026-11-24T00:10:00.000Z';
const AFTER = '2026-11-24T00:10:00.001Z';
const newScope = () => ({ spaceId: `tok-${uid()}`, environmentId: 'main' });

const run = (): MigrationRun => ({
  id: uid(),
  name: 'site.test',
  source: checkMigrationSource({ kind: 'sitemap', url: 'https://site.test/' }),
  status: 'clustered',
  threshold: 0.8,
  inventory: null,
  error: null,
  releaseId: null,
  clusteringHeldAt: null,
  driver: null,
  goAhead: null,
  version: 1,
  createdAt: AT,
  createdBy: null,
  updatedAt: AT,
});

const ask = (templateId: string, tokens: number, over: { seq?: number; spent?: number } = {}) => ({
  templateId,
  seq: 1,
  spent: 0,
  tokens,
  at: AT,
  until: UNTIL,
  ...over,
});

describe.each([
  ['D1', () => createD1Store(testDb).migrations],
  ['memory', () => new InMemoryMigrationStore()],
])('a run’s token count on %s', (_name, make) => {
  const store = make();
  const created = async (cap?: number) => {
    const scope = newScope();
    const r = run();
    await store.createRun(scope, r, cap === undefined ? {} : { agentTokenCap: cap });
    return { scope, id: r.id, r };
  };

  it('grants what fits, to as many as it fits, when they ask at once', async () => {
    const { scope, id, r } = await created(1_000);
    const got = await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.reserveAgentTokens(scope, id, ask(`t${i}`, 150))),
    );
    expect(got.filter((g) => g === 'granted')).toHaveLength(6);
    expect(new Set(got)).toEqual(new Set(['granted', 'wait']));
    expect(await store.agentTokens(scope, id, AT)).toEqual({
      cap: 1_000,
      spent: 0,
      reserved: 900,
      stoppedTemplateIds: [],
    });
    // To the last token.
    expect(await store.reserveAgentTokens(scope, id, ask('last', 100))).toBe('granted');
    expect(await store.reserveAgentTokens(scope, id, ask('over', 1))).toBe('wait');
    // The run itself is untouched, and its whole-row rewrite leaves the count.
    expect(await store.getRun(scope, id)).toEqual(r);
    await store.saveRun(scope, { ...r, version: 2 }, 1);
    expect(await store.agentTokens(scope, id, AT)).toMatchObject({ cap: 1_000, reserved: 1_000 });
  });

  it('holds a repeated reservation once, and settles to the agent’s own total', async () => {
    const { scope, id } = await created(1_000);
    for (let i = 0; i < 3; i++) {
      expect(await store.reserveAgentTokens(scope, id, ask('t1', 800))).toBe('granted');
    }
    const line = { templateId: 't1', seq: 1, spent: 120, at: AT };
    await store.settleAgentTokens(scope, id, line);
    await store.settleAgentTokens(scope, id, line);
    expect(await store.agentTokens(scope, id, AT)).toMatchObject({ spent: 120, reserved: 0 });
    // The next reservation says the total again, so a settlement that was lost changes nothing.
    await store.reserveAgentTokens(scope, id, ask('t1', 300, { seq: 2, spent: 400 }));
    expect(await store.agentTokens(scope, id, AT)).toMatchObject({ spent: 400, reserved: 300 });
    // One that arrives late lets go of nothing newer.
    await store.settleAgentTokens(scope, id, line);
    expect(await store.agentTokens(scope, id, AT)).toMatchObject({ spent: 400, reserved: 300 });
    expect(await store.reserveAgentTokens(scope, id, ask('t1', 10))).toBe('stale');
    // Settling an agent that has no line writes none.
    await store.settleAgentTokens(scope, id, { templateId: 'none', seq: 9, spent: 9, at: AT });
    expect((await store.agentTokens(scope, id, AT))?.spent).toBe(400);
  });

  it('tells an agent to wait for what others hold, and that it is capped by what is spent', async () => {
    const { scope, id } = await created(1_000);
    await store.reserveAgentTokens(scope, id, ask('t1', 700));
    expect(await store.reserveAgentTokens(scope, id, ask('t2', 400))).toBe('wait');
    // Never settled: past its time it is spent, not awaited.
    expect(await store.reserveAgentTokens(scope, id, { ...ask('t2', 400), at: AFTER })).toBe(
      'capped',
    );
    expect(await store.agentTokens(scope, id, AFTER)).toMatchObject({ spent: 700, reserved: 0 });
    // Asked without reserving: the same answer, its own line left out, and nothing written.
    expect(await store.askAgentTokens(scope, id, ask('t2', 400))).toBe('wait');
    expect(await store.askAgentTokens(scope, id, ask('t1', 1_000))).toBe('granted');
    expect(await store.askAgentTokens(newScope(), id, ask('t1', 1))).toBe('gone');
    // What fits beside it still goes.
    expect(await store.reserveAgentTokens(scope, id, { ...ask('t3', 300), at: AFTER })).toBe(
      'granted',
    );
    // The agent's own total counts, wherever it began.
    expect(await store.reserveAgentTokens(scope, id, ask('t4', 1, { spent: 1_000 }))).toBe(
      'capped',
    );
  });

  it('marks an agent stopped at the cap, whether or not it had a line', async () => {
    const { scope, id } = await created(1_000);
    await store.reserveAgentTokens(scope, id, ask('t1', 700));
    await store.capAgentTokens(scope, id, { templateId: 't1', seq: 1, spent: 650, at: AT });
    await store.capAgentTokens(scope, id, { templateId: 't2', seq: 1, spent: 0, at: AT });
    const now = await store.agentTokens(scope, id, AT);
    expect(now).toMatchObject({ spent: 650, reserved: 0 });
    expect([...(now?.stoppedTemplateIds ?? [])].sort()).toEqual(['t1', 't2']);
  });

  it('gives a run with no cap the default, and no run nothing', async () => {
    const { scope, id } = await created();
    expect((await store.agentTokens(scope, id, AT))?.cap).toBe(MIGRATION_DEFAULT_TOKEN_CAP);
    const all = ask('t1', MIGRATION_DEFAULT_TOKEN_CAP);
    expect(await store.reserveAgentTokens(scope, id, all)).toBe('granted');
    expect(await store.reserveAgentTokens(scope, id, ask('t2', 1))).toBe('wait');
    // Another scope sees no such run, and writes nothing for it.
    for (const elsewhere of [newScope(), { ...scope, environmentId: 'staging' }]) {
      expect(await store.agentTokens(elsewhere, id, AT)).toBeNull();
      expect(await store.reserveAgentTokens(elsewhere, id, ask('t9', 1))).toBe('gone');
      await store.capAgentTokens(elsewhere, id, { templateId: 't1', seq: 5, spent: 5, at: AT });
      await store.settleAgentTokens(elsewhere, id, { templateId: 't1', seq: 5, spent: 5, at: AT });
    }
    expect(await store.agentTokens(scope, id, AT)).toEqual({
      cap: MIGRATION_DEFAULT_TOKEN_CAP,
      spent: 0,
      reserved: MIGRATION_DEFAULT_TOKEN_CAP,
      stoppedTemplateIds: [],
    });
  });
});

describe('code deployed before the count', () => {
  it('creates and rewrites runs by its own columns, leaving the cap as it is', async () => {
    const store = createD1Store(testDb);
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r, { agentTokenCap: 400_000 });
    await testDb
      .prepare(
        `UPDATE migration_runs SET name = ?, status = ?, version = 2, updated_at = ?
        WHERE space_id = ? AND environment_id = ? AND id = ? AND version = 1`,
      )
      .bind('renamed', 'stopped', Date.parse(AT), scope.spaceId, scope.environmentId, r.id)
      .run();
    expect((await store.migrations.agentTokens(scope, r.id, AT))?.cap).toBe(400_000);
    await testDb
      .prepare(
        `INSERT INTO migration_runs (space_id, environment_id, id, name, source, status, threshold, version, created_at, updated_at)
        VALUES (?, ?, 'older', 'x', '{}', 'created', 0.8, 1, 0, 0)`,
      )
      .bind(scope.spaceId, scope.environmentId)
      .run();
    expect((await store.migrations.agentTokens(scope, 'older', AT))?.cap).toBe(
      MIGRATION_DEFAULT_TOKEN_CAP,
    );
  });
});
