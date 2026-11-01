import type { ApiConfig } from '@contentworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/** Plugin settings over HTTP: typed against the manifest, secrets reported as set, never shown. */

const MANIFEST = {
  id: 'com.example.seo',
  name: 'SEO helper',
  version: '1.0.0',
  capabilities: [],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
  settings: [
    { key: 'apiKey', label: 'API key', type: 'string', secret: true, required: true },
    { key: 'maxLength', label: 'Max length', type: 'number', default: 120 },
  ],
};

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
const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
const PATH = '/spaces/s1/plugins/com.example.seo/settings';

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const wired = wire(config);
  app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const res = await send('POST', '/spaces/s1/plugins', {
    manifest: MANIFEST,
    bundle: 'export class Plugin {}',
    approvedCapabilities: [],
  });
  expect(res.status).toBe(201);
});

const send = (method: string, path: string, body?: unknown, headers = admin) =>
  app.request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('plugin settings over HTTP', () => {
  it('reads the declared fields and defaults before anything is set', async () => {
    const res = await send('GET', PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pluginId: 'com.example.seo',
      fields: MANIFEST.settings,
      values: { maxLength: 120 },
      secretsSet: [],
      version: 0,
    });
  });

  it('sets values and a secret, and never echoes the secret', async () => {
    const res = await send('PATCH', PATH, { values: { apiKey: 'sk_http', maxLength: 64 } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk_http');
    expect(JSON.parse(text)).toMatchObject({
      values: { maxLength: 64 },
      secretsSet: ['apiKey'],
      version: 1,
    });
    expect(await (await send('GET', PATH)).text()).not.toContain('sk_http');
  });

  it('refuses a value the manifest does not declare, or of the wrong type', async () => {
    expect((await send('PATCH', PATH, { values: { apiKey: 'sk', nope: 1 } })).status).toBe(422);
    expect((await send('PATCH', PATH, { values: { apiKey: 'sk', maxLength: 'x' } })).status).toBe(
      422,
    );
    expect((await send('PATCH', PATH, { values: { apiKey: { nested: true } } })).status).toBe(422);
  });

  it('refuses a stale expectedVersion with 409', async () => {
    await send('PATCH', PATH, { values: { apiKey: 'sk' } });
    const res = await send('PATCH', PATH, { values: { maxLength: 1 }, expectedVersion: 0 });
    expect(res.status).toBe(409);
  });

  it('is space-admin only, both ways', async () => {
    expect((await send('GET', PATH, undefined, cda)).status).toBe(403);
    expect((await send('PATCH', PATH, { values: { apiKey: 'sk' } }, cda)).status).toBe(403);
  });

  it('is 404 for a plugin that is not installed', async () => {
    expect((await send('GET', '/spaces/s1/plugins/com.example.none/settings')).status).toBe(404);
  });
});
