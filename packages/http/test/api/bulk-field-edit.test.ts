import {
  createContentType,
  createEntry,
  entryFieldsChunkRunner,
  publishContentType,
  runBulkChunk,
} from '@contentworker/application';
import type { BulkChunkDueEvent, FieldDefinition } from '@contentworker/domain';
import type { ApiConfig } from '@contentworker/platform/config';
import type { InMemoryContentStore } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const symbol = (apiId: string, position: number): FieldDefinition =>
  ({
    apiId,
    name: apiId,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
  }) as FieldDefinition;

async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  await createContentType(wired.ctx, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [symbol('title', 0), symbol('status', 1), symbol('owner', 2)],
  });
  await publishContentType(wired.ctx, scope, 'note');
  const ids: string[] = [];
  for (const title of ['a', 'b']) {
    const { entry } = await createEntry(wired.ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': title } },
    });
    ids.push(entry.id);
  }
  const store = wired.ctx.store as InMemoryContentStore;
  /** Runs every chunk the outbox holds, as the engine's bulk consumer would. */
  const runChunks = async () => {
    for (const e of store.allEvents().filter((x) => x.type === 'bulk.chunk_due')) {
      await runBulkChunk(wired.ctx, e as BulkChunkDueEvent, {
        entryFieldsChunk: entryFieldsChunkRunner(wired.ctx),
      });
    }
  };
  const start = (body: unknown, headers: Record<string, string> = cma) =>
    app.request(`${M}/bulk/jobs/set-fields`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  /** A key whose role writes notes, with `readOnlyFields` read-only. */
  const keyFor = async (readOnlyFields: string[]) => {
    const role = await json<{ id: string }>(
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: `Notes ${readOnlyFields.join(',') || 'all'}`,
          scopes: ['content:write', 'preview:read'],
          contentGrants: [{ contentTypeApiId: 'note', actions: ['read', 'write'], readOnlyFields }],
        }),
      }),
    );
    const { token } = await json<{ token: string }>(
      await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cma', roleId: role.id }),
      }),
    );
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  return { app, store, ids, runChunks, start, keyFor };
}

describe('bulk field edit over HTTP', () => {
  it('sets a field on a selection through POST /bulk/jobs/set-fields', async () => {
    const h = await makeApp();
    const res = await h.start({
      contentTypeApiId: 'note',
      entryIds: h.ids,
      fields: { status: { 'en-US': 'reviewed' } },
    });
    expect(res.status).toBe(202);
    const job = await json<{ id: string; action: string }>(res);
    expect(job.action).toBe('set_fields');
    await h.runChunks();

    const done = await json<{ status: string; succeeded: number }>(
      await h.app.request(`${M}/bulk/jobs/${job.id}`, { headers: cma }),
    );
    expect(done).toMatchObject({ status: 'completed', succeeded: 2 });
    for (const [i, id] of h.ids.entries()) {
      expect((await h.store.entries.get(scope, id))?.fields).toEqual({
        title: { 'en-US': ['a', 'b'][i] },
        status: { 'en-US': 'reviewed' },
      });
    }
  });

  it('refuses a field the type lacks before starting, with a 422', async () => {
    const h = await makeApp();
    const res = await h.start({
      contentTypeApiId: 'note',
      entryIds: h.ids,
      fields: { colour: { 'en-US': 'red' } },
    });
    expect(res.status).toBe(422);
    expect(h.store.allEvents().some((e) => e.type === 'bulk.chunk_due')).toBe(false);
  });

  it('lets a role limited to the type start one, but not on a field it may only read', async () => {
    const h = await makeApp();
    const limited = await h.keyFor(['owner']);
    const body = (field: string) => ({
      contentTypeApiId: 'note',
      entryIds: h.ids,
      fields: { [field]: { 'en-US': 'x' } },
    });
    expect((await h.start(body('owner'), limited)).status).toBe(403);
    const ok = await h.start(body('status'), limited);
    expect(ok.status).toBe(202);
    const job = await json<{ id: string }>(ok);
    // Its report stays closed: the role has a field rule on the type, and a failure can quote a value.
    expect(
      (await h.app.request(`${M}/bulk/jobs/${job.id}/report`, { headers: limited })).status,
    ).toBe(403);
    const open = await h.keyFor([]);
    expect((await h.app.request(`${M}/bulk/jobs/${job.id}/report`, { headers: open })).status).toBe(
      200,
    );
  });
});
