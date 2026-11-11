/**
 * `assets:read` and `assets:write` split asset access out of the content scopes: a key can hold
 * asset access alone, and every key, role and token that reached assets before (through
 * `preview:read` and `content:write`) still does, with nothing stored changed.
 */
import type { ApiConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { toolListedFor } from '../../src/mcp/tool-scopes';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
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
const M = '/spaces/s1/environments/main';
const newAsset = JSON.stringify({ fileName: 'a.png', contentType: 'image/png' });

function makeApp() {
  const wired = wire(config);
  return createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
}

/** A key bound to a role holding exactly `scopes`. */
async function keyWith(app: ReturnType<typeof makeApp>, scopes: string[], kind = 'cma') {
  const role = await app.request('/spaces/s1/roles', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: scopes.join(' '), scopes }),
  });
  expect(role.status).toBe(201);
  const { id } = (await role.json()) as { id: string };
  const key = await app.request('/spaces/s1/api-keys', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ kind, roleId: id }),
  });
  expect(key.status).toBe(201);
  const { token } = (await key.json()) as { token: string };
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('asset scopes', () => {
  it('lets an assets-only key work the library and nothing else', async () => {
    const app = makeApp();
    const librarian = await keyWith(app, ['assets:read', 'assets:write']);
    const created = await app.request(`${M}/assets`, {
      method: 'POST',
      headers: librarian,
      body: newAsset,
    });
    expect(created.status).toBe(201);
    expect((await app.request(`${M}/assets`, { headers: librarian })).status).toBe(200);
    expect((await app.request(`${M}/asset-folders`, { headers: librarian })).status).toBe(200);
    const entry = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: librarian,
      body: JSON.stringify({ contentTypeApiId: 'article', fields: {} }),
    });
    expect(entry.status).toBe(403);
    expect((await app.request(`${M}/content-types`, { headers: librarian })).status).toBe(403);
  });

  it('keeps reading and writing apart', async () => {
    const app = makeApp();
    const reader = await keyWith(app, ['assets:read'], 'cpa');
    expect((await app.request(`${M}/assets`, { headers: reader })).status).toBe(200);
    const write = await app.request(`${M}/assets`, {
      method: 'POST',
      headers: reader,
      body: newAsset,
    });
    expect(write.status).toBe(403);
  });

  it('still lets preview:read and content:write reach assets, by implication', async () => {
    const app = makeApp();
    const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
    expect((await app.request(`${M}/assets`, { headers: cpa })).status).toBe(200);
    const legacy = await keyWith(app, ['preview:read', 'content:write']);
    const created = await app.request(`${M}/assets`, {
      method: 'POST',
      headers: legacy,
      body: newAsset,
    });
    expect(created.status).toBe(201);
  });

  it('lists asset tools, not entry tools, to an assets-only caller on MCP', () => {
    const principal = { spaceId: 's1', kind: 'cma' as const, scopes: ['assets:read'] };
    expect(toolListedFor(principal, 'assets_list')).toBe(true);
    expect(toolListedFor(principal, 'asset_get')).toBe(true);
    expect(toolListedFor(principal, 'asset_create')).toBe(false);
    expect(toolListedFor(principal, 'entries_list_trashed')).toBe(false);
    // preview:read implies assets:read, so a preview caller still sees the asset tools.
    expect(toolListedFor({ ...principal, scopes: ['preview:read'] }, 'asset_get')).toBe(true);
  });
});

describe('asset scopes on delegated tokens and usage', () => {
  it('keeps asset usage, which names entries, on preview:read', async () => {
    const app = makeApp();
    const librarian = await keyWith(app, ['assets:read', 'assets:write']);
    const created = await app.request(`${M}/assets`, {
      method: 'POST',
      headers: librarian,
      body: newAsset,
    });
    const { asset } = (await created.json()) as { asset: { id: string } };
    const usage = (h: Record<string, string>) =>
      app.request(`${M}/assets/${asset.id}/usage`, { headers: h });
    expect((await usage(librarian)).status).toBe(403);
    const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
    expect((await usage(cpa)).status).toBe(200);
  });
});
