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

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';

const post = {
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
    { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: false, position: 1 },
  ],
  preview: { urlTemplate: TEMPLATE },
};

function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const send = (path: string, method: string, body?: unknown, headers = cma) =>
    app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { send, app };
}

describe('content type preview URL template over HTTP', () => {
  it('stores the template, keeps it on a save that leaves it out, and clears it with null', async () => {
    const { send } = setup();
    const path = `${M}/content-types`;
    const res = await send(path, 'POST', post);
    expect(res.status, await res.clone().text()).toBe(201);
    const read = async () =>
      (await (await send(`${path}/post`, 'GET')).json()) as Record<string, unknown>;
    expect((await read()).preview).toEqual({ urlTemplate: TEMPLATE });
    const { preview: _p, ...without } = post;
    await send(path, 'POST', { ...without, name: 'Posts' });
    expect((await read()).preview).toEqual({ urlTemplate: TEMPLATE });
    await send(path, 'POST', { ...post, preview: null });
    expect(await read()).not.toHaveProperty('preview');
  });

  it('refuses a template that isn’t https, moves the host, or carries no token', async () => {
    const { send } = setup();
    for (const urlTemplate of [
      'http://site.example/?token={token}',
      'https://{space}.site.example/?token={token}',
      'https://site.example/p/{id}',
      'javascript:alert(1)//{token}',
    ]) {
      const res = await send(`${M}/content-types`, 'POST', { ...post, preview: { urlTemplate } });
      expect(res.status, urlTemplate).toBe(422);
      expect(JSON.stringify(await res.json())).toContain('preview.urlTemplate');
    }
  });

  it('returns the filled frontend URL beside the Preview API URL from a preview link', async () => {
    const { send } = setup();
    await send(`${M}/content-types`, 'POST', post);
    const created = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' }, slug: { 'en-US': 'hello-world' } },
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    const res = await send(`${M}/entries/${entry.id}/preview-link`, 'POST', {
      previewBaseUrl: 'https://admin.example',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const link = (await res.json()) as { url: string; frontendUrl: string; token: string };
    expect(link.url).toBe(
      `https://admin.example/preview/s1/main/entries/${entry.id}?preview_token=${link.token}`,
    );
    expect(link.frontendUrl).toBe(
      `https://site.example/blog/hello-world?entry=${entry.id}&token=${link.token}`,
    );
    // The token reads the entry on the Preview API, as the frontend will.
    const read = await send(
      `/preview/s1/main/entries/${entry.id}?preview_token=${link.token}`,
      'GET',
      undefined,
      { 'Content-Type': 'application/json' } as typeof cma,
    );
    expect(read.status, await read.clone().text()).toBe(200);
    // And says when the token stops working, as the link does, so a frontend holds it no longer.
    const { expiresAt } = link as unknown as { expiresAt: string };
    expect(read.headers.get('x-cw-preview-expires')).toBe(expiresAt);
    // A bearer read says nothing of the kind.
    const bearer = await send(`/preview/s1/main/entries/${entry.id}`, 'GET');
    expect(bearer.headers.get('x-cw-preview-expires')).toBeNull();
    // A locale the space doesn't have is refused.
    const bad = await send(`${M}/entries/${entry.id}/preview-link`, 'POST', { locale: 'de' });
    expect(bad.status).toBe(422);
  });

  it('needs read on the type to point its preview links somewhere, on create, save and clone', async () => {
    const { send, app } = setup();
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    const role = (await (
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: 'model-not-posts',
          scopes: ['content:manage', 'preview:read'],
          contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write'] }],
        }),
      })
    ).json()) as { id: string };
    const key = (await (
      await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cma', roleId: role.id, name: 'modeller' }),
      })
    ).json()) as { token: string };
    const modeller = { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' };
    const path = `${M}/content-types`;
    const elsewhere = { urlTemplate: 'https://elsewhere.example/p?entry={id}&token={token}' };

    // Creating a type it can't read, with a preview URL: refused.
    const created = await send(path, 'POST', post, modeller);
    expect(created.status, await created.clone().text()).toBe(403);
    // Without one, the model change itself is content:manage's to make.
    const { preview: _p, ...bare } = post;
    expect((await send(path, 'POST', bare, modeller)).status).toBe(201);
    // Set by someone who can read it, then moved elsewhere by the modeller: refused.
    expect((await send(path, 'POST', post)).status).toBe(201);
    expect((await send(path, 'POST', { ...post, preview: elsewhere }, modeller)).status).toBe(403);
    // Sent back unchanged, left out, or cleared: allowed.
    expect((await send(path, 'POST', { ...post, name: 'Posts' }, modeller)).status).toBe(201);
    expect((await send(path, 'POST', { ...bare, name: 'Posts 2' }, modeller)).status).toBe(201);
    // A clone carries the preview URL onto a type the modeller can't read either.
    const clone = await send(
      `${path}/post/clone`,
      'POST',
      { apiId: 'story', name: 'Story' },
      modeller,
    );
    expect(clone.status, await clone.clone().text()).toBe(403);
    expect((await send(path, 'POST', { ...post, preview: null }, modeller)).status).toBe(201);
    const read = (await (await send(`${path}/post`, 'GET')).json()) as Record<string, unknown>;
    expect(read).not.toHaveProperty('preview');
  });

  it('refuses an empty locale at the schema, as MCP does', async () => {
    const { send } = setup();
    await send(`${M}/content-types`, 'POST', post);
    const created = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' } },
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    const res = await send(`${M}/entries/${entry.id}/preview-link`, 'POST', { locale: '' });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain('Unknown locale');
  });

  it('sets and clears the template alone, keeping a published type published', async () => {
    const { send } = setup();
    const { preview: _p, ...bare } = post;
    expect((await send(`${M}/content-types`, 'POST', bare)).status).toBe(201);
    expect((await send(`${M}/content-types/post/published`, 'POST')).status).toBe(200);
    const set = await send(`${M}/content-types/post/preview`, 'PUT', { urlTemplate: TEMPLATE });
    expect(set.status, await set.clone().text()).toBe(200);
    expect(await set.json()).toMatchObject({
      status: 'published',
      preview: { urlTemplate: TEMPLATE },
      fields: [{ apiId: 'title' }, { apiId: 'slug' }],
    });
    const cleared = await send(`${M}/content-types/post/preview`, 'PUT', { urlTemplate: null });
    expect(await cleared.json()).not.toHaveProperty('preview');
    // The domain's check and the body's shape both answer 422; an unknown type 404.
    const bad = await send(`${M}/content-types/post/preview`, 'PUT', {
      urlTemplate: 'https://site.example/p/{id}',
    });
    expect(bad.status).toBe(422);
    expect((await send(`${M}/content-types/post/preview`, 'PUT', {})).status).toBe(422);
    const missing = await send(`${M}/content-types/nope/preview`, 'PUT', { urlTemplate: null });
    expect(missing.status).toBe(404);
    // A Delivery key can't change the model.
    const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
    const refused = await send(
      `${M}/content-types/post/preview`,
      'PUT',
      { urlTemplate: null },
      cda,
    );
    expect(refused.status).toBe(403);
    // A modeller whose grant leaves the type out can't point its tokens somewhere, only clear it.
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    const role = (await (
      await send(
        '/spaces/s1/roles',
        'POST',
        {
          name: 'model-pages',
          scopes: ['content:manage', 'preview:read'],
          contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write'] }],
        },
        admin,
      )
    ).json()) as { id: string };
    const key = (await (
      await send('/spaces/s1/api-keys', 'POST', { kind: 'cma', roleId: role.id }, admin)
    ).json()) as { token: string };
    const modeller = { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' };
    const path = `${M}/content-types/post/preview`;
    expect((await send(path, 'PUT', { urlTemplate: TEMPLATE }, modeller)).status).toBe(403);
    const clear = await send(path, 'PUT', { urlTemplate: null }, modeller);
    expect(clear.status, await clear.clone().text()).toBe(200);
  });

  it('documents the setting and the preview link’s frontendUrl in the OpenAPI spec', async () => {
    const { app } = setup();
    const spec = JSON.stringify(await (await app.request('/openapi.json')).json());
    expect(spec).toContain('/spaces/{space}/environments/{env}/entries/{id}/preview-link');
    expect(spec).toContain('/spaces/{space}/environments/{env}/content-types/{apiId}/preview');
    expect(spec).toContain('frontendUrl');
    expect(spec).toContain('urlTemplate');
  });
});
