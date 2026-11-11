import { env } from 'cloudflare:workers';
import {
  type AppContext,
  actingAs,
  authenticate,
  consumeEvent,
  createApiKey,
  createContentType,
  createEntry,
  createRole,
  createSpace,
  getBulkJob,
  publishContentType,
  revokeApiKey,
  SYSTEM_CALLER,
  startBulkJob,
} from '@contentworker/application';
import { createD1Store } from '@contentworker/db';
import { type BulkChunkDueEvent, type DomainEvent, SCOPES } from '@contentworker/domain';
import { RecordingWebhookSender } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';

/**
 * A trash job as the engine runs it on D1, its key revoked between chunks: the first chunk trashes
 * its entries, the second finds the starter gone and cancels the job (`starter_lost_access`)
 * without claiming, and its entries stay. Every event is delivered twice, as a queue may: the
 * redelivered stop does nothing more, and the audit row is written once.
 */
const store = createD1Store(env.DB);
const hasher = { hash: (v: string) => `h:${v}` };

async function chunkEvents(spaceId: string): Promise<BulkChunkDueEvent[]> {
  const rows = await env.DB.prepare(
    "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? and json_extract(payload, '$.type') = 'bulk.chunk_due' order by rowid",
  )
    .bind(spaceId)
    .all<{ payload: string }>();
  return rows.results.map((r) => JSON.parse(r.payload) as BulkChunkDueEvent);
}

describe('a bulk job whose starter loses access, in the engine', () => {
  it('stops before the next chunk and audits it once', { timeout: 20_000 }, async () => {
    const ctx: AppContext = {
      store,
      clock: { now: () => new Date() },
      ids: { newId: () => crypto.randomUUID() },
    };
    const spaceId = `engine-starter-${crypto.randomUUID()}`;
    await createSpace(ctx, { spaceId, name: 'Starter', defaultLocale: 'en-US' });
    const scope = { spaceId, environmentId: 'main' };
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 0,
        },
      ],
    });
    await publishContentType(ctx, scope, 'note');
    const ids: string[] = [];
    // Past one chunk (50).
    for (let i = 0; i < 55; i++) {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': `n${i}` } },
      });
      ids.push(entry.id);
    }
    const role = await createRole(ctx, spaceId, {
      name: 'Bulk',
      scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }],
    });
    const { apiKey, token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId,
      kind: 'cma',
      roleId: role.id,
    });
    const principal = await authenticate(ctx, hasher, token);
    const job = await startBulkJob(actingAs(ctx, principal), scope, {
      action: 'trash',
      entryIds: ids,
    });

    const sender = new RecordingWebhookSender();
    const [first, second] = await chunkEvents(spaceId);
    for (let run = 0; run < 2; run++) {
      await consumeEvent(ctx, { sender }, first as DomainEvent);
    }
    await revokeApiKey(ctx, spaceId, apiKey.id);
    for (let run = 0; run < 2; run++) {
      await consumeEvent(ctx, { sender }, second as DomainEvent);
    }

    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'cancelled',
      succeeded: 50,
      config: { cancelReason: 'starter_lost_access' },
    });
    const statuses = (await store.entries.getMany(scope, ids)).map((e) => [
      e.entry.id,
      e.entry.status,
    ]);
    const archived = new Set(ids.slice(0, 50));
    for (const [id, status] of statuses) {
      expect(status).toBe(archived.has(id as string) ? 'archived' : 'draft');
    }
    expect((await store.bulkJobs.listChunks(scope, job.id)).map((c) => c.status)).toEqual([
      'completed',
      'pending',
    ]);
    const audit = await store.audit.list(spaceId, { action: 'bulk_job.starter_lost_access' });
    expect(audit.map((a) => a.targetId)).toEqual([job.id]);
  });
});
