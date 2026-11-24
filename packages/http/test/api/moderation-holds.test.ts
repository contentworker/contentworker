import {
  addMember,
  createContentType,
  createEntry,
  createRole,
  findMemberForSignIn,
  getEntry,
  holdEntryForModeration,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
import { principalTarget, signPrincipal } from '@contentworker/security/principal';
import type { InMemoryContentStore } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { createApiHasher } from '../../src/api/auth';
import { testConfig } from './config';
import { wire } from './wire';

const KEY = 'test-principal-key-0123456789abcdef';
const config: ApiConfig = testConfig({ principalKeys: [KEY] });

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };
type Json = Record<string, unknown>;
type Headers = Record<string, string>;

type Who = { sub: string; email: string; name: string; role: 'admin' | 'member' };
const who = (sub: string): Who => ({ sub, email: `${sub}@example.com`, name: sub, role: 'member' });
/** A person on the team as an editor (publishes everything), and one whose role hides `related`. */
const editor = who('editor');
const blind = who('blind');

/**
 * The app over its fakes, with a post and a page each held by moderation, and the people and
 * tokens that decide them.
 */
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
        {
          apiId: 'related',
          name: 'Related',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
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
  const noRelated = await createRole(ctx, 's1', {
    name: 'No related',
    scopes: ['preview:read', 'content:write', 'content:publish'],
    contentGrants: [
      { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], deniedFields: ['related'] },
    ],
  } as Parameters<typeof createRole>[2]);
  for (const [person, role] of [
    [editor, 'editor'],
    [blind, noRelated.id],
  ] as const) {
    await addMember(ctx, 's1', { email: person.email, role }, 'system');
    await findMemberForSignIn(ctx, 's1', person.sub, person.email);
  }
  // A person's bearers: tokens they handed to programs, with every scope Republish needs.
  const store = ctx.store as InMemoryContentStore;
  const hasher = createApiHasher(config.tokenPepper);
  const bearer = (issuance: 'oauth' | 'pat', token: string, spaceId = 's1'): Headers => {
    store.seedApiKey({
      id: `key-${token}`,
      spaceId,
      kind: 'cma',
      hashedToken: hasher.hash(token),
      scopes: ['preview:read', 'content:write', 'content:publish'],
      revoked: false,
      issuance,
      subject: editor.sub,
      ...(issuance === 'oauth' ? { clientId: 'client-1' } : {}),
    });
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  const call = async (method: string, path: string, body?: unknown, headers: Headers = admin) => {
    const res = await app.request(`${M}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  };
  /** A request from a person signed in to the admin, as the web Worker signs it. */
  const as = async (person: Who, method: string, path: string, body?: unknown) =>
    call(method, path, body, {
      'Content-Type': 'application/json',
      'x-cw-principal': await signPrincipal(
        KEY,
        person,
        principalTarget(method, new URL(`${M}${path}`, 'http://x').pathname),
      ),
    });
  const holdOf = async (entryId: string) =>
    ((await call('GET', `/moderation-holds?entryId=${entryId}`)).body.items as Json[])[0]
      ?.id as string;
  const isOpen = async (entryId: string) =>
    ((await call('GET', `/moderation-holds?entryId=${entryId}`)).body.items as Json[])[0]
      ?.status === 'open';
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
  return { app, ctx, store, held, call, as, holdOf, isOpen, roleKey, bearer };
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

  it('republishes for a signed-in person, recording who and why, once', async () => {
    const { app, ctx, as, held, holdOf } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    const res = await as(editor, 'POST', `/moderation-holds/${id}/republish`, { note: 'Satire' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      published: true,
      hold: { status: 'republished', decidedBy: 'editor', note: 'Satire' },
    });
    expect((await getEntry(ctx, scope, held.heldpost ?? '')).entry.publishedVersion).toBe(1);
    // A second decision on the same hold is a conflict, whichever way it goes.
    expect((await as(editor, 'POST', `/moderation-holds/${id}/republish`)).status).toBe(409);
    expect((await as(editor, 'POST', `/moderation-holds/${id}/keep`)).status).toBe(409);
    // The request is in the audit trail, naming the hold.
    const audit = await app.request('/spaces/s1/audit-log?targetType=moderation_hold', {
      headers: admin,
    });
    const rows = ((await audit.json()) as { items: Json[] }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'POST /spaces/:space/environments/:env/moderation-holds/:id/republish',
      targetId: id,
      actor: 'editor',
    });
  });

  it('refuses Republish to every token with content:publish, leaving the hold open', async () => {
    const { call, held, holdOf, isOpen, bearer, ctx } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
    const tokens: Record<string, Headers> = {
      'a CMA key': cma,
      'the admin token': admin,
      'an OAuth token': bearer('oauth', 'oauth-token'),
      'a personal access token': bearer('pat', 'pat-token'),
    };
    for (const [name, headers] of Object.entries(tokens)) {
      const res = await call('POST', `/moderation-holds/${id}/republish`, {}, headers);
      expect(res.status, name).toBe(403);
      expect(JSON.stringify(res.body), name).toMatch(/person signed in to the admin/);
      expect(res.body, name).toMatchObject({ error: { details: { reason: 'person_required' } } });
    }
    expect(await isOpen(held.heldpost ?? '')).toBe(true);
    expect((await getEntry(ctx, scope, held.heldpost ?? '')).entry.publishedVersion).toBeNull();
    // Keeping it unpublished stays open to a token.
    const kept = await call(
      'POST',
      `/moderation-holds/${id}/keep`,
      {},
      tokens['a personal access token'],
    );
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
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
    const { call, as, held, holdOf, isOpen } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    await call('PUT', `/entries/${held.heldpost}`, { fields: { title: { 'en-US': 'Edited' } } });
    const res = await as(editor, 'POST', `/moderation-holds/${id}/republish`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/edited after moderation held it/);
    expect(await isOpen(held.heldpost ?? '')).toBe(true);
  });

  it('never names a field the person’s role can’t read in a republish refusal', async () => {
    const { ctx, store, as, holdOf } = await makeApp();
    // The held post links an entry that is later removed for good.
    const { entry: target } = await createEntry(ctx, scope, {
      contentTypeApiId: 'heldpage',
      fields: { title: { 'en-US': 'Target' } },
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'heldpost',
      fields: {
        title: { 'en-US': 'Linked' },
        related: { 'en-US': { id: target.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, entry.id);
    await holdEntryForModeration(ctx, scope, entry.id, { flags: ['hate'] });
    await store.entries.delete(scope, target.id);
    const id = await holdOf(entry.id);
    const res = await as(blind, 'POST', `/moderation-holds/${id}/republish`);
    const text = JSON.stringify(res.body);
    expect(res.status, text).toBe(422);
    expect((res.body.error as Json).issues).toEqual([
      expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
    ]);
    expect(text).not.toContain('related');
    expect(text).not.toContain(target.id);
  });

  it('needs content:publish, and publish on the held entry’s type', async () => {
    const { call, held, holdOf, roleKey } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    for (const headers of [cpa, cda]) {
      expect((await call('POST', `/moderation-holds/${id}/keep`, {}, headers)).status).toBe(403);
      expect((await call('POST', `/moderation-holds/${id}/republish`, {}, headers)).status).toBe(
        403,
      );
    }
    const writer = await roleKey(['read', 'write']);
    expect((await call('POST', `/moderation-holds/${id}/keep`, {}, writer)).status).toBe(403);
    const publisher = await roleKey(['read', 'write', 'publish']);
    // Publish on posts says nothing about pages.
    const page = await holdOf(held.heldpage ?? '');
    expect((await call('POST', `/moderation-holds/${page}/keep`, {}, publisher)).status).toBe(403);
    expect((await call('POST', `/moderation-holds/${id}/keep`, {}, publisher)).status).toBe(200);
  });

  it('is invisible to a key for another space, deciding by id', async () => {
    const { app, store, held, holdOf, isOpen } = await makeApp();
    const id = await holdOf(held.heldpost ?? '');
    store.seedSpace({ spaceId: 's2', defaultLocale: 'en-US', locales: ['en-US'] });
    store.seedApiKey({
      id: 'key-s2',
      spaceId: 's2',
      kind: 'cma',
      hashedToken: createApiHasher(config.tokenPepper).hash('s2-token'),
      scopes: ['preview:read', 'content:write', 'content:publish'],
      revoked: false,
    });
    const other = { Authorization: 'Bearer s2-token', 'Content-Type': 'application/json' };
    const res = await app.request(`/spaces/s2/environments/main/moderation-holds/${id}/keep`, {
      method: 'POST',
      headers: other,
      body: '{}',
    });
    expect(res.status).toBe(404);
    // Nor can it reach s1's route at all.
    const there = await app.request(`${M}/moderation-holds/${id}/keep`, {
      method: 'POST',
      headers: other,
      body: '{}',
    });
    expect(there.status).toBe(403);
    expect(await isOpen(held.heldpost ?? '')).toBe(true);
  });

  it('keeps a decider’s note from a caller that can’t write content', async () => {
    const { call, held, holdOf } = await makeApp();
    const id = await holdOf(held.heldpage ?? '');
    await call('POST', `/moderation-holds/${id}/keep`, { note: 'A person’s own words' });
    const listed = (await call('GET', `/moderation-holds?entryId=${held.heldpage}`, undefined, cpa))
      .body.items as Json[];
    expect(listed[0]).toMatchObject({ status: 'kept' });
    expect(listed[0]).not.toHaveProperty('note');
    const full = (await call('GET', `/moderation-holds?entryId=${held.heldpage}`)).body
      .items as Json[];
    expect(full[0]).toMatchObject({ note: 'A person’s own words' });
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
