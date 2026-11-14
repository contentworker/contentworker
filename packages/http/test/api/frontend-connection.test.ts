import type { ApiConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const seed = {
  spaceId: 's1',
  environmentId: 'main',
  defaultLocale: 'en-US',
  locales: ['en-US'],
  scale: 1,
};
const M = '/spaces/s1/environments/main';
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';

function setup(overrides: Partial<ApiConfig> = { oauthIssuer: 'https://cms.example.com' }) {
  const config = testConfig({ seed, ...overrides });
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const send = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = admin,
  ) => app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { send, app };
}

interface Connection {
  space: string;
  environment: string;
  deliveryKey: { id: string; token: string };
  previewKey?: { id: string; token: string };
  endpoints?: { admin: string; delivery: string; preview: string };
  previewUrls: { contentType: string; urlTemplate: string | null }[];
}

describe('connecting a frontend over HTTP', () => {
  it('mints the keys once, with the endpoints and preview URLs a config names', async () => {
    const { send } = setup();
    await send(`${M}/content-types`, 'POST', {
      apiId: 'post',
      name: 'Post',
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
        {
          apiId: 'slug',
          name: 'Slug',
          type: 'Slug',
          localized: false,
          required: false,
          position: 1,
        },
      ],
      preview: { urlTemplate: TEMPLATE },
    });
    const res = await send(`${M}/frontend-connections`, 'POST', { name: 'Site', preview: true });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const c = (await res.json()) as Connection;
    expect(c).toMatchObject({
      space: 's1',
      environment: 'main',
      endpoints: {
        admin: 'https://cms.example.com',
        delivery: 'https://cdn.cms.example.com',
        preview: 'https://api.cms.example.com',
      },
    });
    expect(c.previewUrls).toContainEqual(
      expect.objectContaining({ contentType: 'post', urlTemplate: TEMPLATE }),
    );

    // The Delivery key reads Delivery, the Preview key reads drafts; neither manages anything.
    const as = (token: string) => ({ Authorization: `Bearer ${token}` });
    expect(
      (await send('/delivery/s1/main/entries', 'GET', undefined, as(c.deliveryKey.token))).status,
    ).toBe(200);
    expect(
      (await send('/preview/s1/main/entries', 'GET', undefined, as(c.deliveryKey.token))).status,
    ).toBe(403);
    expect(
      (await send('/preview/s1/main/entries', 'GET', undefined, as(c.previewKey?.token ?? '')))
        .status,
    ).toBe(200);
    expect(
      (await send(`${M}/content-types`, 'GET', undefined, as(c.previewKey?.token ?? ''))).status,
    ).not.toBe(201);

    // Listed by name, never with the token again.
    const listed = await (await send('/spaces/s1/api-keys', 'GET')).text();
    expect(listed).toContain('Site (delivery)');
    expect(listed).toContain('Site (preview)');
    expect(listed).not.toContain(c.deliveryKey.token);
    expect(listed).not.toContain(c.previewKey?.token);
  });

  it('answers without endpoints when the deployment has no admin origin', async () => {
    const { send } = setup({});
    const c = (await (await send(`${M}/frontend-connections`, 'POST', {})).json()) as Connection;
    expect(c.endpoints).toBeUndefined();
    expect(c.previewKey).toBeUndefined();
  });

  it('needs space:admin, and an environment that exists', async () => {
    const { send } = setup();
    const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
    expect((await send(`${M}/frontend-connections`, 'POST', {}, cda)).status).toBe(403);
    const missing = await send('/spaces/s1/environments/nope/frontend-connections', 'POST', {});
    expect(missing.status).toBe(404);
    // Nothing was minted by either refusal.
    const listed = (await (await send('/spaces/s1/api-keys', 'GET')).json()) as {
      items: { name?: string }[];
    };
    expect(listed.items.filter((k) => k.name?.startsWith('Frontend'))).toEqual([]);
  });

  it('refuses another space’s administrator key', async () => {
    const { send } = setup();
    const space = await send('/spaces', 'POST', {
      spaceId: 's2',
      name: 'Other',
      defaultLocale: 'en-US',
    });
    expect(space.status, await space.clone().text()).toBe(201);
    const minted = await send('/spaces/s2/api-keys', 'POST', { kind: 'cma' });
    const { token } = (await minted.json()) as { token: string };
    const other = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await send(`${M}/frontend-connections`, 'POST', {}, other)).status).toBe(403);
    // Its own space it may connect.
    const own = await send('/spaces/s2/environments/main/frontend-connections', 'POST', {}, other);
    expect(own.status, await own.clone().text()).toBe(201);
    expect(((await own.json()) as Connection).space).toBe('s2');
  });

  it('refuses a body it doesn’t know the shape of', async () => {
    const { send } = setup();
    const res = await send(`${M}/frontend-connections`, 'POST', { name: 'x'.repeat(101) });
    expect(res.status).toBe(422);
  });

  it('is documented in the OpenAPI spec', async () => {
    const { app } = setup();
    const spec = JSON.stringify(await (await app.request('/openapi.json')).json());
    expect(spec).toContain('/spaces/{space}/environments/{env}/frontend-connections');
    expect(spec).toContain('previewUrls');
  });
});
