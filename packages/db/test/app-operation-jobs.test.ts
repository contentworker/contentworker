import { type AppContext, createEnvironment, createSpace } from '@contentworker/application';
import type { AppOperationJob } from '@contentworker/domain';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Async plugin operation jobs on D1 (0044_app_operation_jobs): the caller snapshot and JSON input
 * and output round-trip (a `null` output stays `null`, not absent), jobs stay in their scope, the
 * sweep finds expired ones across scopes, and an environment's jobs go with it. Each test makes
 * its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

async function harness() {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `ops-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Ops', defaultLocale: 'en-US' });
  return { ctx, clock, spaceId, scope: { spaceId, environmentId: 'main' } };
}

const job = (over: Partial<AppOperationJob> = {}): AppOperationJob => ({
  id: uid(),
  plugin: 'com.example.audit',
  pluginVersion: '1.0.0',
  checksum: 'abc',
  operation: 'auditAll',
  requires: 'preview:read',
  status: 'pending',
  input: { limit: 5, tags: ['a', 'b'] },
  caller: {
    kind: 'user',
    scopes: ['preview:read', 'content:write'],
    contentGrants: [{ contentTypeApiId: 'article', actions: ['read', 'write'] }],
  },
  createdBy: 'ana@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-08T00:00:00.000Z',
  ...over,
});

describe('async operation jobs on D1', () => {
  it('round-trips a job and its outcome, newest first, in its own scope', async () => {
    const { scope, spaceId } = await harness();
    const first = job({ createdAt: '2026-01-01T00:00:00.000Z' });
    const second = job({ createdAt: '2026-01-01T00:01:00.000Z' });
    await store.appOperationJobs.create(scope, first);
    await store.appOperationJobs.create(scope, second);
    expect(await store.appOperationJobs.get(scope, first.id)).toEqual(first);
    expect((await store.appOperationJobs.list(scope, 10)).map((j) => j.id)).toEqual([
      second.id,
      first.id,
    ]);

    await store.appOperationJobs.update(scope, first.id, {
      status: 'running',
      startedAt: '2026-01-01T00:00:05.000Z',
    });
    await store.appOperationJobs.update(scope, first.id, {
      status: 'completed',
      output: null,
      completedAt: '2026-01-01T00:00:09.000Z',
    });
    const done = await store.appOperationJobs.get(scope, first.id);
    expect(done).toMatchObject({
      status: 'completed',
      output: null,
      startedAt: '2026-01-01T00:00:05.000Z',
      completedAt: '2026-01-01T00:00:09.000Z',
    });
    expect(done).toHaveProperty('output', null);
    await store.appOperationJobs.update(scope, second.id, {
      status: 'completed',
      output: { count: 3, items: [{ id: 'e1' }] },
    });
    expect((await store.appOperationJobs.get(scope, second.id))?.output).toEqual({
      count: 3,
      items: [{ id: 'e1' }],
    });

    expect(await store.appOperationJobs.countKept(scope, new Date('2026-01-02'), 10)).toBe(2);
    expect(await store.appOperationJobs.countKept(scope, new Date('2026-01-02'), 1)).toBe(1);
    expect(await store.appOperationJobs.countKept(scope, new Date('2026-01-09'), 10)).toBe(0);
    const other = { spaceId, environmentId: 'staging' };
    expect(await store.appOperationJobs.countKept(other, new Date('2026-01-02'), 10)).toBe(0);
    expect(await store.appOperationJobs.get(other, first.id)).toBeNull();
    expect(await store.appOperationJobs.list(other, 10)).toEqual([]);
  });

  it('counts active jobs in a window, and deletes expired ones across scopes in a batch', async () => {
    const a = await harness();
    const b = await harness();
    await store.appOperationJobs.create(a.scope, job({ createdAt: '2026-01-01T00:10:00.000Z' }));
    await store.appOperationJobs.create(
      a.scope,
      job({ status: 'running', createdAt: '2026-01-01T00:20:00.000Z' }),
    );
    await store.appOperationJobs.create(
      a.scope,
      job({ status: 'completed', createdAt: '2026-01-01T00:20:00.000Z' }),
    );
    const since = new Date('2026-01-01T00:05:00.000Z');
    expect(await store.appOperationJobs.countActive(a.scope, since, 10)).toBe(2);
    expect(await store.appOperationJobs.countActive(a.scope, since, 1)).toBe(1);
    expect(
      await store.appOperationJobs.countActive(a.scope, new Date('2026-01-01T00:15:00.000Z'), 10),
    ).toBe(1);
    expect(await store.appOperationJobs.countActive(b.scope, since, 10)).toBe(0);

    const old = [
      job({ expiresAt: '2025-12-01T00:00:00.000Z' }),
      job({ expiresAt: '2025-12-02T00:00:00.000Z' }),
    ];
    const live = job({ expiresAt: '2099-01-01T00:00:00.000Z' });
    await store.appOperationJobs.create(a.scope, old[0] as AppOperationJob);
    await store.appOperationJobs.create(b.scope, old[1] as AppOperationJob);
    await store.appOperationJobs.create(b.scope, live);
    // Other tests' rows share the database: delete until none expired is left.
    while ((await store.appOperationJobs.deleteExpired(new Date('2026-01-01'), 1)) > 0) {}
    expect(await store.appOperationJobs.get(a.scope, old[0]?.id ?? '')).toBeNull();
    expect(await store.appOperationJobs.get(b.scope, old[1]?.id ?? '')).toBeNull();
    expect(await store.appOperationJobs.get(b.scope, live.id)).not.toBeNull();
  });

  it('clears an environment’s jobs with it', async () => {
    const { ctx, clock, spaceId } = await harness();
    const env = `stg-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    const s = { spaceId, environmentId: env };
    await store.appOperationJobs.create(s, job());
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
    expect(await store.appOperationJobs.list(s, 10)).toEqual([]);
  });
});
