import { env } from 'cloudflare:workers';
import {
  type AppContext,
  consumeEvent,
  createContentType,
  createEntry,
  createSpace,
  getAiSettings,
  getSearchReindexJob,
  indexEntryEmbeddings,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setAiSettings,
} from '@contentworker/application';
import { createD1Store } from '@contentworker/db';
import { type DomainEvent, type Principal, SCOPES } from '@contentworker/domain';
import {
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
} from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';

/**
 * Turning search off and on in a space, on D1 as the engine runs it: the setting and its
 * `search.toggled` events commit in one unit; each event starts its environment's `search_reindex`
 * job, whose chunks (more than one) delete or re-embed the vectors. Every event is delivered twice,
 * as a queue may, and a toggle while a job runs supersedes it.
 */
const store = createD1Store(env.DB);
const admin = {
  kind: 'user',
  subject: 'ada@example.com',
  scopes: [SCOPES.spaceAdmin],
} as unknown as Principal;

describe('the search reindex job, in the engine', () => {
  it('deletes and re-embeds across chunks, once per event, and a toggle supersedes it', {
    timeout: 60_000,
  }, async () => {
    const ctx: AppContext = {
      store,
      clock: { now: () => new Date() },
      ids: { newId: () => crypto.randomUUID() },
    };
    const spaceId = `engine-search-${crypto.randomUUID()}`;
    await createSpace(ctx, { spaceId, name: 'Search', defaultLocale: 'en-US' });
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
    const embeddings = new LocalEmbeddingsProvider();
    const vectors = new InMemoryVectorStore();
    const rag = { embeddings, vectors };
    // Past one chunk (100 items).
    const published: string[] = [];
    for (let i = 0; i < 105; i++) {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': `note ${i}` } },
      });
      await publishEntry(ctx, scope, entry.id);
      await indexEntryEmbeddings(rag, scope, {
        entryId: entry.id,
        fields: { title: { 'en-US': `note ${i}` } },
        entryVersion: 1,
      });
      published.push(entry.id);
    }
    const indexed = async () => {
      const [probe] = await embeddings.embed(['note']);
      const hits = await vectors.query(scope, probe as number[], { topK: 500, minScore: -2 });
      return new Set(hits.map((h) => h.entryId)).size;
    };
    expect(await indexed()).toBe(105);

    const consumed = new Set<string>();
    const pending = async (type: string) => {
      const rows = await env.DB.prepare(
        "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? and json_extract(payload, '$.type') = ? order by rowid",
      )
        .bind(spaceId, type)
        .all<{ payload: string }>();
      return rows.results
        .map((r) => JSON.parse(r.payload) as DomainEvent)
        .filter((e) => !consumed.has(e.id));
    };
    const deliver = async (type: string) => {
      for (const e of await pending(type)) {
        consumed.add(e.id);
        for (let run = 0; run < 2; run++) {
          await consumeEvent(ctx, { sender: new RecordingWebhookSender(), rag }, e);
        }
      }
    };
    const turn = async (enabled: boolean) => {
      const { version } = await getAiSettings(ctx, spaceId);
      await setAiSettings(ctx, admin, spaceId, {
        expectedVersion: version,
        capabilities: { search: { enabled } },
      });
    };

    // Off: the event committed with the setting starts one job; its two chunks delete everything.
    await turn(false);
    expect(await pending('search.toggled')).toHaveLength(1);
    await deliver('search.toggled');
    const off = await getSearchReindexJob(ctx, scope);
    expect(off).toMatchObject({ status: 'running', totalItems: 105, totalChunks: 2 });
    await deliver('bulk.chunk_due');
    expect(await indexed()).toBe(0);
    expect(await getSearchReindexJob(ctx, scope)).toMatchObject({
      id: off?.id,
      status: 'completed',
      succeeded: 105,
      failed: 0,
    });

    // On, then off again before its chunks run: the second supersedes the first.
    await turn(true);
    await deliver('search.toggled');
    const on = await getSearchReindexJob(ctx, scope);
    await turn(false);
    await deliver('search.toggled');
    const offAgain = await getSearchReindexJob(ctx, scope);
    expect(offAgain?.id).not.toBe(on?.id);
    expect((await store.bulkJobs.getJob(scope, on?.id as string))?.status).toBe('cancelled');
    await deliver('bulk.chunk_due');
    expect(await indexed()).toBe(0);

    // On for good: everything published is embedded again.
    await turn(true);
    await deliver('search.toggled');
    await deliver('bulk.chunk_due');
    expect(await indexed()).toBe(105);
    expect(await getSearchReindexJob(ctx, scope)).toMatchObject({
      status: 'completed',
      succeeded: 105,
      config: { enabled: true },
    });
  });
});
