import { createContentType, SYSTEM_CALLER } from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * `GET`/`PUT /spaces/:space/ai-settings`: read with `preview:read`, set with `space:admin` against
 * the version read, audited by the parts changed; and a capability turned off refuses the routes
 * that need it with 409 `ai_capability_disabled`, naming it.
 */
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
    locales: ['en-US', 'fr-FR'],
    scale: 1,
  },
});

const auth = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function makeApp(opts: { maxTier?: 'balanced' | 'fast' } = {}) {
  const wired = wire(config);
  const ctx = opts.maxTier
    ? { ...wired.ctx, ai: { mode: 'live' as const, timeoutMs: 20_000, maxTier: opts.maxTier } }
    : wired.ctx;
  const app = createApp(ctx, config, wired.rag, wired.blob, wired.ai);
  await createContentType(
    wired.ctx,
    SYSTEM_CALLER,
    { spaceId: 's1', environmentId: 'main' },
    {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: true,
          required: false,
          position: 0,
        },
      ],
    },
  );
  const send = (method: string, path: string, body?: unknown, token = 'admin') =>
    app.request(path, {
      method,
      headers: auth(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { wired, send };
}

describe('AI settings over HTTP', () => {
  it('reads the defaults, sets one capability, and audits the parts it changed', async () => {
    const { wired, send } = await makeApp();
    const read = await send('GET', '/spaces/s1/ai-settings', undefined, 'cpa');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      version: 0,
      capabilities: { drafting: { enabled: true, tier: null, guidance: null } },
    });

    const set = await send('PUT', '/spaces/s1/ai-settings', {
      expectedVersion: 0,
      capabilities: { translation: { enabled: true, tier: 'fast', guidance: 'Formal register.' } },
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      unchanged: false,
      settings: {
        version: 1,
        capabilities: {
          translation: { enabled: true, tier: 'fast', guidance: 'Formal register.' },
          drafting: { enabled: true },
        },
      },
    });
    const rows = await wired.ctx.store.audit.list('s1', {});
    expect(rows.map((r) => [r.action, r.targetType, r.targetId, r.detail?.aiSettings])).toEqual([
      [
        'PUT /spaces/:space/ai-settings',
        'ai_settings',
        '1',
        { from: 0, to: 1, changed: ['translation.tier', 'translation.guidance'] },
      ],
    ]);
  });

  it('sets only with space:admin', async () => {
    const { send } = await makeApp();
    const body = { expectedVersion: 0, capabilities: { media: { enabled: false } } };
    expect((await send('PUT', '/spaces/s1/ai-settings', body, 'cpa')).status).toBe(403);
    expect((await send('PUT', '/spaces/s1/ai-settings', body, 'cda')).status).toBe(403);
    expect((await send('GET', '/spaces/s1/ai-settings', undefined, 'cda')).status).toBe(403);
    expect((await send('PUT', '/spaces/s1/ai-settings', body, 'cma')).status).toBe(200);
  });

  it('refuses a key of another space, reading and writing', async () => {
    const { wired, send } = await makeApp();
    // A space-admin key minted for another space.
    const other = await send('POST', '/spaces', {
      spaceId: 's2',
      name: 'Other',
      defaultLocale: 'en-US',
    });
    expect(other.status).toBeLessThan(300);
    const minted = await send('POST', '/spaces/s2/api-keys', { kind: 'cma', name: 'other' });
    const { token } = (await minted.json()) as { token: string };
    expect((await send('GET', '/spaces/s1/ai-settings', undefined, token)).status).toBe(403);
    const put = await send(
      'PUT',
      '/spaces/s1/ai-settings',
      { expectedVersion: 0, capabilities: { media: { enabled: false } } },
      token,
    );
    expect(put.status).toBe(403);
    expect(await wired.ctx.store.aiSettings.get('s1')).toBeNull();
  });

  it('refuses a stale version (409) and what is not a capability or too long (422)', async () => {
    const { send } = await makeApp();
    await send('PUT', '/spaces/s1/ai-settings', {
      expectedVersion: 0,
      capabilities: { media: { enabled: false } },
    });
    const stale = await send('PUT', '/spaces/s1/ai-settings', {
      expectedVersion: 0,
      capabilities: { search: { enabled: false } },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'conflict', details: { version: 1, currentVersion: 1 } },
    });
    const unknown = await send('PUT', '/spaces/s1/ai-settings', {
      expectedVersion: 1,
      capabilities: { chat: { enabled: false } },
    });
    expect(unknown.status).toBe(422);
    const long = await send('PUT', '/spaces/s1/ai-settings', {
      expectedVersion: 1,
      capabilities: { media: { enabled: true, guidance: 'x'.repeat(2001) } },
    });
    expect(long.status).toBe(422);
    expect(await long.json()).toMatchObject({
      error: { issues: [{ field: 'capabilities.media.guidance' }] },
    });
  });

  it('refuses a disabled capability with 409 ai_capability_disabled, naming it', async () => {
    const { send } = await makeApp();
    await send('PUT', '/spaces/s1/ai-settings', {
      expectedVersion: 0,
      capabilities: { drafting: { enabled: false } },
    });
    const res = await send('POST', '/spaces/s1/environments/main/entries/generate', {
      contentTypeApiId: 'post',
      prompt: 'x',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'ai_capability_disabled', capability: 'drafting' },
    });
    // The others are on.
    const entry = await send('POST', '/spaces/s1/environments/main/entries', {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' } },
    });
    const {
      entry: { id },
    } = (await entry.json()) as { entry: { id: string } };
    const translated = await send('POST', `/spaces/s1/environments/main/entries/${id}/translate`, {
      targetLocale: 'fr-FR',
    });
    expect(translated.status).toBe(200);
  });

  it('accepts a tier above the deployment’s cap, keeps it, and reports the tier it runs on', async () => {
    const { send } = await makeApp({ maxTier: 'balanced' });
    const set = await send('PUT', '/spaces/s1/ai-settings', {
      expectedVersion: 0,
      capabilities: { drafting: { enabled: true, tier: 'flagship' } },
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      settings: {
        maxTier: 'balanced',
        capabilities: { drafting: { tier: 'flagship', effectiveTier: 'balanced' } },
      },
    });
    const read = await send('GET', '/spaces/s1/ai-settings', undefined, 'cpa');
    expect(await read.json()).toMatchObject({
      maxTier: 'balanced',
      capabilities: {
        drafting: { tier: 'flagship', effectiveTier: 'balanced' },
        layout: { tier: null, effectiveTier: null },
      },
    });
  });
});
