import type { ApiConfig } from '@contentworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { seedBlocks } from '../snapshot-round-trip';
import { testConfig } from './config.js';
import { wire } from './wire.js';

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
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
const STAGING = '/spaces/s1/environments/staging';

let app: ReturnType<typeof createApp>;
let entryId: string;
let wired: ReturnType<typeof wire>;

beforeEach(async () => {
  wired = wire(config);
  const { ctx, rag, blob, ai } = wired;
  app = createApp(ctx, config, rag, blob, ai);
  await app.request('/spaces/s1/environments', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ id: 'staging' }),
  });
  const note = {
    apiId: 'note',
    name: 'Note',
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
  };
  for (const env of ['staging', 'main']) {
    const base = `/spaces/s1/environments/${env}`;
    await app.request(`${base}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify(note),
    });
    await app.request(`${base}/content-types/note/published`, { method: 'POST', headers: admin });
  }
  const created = await app.request(`${STAGING}/entries`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ contentTypeApiId: 'note', fields: { title: { 'en-US': 'Ship it' } } }),
  });
  entryId = ((await created.json()) as { entry: { id: string } }).entry.id;
  await app.request(`${STAGING}/entries/${entryId}/published`, { method: 'POST', headers: admin });
});

type P = { id: string; status: string; risk: { reasons: string[] }; decidedBy?: string };

describe('promotions over HTTP', () => {
  it('waits for approval into main, which an API key cannot give and the admin token can', async () => {
    const req = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ source: 'staging', target: 'main', entries: [entryId] }),
    });
    expect(req.status).toBe(201);
    const p = (await req.json()) as P;
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The target is main');

    const byKey = await app.request(`/spaces/s1/promotions/${p.id}/approve`, {
      method: 'POST',
      headers: cma,
    });
    expect(byKey.status).toBe(403);
    const byAdmin = await app.request(`/spaces/s1/promotions/${p.id}/approve`, {
      method: 'POST',
      headers: admin,
    });
    expect(byAdmin.status).toBe(200);
    expect((await byAdmin.json()) as P).toMatchObject({
      status: 'completed',
      decidedBy: 'admin-token',
    });

    const listed = await app.request('/spaces/s1/promotions?status=completed', { headers: admin });
    expect(((await listed.json()) as { items: P[] }).items.map((x) => x.id)).toEqual([p.id]);
    const one = await app.request(`/spaces/s1/promotions/${p.id}`, { headers: admin });
    expect(one.status).toBe(200);
  });

  it('answers a request that stopped after a write with a 409 carrying its failed record', async () => {
    await app.request('/spaces/s1/environments', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ id: 'qa' }),
    });
    await app.request('/spaces/s1/merge', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ source: 'staging', target: 'qa', contentTypes: ['note'] }),
    });
    const second = await app.request(`${STAGING}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ contentTypeApiId: 'note', fields: { title: { 'en-US': 'Two' } } }),
    });
    const secondId = ((await second.json()) as { entry: { id: string } }).entry.id;
    // The second write fails once the first has landed: partway.
    const store = wired.ctx.store;
    const create = store.entries.create.bind(store.entries);
    let writes = 0;
    store.entries.create = async (...args) => {
      if (++writes === 2) throw new Error('boom');
      return create(...args);
    };
    // Into qa, which needs no approval: it applies in the request.
    const res = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ source: 'staging', target: 'qa', entries: [entryId, secondId] }),
    });
    store.entries.create = create;
    // Half-promoted is never a 2xx: automation that checks the status stops here.
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; promotion: P & { error?: string } };
    };
    expect(body.error.code).toBe('promotion_failed');
    const p = body.error.promotion;
    expect(p).toMatchObject({ status: 'failed', error: 'boom', result: { entries: [entryId] } });
    const one = await app.request(`/spaces/s1/promotions/${p.id}`, { headers: admin });
    expect(await one.json()).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('lets its requester withdraw a waiting promotion, recorded as rejected by them', async () => {
    const req = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ source: 'staging', target: 'main', entries: [entryId] }),
    });
    const p = (await req.json()) as P;
    expect(p.status).toBe('awaiting_approval');
    const res = await app.request(`/spaces/s1/promotions/${p.id}/reject`, {
      method: 'POST',
      headers: admin,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'rejected',
      requestedBy: 'admin-token',
      decidedBy: 'admin-token',
    });
  });

  it('copies the block catalog and config with a selection when the body asks for them', async () => {
    await seedBlocks(wired.ctx, { spaceId: 's1', environmentId: 'staging' });
    const req = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        source: 'staging',
        target: 'main',
        contentTypes: ['page'],
        blocks: true,
      }),
    });
    expect(req.status).toBe(201);
    const p = (await req.json()) as P & { blocks?: unknown };
    expect(p.blocks).toEqual({
      catalogVersion: 1,
      configVersion: 1,
      targetCatalogVersion: 0,
      targetConfigVersion: 0,
    });
    expect(p.risk.reasons).toContain(
      'The block rules change: page.body is new: takes hero, locked',
    );
    const approved = await app.request(`/spaces/s1/promotions/${p.id}/approve`, {
      method: 'POST',
      headers: admin,
    });
    expect(await approved.json()).toMatchObject({
      status: 'completed',
      result: { contentTypes: ['page'], blocks: { catalog: true, config: true } },
    });
    const rules = await app.request('/spaces/s1/environments/main/block-config/effective', {
      headers: admin,
    });
    expect(await rules.json()).toMatchObject({
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero'], locked: true }],
    });
  });

  it('shows promotions to whoever can decide them, not to a preview key', async () => {
    const preview = await app.request('/spaces/s1/promotions', {
      headers: { Authorization: 'Bearer cpa' },
    });
    expect(preview.status).toBe(403);
    expect((await app.request('/spaces/s1/promotions', { headers: admin })).status).toBe(200);
  });

  it('refuses with a 422 a content type that drops a block variant the target’s entries use', async () => {
    const symbol = (apiId: string) => ({
      apiId,
      name: apiId,
      type: 'Symbol',
      localized: false,
      required: false,
      position: 0,
    });
    const page = (variants: unknown[]) => ({
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        { ...symbol('title'), required: true },
        { ...symbol('body'), position: 1, type: 'Array', items: { type: 'Component', variants } },
      ],
    });
    const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading')] };
    const cta = { apiId: 'cta', name: 'CTA', fields: [symbol('label')] };
    for (const [env, variants] of [
      ['staging', [hero]],
      ['main', [hero, cta]],
    ] as const) {
      const base = `/spaces/s1/environments/${env}`;
      await app.request(`${base}/content-types`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify(page([...variants])),
      });
      await app.request(`${base}/content-types/page/published`, { method: 'POST', headers: admin });
    }
    const held = await app.request('/spaces/s1/environments/main/entries', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': 'Home' },
          body: { 'en-US': [{ _type: 'cta', label: 'Secret launch copy' }] },
        },
      }),
    });
    const heldId = ((await held.json()) as { entry: { id: string } }).entry.id;

    const res = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ source: 'staging', target: 'main', contentTypes: ['page'] }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: 'validation_failed',
        message: 'One or more fields are invalid',
        issues: [
          {
            field: 'contentTypes',
            message: `The content type "page" can't go to main: it removes a block variant 1 entry there still uses: body: cta (entry ${heldId}). Change or clear those values there first, or leave "page" out of the promotion`,
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('Secret launch copy');
    const listed = await app.request('/spaces/s1/promotions', { headers: admin });
    expect(((await listed.json()) as { items: P[] }).items).toEqual([]);
  });

  it('holds requesting and reading to per-type grants and field rules', async () => {
    const keyFor = async (contentGrants: unknown[]) => {
      const role = await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: `r${Math.random()}`,
          scopes: ['content:manage', 'content:publish', 'content:write', 'preview:read'],
          contentGrants,
        }),
      });
      expect(role.status).toBe(201);
      const { id } = (await role.json()) as { id: string };
      const key = await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cma', roleId: id }),
      });
      const { token } = (await key.json()) as { token: string };
      return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    };
    const everyType =
      'Missing required scope "content:read+write+publish:* (on every content type, every field)"';
    const request = (headers: Record<string, string>) =>
      app.request('/spaces/s1/promotions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ source: 'staging', target: 'main', entries: [entryId] }),
      });
    // `note` in full, nothing else writable; then every type, with a read-only field.
    for (const grants of [
      [
        { contentTypeApiId: 'note', actions: ['read', 'write', 'publish'] },
        { contentTypeApiId: '*', actions: ['read'] },
      ],
      [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'], readOnlyFields: ['title'] }],
    ]) {
      const refused = await request(await keyFor(grants));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: 'forbidden', message: everyType },
      });
    }
    const none = await app.request('/spaces/s1/promotions', { headers: admin });
    expect(((await none.json()) as { items: P[] }).items).toEqual([]);

    // Entries go over the target's locked regions: without `lock`, refused too.
    const noLock = await request(
      await keyFor([{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }]),
    );
    expect(noLock.status).toBe(403);
    expect(await noLock.json()).toMatchObject({
      error: {
        code: 'forbidden',
        message:
          'Missing required scope "content:read+write+publish+lock:* (on every content type, every field)"',
      },
    });

    // A role holding every type alike may request one.
    const wide = await keyFor([
      { contentTypeApiId: '*', actions: ['read', 'write', 'publish', 'lock'] },
    ]);
    const requested = await request(wide);
    expect(requested.status).toBe(201);
    const { id } = (await requested.json()) as P;

    // One that can't read every field of `note` doesn't see it.
    const hidden = await keyFor([
      { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], deniedFields: ['title'] },
    ]);
    const listed = await app.request('/spaces/s1/promotions', { headers: hidden });
    expect(((await listed.json()) as { items: P[] }).items).toEqual([]);
    // Not found, as the list leaves it out.
    const got = await app.request(`/spaces/s1/promotions/${id}`, { headers: hidden });
    expect(got.status).toBe(404);
    const seen = await app.request('/spaces/s1/promotions', { headers: wide });
    expect(((await seen.json()) as { items: P[] }).items.map((p) => p.id)).toEqual([id]);
  });

  it('refuses a delivery key', async () => {
    const res = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: cda,
      body: JSON.stringify({ source: 'staging', target: 'main' }),
    });
    expect(res.status).toBe(403);
  });
});
