import type { ApiConfig } from '@contentworker/platform/config';
import type { GenerateRequest } from '@contentworker/ports';
import { StubAIProvider } from '@contentworker/test-kit';
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

const symbol = (apiId: string, position = 0, required = false) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required,
  position,
});
const blocks = (apiId: string, variants: unknown[], position: number, required = false) => ({
  apiId,
  name: apiId,
  type: 'Array',
  localized: false,
  required,
  position,
  items: { type: 'Component', variants },
});

const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading', 0, true)] };
const section = {
  apiId: 'section',
  name: 'Section',
  fields: [symbol('title'), blocks('items', [hero], 1)],
};

type Block = { _type: string; _key?: string; items?: Block[] };

/** The app with a model that answers `answer(req)`; and a page entry holding one section. */
async function setup(answer: (req: GenerateRequest) => unknown) {
  const { ctx, rag, blob } = wire(config);
  const ai = new StubAIProvider(answer);
  const app = createApp(ctx, config, rag, blob, ai);
  const send = (path: string, method: string, body?: unknown, headers = cma) =>
    app.request(`${M}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  const type = {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      symbol('title', 0, true),
      blocks('body', [hero, section], 1, true),
      blocks('sidebar', [hero], 2),
    ],
  };
  expect((await send('/content-types', 'POST', type)).status).toBe(201);
  await send('/content-types/page/published', 'POST');
  const created = (await (
    await send('/entries', 'POST', {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: { 'en-US': [{ _type: 'section', title: 'Features', items: [] }] },
      },
    })
  ).json()) as { entry: { id: string }; fields: { body: { 'en-US': Block[] } } };
  return {
    app,
    ai,
    send,
    id: created.entry.id,
    section: created.fields.body['en-US'][0]?._key as string,
  };
}

interface Generated {
  entryId: string | null;
  expectedVersion: number | null;
  ops: unknown[];
  fields: { body: { 'en-US': Block[] } };
  issues: { field: string }[];
  unresolvedImages: unknown[];
}

describe('composing blocks over HTTP', () => {
  it('answers the ops for a slot, which patch the entry as composed', async () => {
    const { send, ai, id, section } = await setup(() => ({
      blocks: [
        { _type: 'hero', heading: 'Fast' },
        { _type: 'hero', heading: 'Safe' },
      ],
    }));
    const res = await send('/entries/blocks/generate', 'POST', {
      entryId: id,
      field: 'body',
      parent: { key: section, slot: 'items' },
      prompt: 'Two reasons to switch',
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Generated;
    expect(out.expectedVersion).toBe(1);
    expect(out.ops).toHaveLength(2);
    expect(out.fields.body['en-US'][0]?.items?.map((b) => b._type)).toEqual(['hero', 'hero']);
    expect(ai.requests[0]?.tier).toBe('flagship');

    // Nothing saved: the ops go to the patch as they are.
    const saved = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: out.expectedVersion,
      ops: out.ops,
    });
    expect(saved.status).toBe(200);
    expect(
      ((await saved.json()) as { entry: { currentVersion: number } }).entry.currentVersion,
    ).toBe(2);
  });

  it('answers a new entry’s field, with the rest it still needs as issues', async () => {
    const { send } = await setup(() => ({ blocks: [{ _type: 'hero', heading: 'Hello' }] }));
    const res = await send('/entries/blocks/generate', 'POST', {
      contentTypeApiId: 'page',
      field: 'body',
      prompt: 'A welcome',
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Generated;
    expect(out.entryId).toBeNull();
    expect(out.fields.body['en-US'].map((b) => b._type)).toEqual(['hero']);
    expect(out.issues.map((i) => i.field)).toEqual(['title']);
  });

  it('refuses an answer that breaks the field with 422, and a request naming both targets', async () => {
    const { send, id } = await setup(() => ({ blocks: [{ _type: 'hero' }] }));
    const broken = await send('/entries/blocks/generate', 'POST', {
      entryId: id,
      field: 'body',
      prompt: 'x',
    });
    expect(broken.status).toBe(422);
    const both = await send('/entries/blocks/generate', 'POST', {
      entryId: id,
      contentTypeApiId: 'page',
      field: 'body',
      prompt: 'x',
    });
    expect(both.status).toBe(422);
  });

  it('refuses a field the caller’s role may not write, before the model is asked', async () => {
    const { app, ai, id } = await setup(() => ({ blocks: [] }));
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Page editor',
        scopes: ['content:write', 'preview:read'],
        contentGrants: [
          { contentTypeApiId: 'page', actions: ['read', 'write'], readOnlyFields: ['sidebar'] },
        ],
      }),
    });
    const { id: roleId } = (await role.json()) as { id: string };
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId }),
    });
    const { token } = (await key.json()) as { token: string };
    const res = await app.request(`${M}/entries/blocks/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: id, field: 'sidebar', prompt: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(ai.requests).toHaveLength(0);
  });

  it('drafts an entry’s blocks field through …/entries/generate', async () => {
    const { send } = await setup((req) =>
      'body' in ((req.outputSchema as { properties: object }).properties ?? {})
        ? { title: 'Home', body: [{ _type: 'hero', heading: 'Hi' }], sidebar: [] }
        : {},
    );
    const res = await send('/entries/generate', 'POST', { contentTypeApiId: 'page', prompt: 'x' });
    expect(res.status).toBe(200);
    const draft = (await res.json()) as { fields: { body: { 'en-US': Block[] } } };
    expect(draft.fields.body['en-US']).toEqual([{ _type: 'hero', heading: 'Hi' }]);
  });

  it('is described in the OpenAPI document, the drafting routes too', async () => {
    const { app } = await setup(() => ({}));
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown; summary?: string }>>;
    };
    const at = (p: string) => spec.paths[`/spaces/{space}/environments/{env}${p}`]?.post;
    expect(at('/entries/blocks/generate')?.summary).toBe('Compose blocks with AI');
    expect(at('/entries/blocks/generate')?.requestBody).toBeDefined();
    expect(at('/entries/generate')?.summary).toBe('Draft an entry’s fields with AI');
    expect(at('/entries/canvas')?.summary).toBe('Map prose into an entry’s fields with AI');
  });
});
