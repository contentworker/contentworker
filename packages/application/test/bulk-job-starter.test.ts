import type { BulkChunkDueEvent, Principal } from '@contentworker/domain';
import { SCOPES } from '@contentworker/domain';
import type { BulkJob } from '@contentworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  actingAs,
  actingForJob,
  addMember,
  authenticate,
  authorizeBulkJob,
  authorizeJobContinues,
  createApiKey,
  createContentType,
  createEntry,
  createRole,
  ensureRolePresets,
  entryFieldsChunkRunner,
  entryTrashChunkRunner,
  getBulkJob,
  listBulkJobs,
  persistJob,
  principalForWebUser,
  revokeApiKey,
  runBulkChunk,
  SYSTEM_CALLER,
  startBulkJob,
  startSetFieldsJob,
  trashEntry,
  updateMember,
  updateRole,
} from '../src/index';

/**
 * A bulk job records who started it and checks, before each chunk, that they still could: a key
 * revoked, a person disabled or removed, a role narrowed, and the rest of the job is cancelled
 * (`starter_lost_access`) and audited, with nothing more done on their behalf. The system's jobs,
 * the deployment's own tokens and jobs written before the record keep running.
 */

const scope = { spaceId: 's1', environmentId: 'main' };
const hasher = { hash: (v: string) => `h:${v}` };
const NO_SSO = { sso: false };

async function setup(entries: number) {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('j') };
  await ensureRolePresets(ctx, 's1');
  // A second administrator keeps the last-admin guard out of the way.
  await addMember(ctx, 's1', { email: 'keeper@example.com', role: 'admin' }, 'system');
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      { apiId: 'tag', name: 'Tag', type: 'Symbol', localized: false, required: false, position: 1 },
    ],
  });
  const ids: string[] = [];
  for (let i = 0; i < entries; i++) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': `Page ${i}` } },
    });
    ids.push(entry.id);
  }
  return { ctx, store, ids };
}

/** A role holding every entry action on every type, and the key or person bound to it. */
async function bulkRole(ctx: AppContext) {
  return createRole(ctx, 's1', {
    name: 'Bulk',
    scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.contentManage],
    contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }],
  });
}

const chunkEvents = (store: InMemoryContentStore, jobId: string): BulkChunkDueEvent[] =>
  store
    .allEvents()
    .filter((e): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due' && e.jobId === jobId);

const trashDeps = (ctx: AppContext) => ({ entryTrashChunk: entryTrashChunkRunner(ctx) });

async function statusOf(ctx: AppContext, ids: readonly string[]): Promise<string[]> {
  return (await ctx.store.entries.getMany(scope, ids)).map((e) => e.entry.status);
}

describe('a bulk job checks its starter before each chunk', () => {
  it('stops a trash job when the key that started it is revoked', async () => {
    const { ctx, store, ids } = await setup(60); // two chunks of 50 and 10
    const role = await bulkRole(ctx);
    const { token, apiKey } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: role.id,
    });
    const principal = await authenticate(ctx, hasher, token);
    expect(principal.keyId).toBe(apiKey.id);
    authorizeBulkJob(principal, 'trash');
    const job = await startBulkJob(actingAs(ctx, principal), scope, {
      action: 'trash',
      entryIds: ids,
    });
    // The reference is the machinery's: a reader never sees the key's id.
    expect(job.config?.startedBy).toBeUndefined();
    expect((await listBulkJobs(ctx, scope))[0]?.config?.startedBy).toBeUndefined();

    const [first, second] = chunkEvents(store, job.id);
    expect((await runBulkChunk(ctx, first as BulkChunkDueEvent, trashDeps(ctx))).outcome).toBe(
      'processed',
    );
    await revokeApiKey(ctx, 's1', apiKey.id);
    expect((await runBulkChunk(ctx, second as BulkChunkDueEvent, trashDeps(ctx))).outcome).toBe(
      'skipped',
    );

    const stopped = await getBulkJob(ctx, scope, job.id);
    expect(stopped).toMatchObject({
      status: 'cancelled',
      succeeded: 50,
      config: { cancelReason: 'starter_lost_access' },
    });
    expect(String(stopped.config?.cancelDetail)).toMatch(/no longer works/);
    // The second chunk's entries were never touched, and its chunk never claimed.
    expect(new Set(await statusOf(ctx, ids.slice(50)))).toEqual(new Set(['draft']));
    expect(
      (await store.bulkJobs.listChunks(scope, job.id)).map((c) => [c.status, c.attempts]),
    ).toEqual([
      ['completed', 1],
      ['pending', 0],
    ]);

    // Redelivered: the job is no longer running, so nothing runs and nothing is audited again.
    await runBulkChunk(ctx, second as BulkChunkDueEvent, trashDeps(ctx));
    const audit = await store.audit.list('s1', { action: 'bulk_job.starter_lost_access' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'system',
      targetType: 'bulk_job',
      targetId: job.id,
      environmentId: 'main',
    });
  });

  it('stops a purge job when the person who started it is disabled', async () => {
    const { ctx, store, ids } = await setup(60);
    for (const id of ids) await trashEntry(ctx, scope, id);
    const role = await bulkRole(ctx);
    const member = await addMember(
      ctx,
      's1',
      { email: 'ann@example.com', role: role.id },
      'system',
    );
    const principal = await principalForWebUser(ctx, 's1', {
      sub: 'usr_ann',
      email: 'ann@example.com',
      role: 'member',
    });
    expect(principal.memberId).toBe(member.id);
    const job = await startBulkJob(actingAs(ctx, principal), scope, {
      action: 'purge',
      entryIds: ids,
    });
    const [first, second] = chunkEvents(store, job.id);
    await runBulkChunk(ctx, first as BulkChunkDueEvent, trashDeps(ctx));
    await updateMember(ctx, 's1', member.id, { disabled: true }, NO_SSO, 'system');
    await runBulkChunk(ctx, second as BulkChunkDueEvent, trashDeps(ctx));

    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'cancelled',
      config: { cancelReason: 'starter_lost_access' },
    });
    // Purged: the first 50. Kept in the trash: the rest.
    expect(await statusOf(ctx, ids.slice(0, 50))).toEqual([]);
    expect(await statusOf(ctx, ids.slice(50))).toHaveLength(10);
  });

  it('stops a publish job when the role’s grant is narrowed to some types', async () => {
    const { ctx, store, ids } = await setup(3);
    const role = await bulkRole(ctx);
    await addMember(ctx, 's1', { email: 'ann@example.com', role: role.id }, 'system');
    const principal = await principalForWebUser(ctx, 's1', {
      sub: 'usr_ann',
      email: 'ann@example.com',
      role: 'member',
    });
    const job = await startBulkJob(actingAs(ctx, principal), scope, {
      action: 'publish',
      entryIds: ids,
    });
    // `page` still publishes, but the job runs over every type and the role no longer does.
    await updateRole(
      ctx,
      's1',
      role.id,
      {
        name: 'Bulk',
        scopes: role.scopes,
        contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write', 'publish'] }],
      },
      NO_SSO,
      'system',
    );
    const [only] = chunkEvents(store, job.id);
    await runBulkChunk(ctx, only as BulkChunkDueEvent);
    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'cancelled',
      succeeded: 0,
      config: { cancelReason: 'starter_lost_access' },
    });
    expect(new Set(await statusOf(ctx, ids))).toEqual(new Set(['draft']));
  });

  it('stops a field edit when the field becomes read-only for the starter', async () => {
    const { ctx, store, ids } = await setup(3);
    const role = await bulkRole(ctx);
    const { token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: role.id,
    });
    const principal = await authenticate(ctx, hasher, token);
    const job = await startSetFieldsJob(actingAs(ctx, principal), scope, {
      contentTypeApiId: 'page',
      entryIds: ids,
      fields: { tag: { 'en-US': 'x' } },
    });
    await updateRole(
      ctx,
      's1',
      role.id,
      {
        name: 'Bulk',
        scopes: role.scopes,
        contentGrants: [
          { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], readOnlyFields: ['tag'] },
        ],
      },
      NO_SSO,
      'system',
    );
    const [only] = chunkEvents(store, job.id);
    await runBulkChunk(ctx, only as BulkChunkDueEvent, {
      entryFieldsChunk: entryFieldsChunkRunner(ctx),
    });
    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'cancelled',
      config: { cancelReason: 'starter_lost_access' },
    });
    const entries = await ctx.store.entries.getMany(scope, ids);
    expect(entries.every((e) => e.fields.tag === undefined)).toBe(true);
  });

  it('keeps running while the starter keeps their access', async () => {
    const { ctx, store, ids } = await setup(60);
    const { token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
    });
    const principal = await authenticate(ctx, hasher, token);
    const job = await startBulkJob(actingAs(ctx, principal), scope, {
      action: 'trash',
      entryIds: ids,
    });
    for (const e of chunkEvents(store, job.id)) await runBulkChunk(ctx, e, trashDeps(ctx));
    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: 60,
    });
  });

  it('keeps running the system’s jobs, the deployment’s and those started before the record', async () => {
    const { ctx, store, ids } = await setup(3);
    // The system: no principal behind the context at all.
    const system = await startBulkJob(ctx, scope, {
      action: 'trash',
      entryIds: [ids[0] as string],
    });
    // The admin token: deployment authority, which no space takes away.
    const admin: Principal = { spaceId: '*', kind: 'admin', scopes: [SCOPES.contentPublish] };
    const deployment = await startBulkJob(actingAs(ctx, admin), scope, {
      action: 'trash',
      entryIds: [ids[1] as string],
    });
    expect((await store.bulkJobs.getJob(scope, deployment.id))?.config?.startedBy).toEqual({
      kind: 'deployment',
    });
    // A row older code wrote: an actor, but no starter.
    const legacy: BulkJob = {
      id: 'legacy-job',
      action: 'trash',
      status: 'running',
      totalItems: 1,
      totalChunks: 1,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: new Date().toISOString(),
      config: { actor: 'someone-gone' },
    };
    await persistJob(
      ctx,
      scope,
      legacy,
      [
        {
          jobId: legacy.id,
          chunkId: 'c00000',
          entryIds: [ids[2] as string],
          status: 'pending',
          attempts: 0,
          failures: [],
        },
      ],
      legacy.createdAt,
    );

    for (const job of [system, deployment, legacy]) {
      for (const e of chunkEvents(store, job.id)) await runBulkChunk(ctx, e, trashDeps(ctx));
      expect((await getBulkJob(ctx, scope, job.id)).status).toBe('completed');
    }
    expect(new Set(await statusOf(ctx, ids))).toEqual(new Set(['archived']));
  });

  it('never takes a starter from what the caller sent', async () => {
    const { ctx, store, ids } = await setup(1);
    const forged: BulkJob = {
      id: 'forged-job',
      action: 'trash',
      status: 'running',
      totalItems: 1,
      totalChunks: 0,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: new Date().toISOString(),
      config: { startedBy: { kind: 'deployment' } },
    };
    const { token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
    });
    const principal = await authenticate(ctx, hasher, token);
    await persistJob(actingAs(ctx, principal), scope, forged, [], forged.createdAt);
    expect((await store.bulkJobs.getJob(scope, forged.id))?.config?.startedBy).toEqual({
      kind: 'key',
      keyId: principal.keyId,
    });
    await persistJob(ctx, scope, { ...forged, id: 'forged-2' }, [], forged.createdAt);
    expect((await store.bulkJobs.getJob(scope, 'forged-2'))?.config?.startedBy).toBeUndefined();
    expect(ids).toHaveLength(1);
  });
});

describe('a job a job starts', () => {
  it('is started by the same starter (a clone’s create job, after its prepare job)', async () => {
    const { ctx, store, ids } = await setup(1);
    const { token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
    });
    const principal = await authenticate(ctx, hasher, token);
    const first = await startBulkJob(actingAs(ctx, principal), scope, {
      action: 'trash',
      entryIds: ids,
    });
    const stored = (await store.bulkJobs.getJob(scope, first.id)) as BulkJob;
    // The consumer's context has no principal; acting for the job, it starts jobs as its starter.
    const second = await startBulkJob(actingForJob(ctx, stored), scope, {
      action: 'restore',
      entryIds: ids,
    });
    expect((await store.bulkJobs.getJob(scope, second.id))?.config?.startedBy).toEqual({
      kind: 'key',
      keyId: principal.keyId,
    });
  });
});

describe('what a starter needs to keep running a job', () => {
  const job = (action: BulkJob['action'], config?: BulkJob['config']): BulkJob => ({
    id: 'j',
    action,
    status: 'running',
    totalItems: 1,
    totalChunks: 1,
    completedChunks: 0,
    succeeded: 0,
    failed: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(config ? { config } : {}),
  });
  const key = (scopes: string[], contentGrants?: Principal['contentGrants']): Principal => ({
    spaceId: 's1',
    kind: 'cma',
    scopes,
    ...(contentGrants ? { contentGrants } : {}),
  });

  it('asks for the start route’s scope in the job’s space', () => {
    expect(() =>
      authorizeJobContinues(key([SCOPES.assetsWrite]), job('asset_move'), 's1'),
    ).not.toThrow();
    expect(() =>
      authorizeJobContinues(key([SCOPES.assetsWrite]), job('asset_publish'), 's1'),
    ).toThrow();
    expect(() => authorizeJobContinues(key([SCOPES.contentPublish]), job('trash'), 's2')).toThrow();
    expect(() =>
      authorizeJobContinues(key([SCOPES.contentWrite]), job('import', { kind: 'snapshot' }), 's1'),
    ).toThrow();
  });

  it('asks for write on the type an import writes into', () => {
    const grants = [{ contentTypeApiId: 'post', actions: ['read', 'write'] as const }];
    expect(() =>
      authorizeJobContinues(
        key([SCOPES.contentWrite], grants),
        job('import', { contentTypeApiId: 'post' }),
        's1',
      ),
    ).not.toThrow();
    expect(() =>
      authorizeJobContinues(
        key([SCOPES.contentWrite], grants),
        job('import', { contentTypeApiId: 'page' }),
        's1',
      ),
    ).toThrow();
  });
});
