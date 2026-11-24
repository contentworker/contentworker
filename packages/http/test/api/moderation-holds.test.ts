import {
  createContentType,
  createEntry,
  getEntry,
  holdEntryForModeration,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };
type Json = Record<string, unknown>;

/** The app over its fakes, with a post and a page each held by moderation. */
async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const ctx = wired.ctx;
  const held: Record<string, string> = {};
  for (const apiId of ['heldpost', 'heldpage']) {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId,
      name: apiId,
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
      ],
    });
    await publishContentType(ctx, scope, apiId);
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: apiId,
      fields: { title: { 'en-US': `Flagged ${apiId}` } },
    });
    await publishEntry(ctx, scope, entry.id);
    await holdEntryForModeration(ctx, scope, entry.id, { flags: ['hate'] });
    held[apiId] = entry.id;
  }
  const call = async (method: string, path: string, body?: unknown, headers = admin) => {
    const res = await app.request(`${M}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  };
  const holdOf = async (entryId: string) =>
    ((await call('GET', `/moderation-holds?entryId=${entryId}`)).body.items as Json[])[0]
      ?.id as string;
  /** A key for a role that may do `actions` on `heldpost` only. */
  const roleKey = async (actions: string[]) => {
    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: `Posts ${actions.join(' ')}`,
        scopes: ['preview:read', 'content:write', 'content:publish'],
        contentGrants: [{ contentTypeApiId: 'heldpost', actions }],
      }),
    });
    const roleId = ((await role.json()) as Json).id;
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId }),
    });
    const token = ((await key.json()) as Json).token;
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  return { app, ctx, held, call, holdOf, roleKey };
}

describe('moderation hold routes', () => {
  it('lists open holds, counted in Approvals, for the types the caller may read', async () => {
    const { call, held, roleKey } = await makeApp();
    const open = await call('GET', '/moderation-holds?status=open', undefined, cpa);
    expect(open.status).toBe(200);
    expect((open.body.items as Json[]).map((h) => h.entryId).sort()).toEqual(
      [held.heldpost, held.heldpage].sort(),
    );
    expect((open.body.items as Json[])[0]).toMatchObject({ status: 'open', flags: ['hate'] });
    expect((await call('GET', '/approvals/count', undefined, cpa)).body).toMatchObject({
      moderationHolds: 2,
      total: 2,
    });
    const reader = await roleKey(['read']);
    const mine = await call('GET', '/moderation-holds?status=open', undefined, reader);
    expect((mine.body.items as Json[]).map((h) => h.entryId)).toEqual([held.heldpost]);
    expect((await call('GET', '/approvals/count', undefined, reader)).body).toMatchObject({
      moderationHolds: 1,
    });
  });

  it('republishes the held version, recording who and why, once', async () => {
    const { app, ctx, call, held, holdOf } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    const res = await call('POST', `/moderation-holds/${id}/republish`, { note: 'Satire' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      published: true,
      hold: { status: 'republished', decidedBy: 'admin-token', note: 'Satire' },
    });
    expect((await getEntry(ctx, scope, held.heldpost ?? '')).entry.publishedVersion).toBe(1);
    // A second decision on the same hold is a conflict, whichever way it goes.
    expect((await call('POST', `/moderation-holds/${id}/republish`)).status).toBe(409);
    expect((await call('POST', `/moderation-holds/${id}/keep`)).status).toBe(409);
    // The request is in the audit trail, naming the hold.
    const audit = await app.request('/spaces/s1/audit-log?targetType=moderation_hold', {
      headers: admin,
    });
    const rows = ((await audit.json()) as { items: Json[] }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'POST /spaces/:space/environments/:env/moderation-holds/:id/republish',
      targetId: id,
      actor: 'admin-token',
    });
  });

  it('keeps an entry unpublished, and 404s a hold that never was', async () => {
    const { ctx, call, held, holdOf } = await makeApp();
    const id = await holdOf(held.heldpage ?? '');
    const res = await call('POST', `/moderation-holds/${id}/keep`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ published: false, hold: { status: 'kept' } });
    expect((await getEntry(ctx, scope, held.heldpage ?? '')).entry.publishedVersion).toBeNull();
    expect((await call('POST', '/moderation-holds/nope/keep')).status).toBe(404);
  });

  it('refuses a republish once the entry was edited, leaving the hold open', async () => {
    const { call, held, holdOf } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    await call('PUT', `/entries/${held.heldpost}`, { fields: { title: { 'en-US': 'Edited' } } });
    const res = await call('POST', `/moderation-holds/${id}/republish`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/edited after moderation held it/);
    expect((await call('GET', `/moderation-holds?entryId=${held.heldpost}`)).body).toMatchObject({
      items: [{ status: 'open' }],
    });
  });

  it('needs content:publish, and publish on the held entry’s type', async () => {
    const { call, held, holdOf, roleKey } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    expect((await call('POST', `/moderation-holds/${id}/republish`, {}, cpa)).status).toBe(403);
    const writer = await roleKey(['read', 'write']);
    expect((await call('POST', `/moderation-holds/${id}/republish`, {}, writer)).status).toBe(403);
    expect((await call('POST', `/moderation-holds/${id}/keep`, {}, writer)).status).toBe(403);
    const publisher = await roleKey(['read', 'write', 'publish']);
    // Publish on posts says nothing about pages.
    const page = await holdOf(held.heldpage ?? '');
    expect((await call('POST', `/moderation-holds/${page}/keep`, {}, publisher)).status).toBe(403);
    expect((await call('POST', `/moderation-holds/${id}/keep`, {}, publisher)).status).toBe(200);
  });

  it('documents the routes and the count in the OpenAPI document', async () => {
    const { app } = await makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const base = '/spaces/{space}/environments/{env}/moderation-holds';
    expect(spec.paths[base]?.get?.tags).toEqual(['AI & agents']);
    expect(spec.paths[`${base}/{id}/republish`]?.post).toBeDefined();
    expect(spec.paths[`${base}/{id}/keep`]?.post).toBeDefined();
  });
});
