import type { ApiConfig } from '@contentworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
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
const article = JSON.stringify({
  apiId: 'article',
  name: 'Article',
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

describe('writing to an environment', () => {
  let app: ReturnType<typeof createApp>;
  const post = (space: string, env: string, auth: Record<string, string>) =>
    app.request(`/spaces/${space}/environments/${env}/content-types`, {
      method: 'POST',
      headers: auth,
      body: article,
    });
  const types = async (space: string, env: string) =>
    (
      (await (
        await app.request(`/spaces/${space}/environments/${env}/content-types`, { headers: admin })
      ).json()) as { items: { apiId: string }[] }
    ).items.map((t) => t.apiId);

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
    for (const body of [
      { spaceId: 's2', name: 'Second', defaultLocale: 'en-US' },
      { spaceId: 'blank', name: 'Blank', defaultLocale: 'en-US' },
    ]) {
      await app.request('/spaces', { method: 'POST', headers: admin, body: JSON.stringify(body) });
    }
    await app.request('/spaces/blank/environments', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ id: 'staging' }),
    });
  });

  it('refuses one that does not exist with 404, leaving nothing behind', async () => {
    expect((await post('blank', 'stagign', admin)).status).toBe(404);
    expect(await types('blank', 'stagign')).toEqual([]);
  });

  it('lands in the target when named through an alias', async () => {
    await app.request('/spaces/blank/environment-aliases/live', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ targetEnvironmentId: 'staging' }),
    });
    expect((await post('blank', 'live', admin)).status).toBe(201);
    expect(await types('blank', 'staging')).toEqual(['article']);
  });

  it('answers a caller from another space 403, not whether the environment exists', async () => {
    const mint = await app.request('/spaces/s2/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', name: 's2 writer' }),
    });
    const token = ((await mint.json()) as { token: string }).token;
    const s2 = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await post('blank', 'staging', s2)).status).toBe(403);
    expect((await post('blank', 'nope', s2)).status).toBe(403);
  });
});
