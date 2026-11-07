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
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

const symbol = (apiId: string, position = 0, required = false) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required,
  position,
});
const blocks = (apiId: string, variants: unknown[], position: number) => ({
  apiId,
  name: apiId,
  type: 'Array',
  localized: false,
  required: false,
  position,
  items: { type: 'Component', variants },
});

const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading', 0, true)] };
const cta = { apiId: 'cta', name: 'Call to action', fields: [symbol('label', 0, true)] };
const section = {
  apiId: 'section',
  name: 'Section',
  fields: [symbol('title'), blocks('items', [hero, cta], 1)],
};

interface Saved {
  entry: { id: string; currentVersion: number };
  fields: { body: { 'en-US': { _type: string; _key: string; items?: { _key: string }[] }[] } };
  keys: Record<string, string>;
  inverse: unknown[];
}

async function setup() {
  const { ctx, rag, blob, ai } = wire(config);
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
    fields: [symbol('title', 0, true), blocks('body', [hero, cta, section], 1)],
  };
  expect((await send('/content-types', 'POST', type)).status).toBe(201);
  await send('/content-types/page/published', 'POST');
  const created = (await (
    await send('/entries', 'POST', {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: {
          'en-US': [
            { _type: 'hero', heading: 'Welcome' },
            { _type: 'section', title: 'Features', items: [{ _type: 'cta', label: 'Try' }] },
          ],
        },
      },
    })
  ).json()) as Saved;
  const [h, s] = created.fields.body['en-US'];
  return {
    app,
    send,
    id: created.entry.id,
    hero: h?._key as string,
    section: s?._key as string,
    cta: s?.items?.[0]?._key as string,
  };
}

describe('patching an entry’s blocks over HTTP', () => {
  it('applies key-addressed ops as one new draft version', async () => {
    const { send, id, hero, section, cta } = await setup();
    const res = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 1,
      ops: [
        {
          op: 'insert',
          field: 'body',
          parent: { key: section, slot: 'items' },
          before: cta,
          block: { _type: 'hero', heading: 'Fast' },
          ref: 'fast',
        },
        { op: 'move', field: 'body', key: hero, to: { after: section } },
        { op: 'update', field: 'body', key: cta, set: { label: 'Try it free' } },
      ],
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Saved;
    expect(saved.entry.currentVersion).toBe(2);
    const body = saved.fields.body['en-US'];
    expect(body.map((b) => b._key)).toEqual([section, hero]);
    expect(body[0]?.items).toEqual([
      { _type: 'hero', _key: saved.keys.fast, heading: 'Fast' },
      { _type: 'cta', _key: cta, label: 'Try it free' },
    ]);
    // The outline reads the new version back, ready for the next patch.
    const outline = await send(`/entries/${id}/blocks?field=body`, 'GET');
    expect(outline.status).toBe(200);
    const read = (await outline.json()) as { version: number; fields: Record<string, unknown> };
    expect(read.version).toBe(2);
    expect(read.fields).toMatchObject({
      body: {
        'en-US': [
          {
            key: section,
            type: 'section',
            path: 'body[0]',
            children: { items: [{ key: saved.keys.fast, label: 'Fast' }, { key: cta }] },
          },
          { key: hero, type: 'hero', name: 'Hero', label: 'Welcome', path: 'body[1]' },
        ],
      },
    });
  });

  it('undoes a patch with its inverse', async () => {
    const { send, id, section } = await setup();
    const before = (await (await send(`/entries/${id}`, 'GET')).json()) as Saved;
    const patched = (await (
      await send(`/entries/${id}/blocks`, 'PATCH', {
        expectedVersion: 1,
        ops: [{ op: 'duplicate', field: 'body', key: section }],
      })
    ).json()) as Saved;
    const undone = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 2,
      ops: patched.inverse,
    });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as Saved).fields).toEqual(before.fields);
  });

  it('answers 409 for a stale expectedVersion and 422 naming the op that failed', async () => {
    const { send, id, hero } = await setup();
    const stale = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 7,
      ops: [{ op: 'remove', field: 'body', key: hero }],
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('conflict');

    const bad = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 1,
      ops: [
        { op: 'remove', field: 'body', key: hero },
        { op: 'move', field: 'body', key: hero, to: { index: 0 } },
      ],
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { issues: unknown[] } }).error.issues).toEqual([
      {
        op: 1,
        field: 'ops[1]',
        locale: 'en-US',
        message: `No block with _key "${hero}" in body (en-US)`,
      },
    ]);
    // Neither saved anything.
    const now = (await (await send(`/entries/${id}`, 'GET')).json()) as Saved;
    expect(now.entry.currentVersion).toBe(1);
  });

  it('refuses a body without expectedVersion or with too many ops', async () => {
    const { send, id, hero } = await setup();
    const op = { op: 'remove', field: 'body', key: hero };
    expect((await send(`/entries/${id}/blocks`, 'PATCH', { ops: [op] })).status).toBe(422);
    const many = await send(`/entries/${id}/blocks`, 'PATCH', {
      expectedVersion: 1,
      ops: Array.from({ length: 101 }, () => op),
    });
    expect(many.status).toBe(422);
  });

  it('needs content write to patch and preview read to outline', async () => {
    const { send, id, hero } = await setup();
    const patch = await send(
      `/entries/${id}/blocks`,
      'PATCH',
      { expectedVersion: 1, ops: [{ op: 'remove', field: 'body', key: hero }] },
      cpa,
    );
    expect(patch.status).toBe(403);
    expect((await send(`/entries/${id}/blocks`, 'GET', undefined, cpa)).status).toBe(200);
  });

  it('checks a patch without saving it, with the same refusals', async () => {
    const { send, id, hero } = await setup();
    const res = await send('/entries/blocks/validate', 'POST', {
      entryId: id,
      expectedVersion: 1,
      ops: [{ op: 'remove', field: 'body', key: hero }],
    });
    expect(res.status).toBe(200);
    const checked = (await res.json()) as {
      valid: boolean;
      fields: Saved['fields'];
      applied: unknown[];
    };
    expect(checked.valid).toBe(true);
    expect(checked.fields.body['en-US'].map((b) => b._type)).toEqual(['section']);
    expect(checked.applied).toEqual([{ op: 'remove', field: 'body', locale: 'en-US', key: hero }]);
    // Nothing was written.
    const now = (await (await send(`/entries/${id}`, 'GET')).json()) as Saved;
    expect(now.entry.currentVersion).toBe(1);

    const stale = await send('/entries/blocks/validate', 'POST', {
      entryId: id,
      expectedVersion: 2,
      ops: [{ op: 'remove', field: 'body', key: hero }],
    });
    expect(stale.status).toBe(409);
    const broken = await send('/entries/blocks/validate', 'POST', {
      entryId: id,
      expectedVersion: 1,
      ops: [{ op: 'update', field: 'body', key: hero, unset: ['heading'] }],
    });
    expect(broken.status).toBe(422);
    const preview = await send(
      '/entries/blocks/validate',
      'POST',
      { entryId: id, expectedVersion: 1, ops: [{ op: 'remove', field: 'body', key: hero }] },
      cpa,
    );
    expect(preview.status).toBe(403);
  });

  it('is described in the OpenAPI document with the body it parses', async () => {
    const { app } = await setup();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown; summary?: string }>>;
    };
    const path = spec.paths['/spaces/{space}/environments/{env}/entries/{id}/blocks'];
    expect(path?.patch?.summary).toBe('Patch an entry’s blocks');
    expect(path?.patch?.requestBody).toBeDefined();
    expect(path?.get?.summary).toBe('Outline an entry’s blocks');
  });
});
