import type { ApiConfig } from '@contentworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { wire } from './wire.js';

const config: ApiConfig = {
  role: 'all',
  port: 0,
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
};

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };

/**
 * Regression for the cross-space key-minting escalation: a request-body
 * `spaceId` must never override the authorized `:space` route param when minting
 * an API key. Previously the body was spread over the route param, so any CMA
 * key (whose default grant includes space:admin) could mint a full key bound to
 * another space.
 */
describe('api-key minting cannot be rebound to another space', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
    // A second space to attempt to escalate into.
    await app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId: 's2', name: 'Second', defaultLocale: 'en-US' }),
    });
  });

  it('ignores a body spaceId and binds the key to the route space', async () => {
    // A routine CMA key for s1 (its default grant includes space:admin).
    const mint = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', name: 's1 writer' }),
    });
    expect(mint.status).toBe(201);
    const s1Token = ((await mint.json()) as { token: string }).token;
    const s1Auth = { Authorization: `Bearer ${s1Token}`, 'Content-Type': 'application/json' };

    // Attempt the escalation: mint against s1 but ask for s2 in the body.
    const attack = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: s1Auth,
      body: JSON.stringify({ kind: 'cma', spaceId: 's2' }),
    });
    expect(attack.status).toBe(201);
    const escalatedToken = ((await attack.json()) as { token: string }).token;
    const escalatedAuth = { Authorization: `Bearer ${escalatedToken}` };

    // The minted key must be bound to s1, NOT s2: it is authorized for s1...
    const onS1 = await app.request('/spaces/s1/api-keys', { headers: escalatedAuth });
    expect(onS1.status).toBe(200);
    // ...and rejected on s2.
    const onS2 = await app.request('/spaces/s2/api-keys', { headers: escalatedAuth });
    expect(onS2.status).toBe(403);
  });

  it('rejects an unknown api-key kind', async () => {
    const res = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'root' }),
    });
    expect(res.status).toBe(422);
  });
});
