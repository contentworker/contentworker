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

const M = '/spaces/s1/environments/main';
type Fields = Record<string, Record<string, unknown>>;

/**
 * A writer whose role makes `price` read-only and hides `notes`, saving the way the admin's
 * entry form and canvas do: every field it read, edited or not, sent back in one PUT.
 */
async function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const as = (headers: Record<string, string>) => (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const send = as({ Authorization: 'Bearer cma', 'Content-Type': 'application/json' });
  await send(`${M}/content-types`, 'POST', {
    apiId: 'deal',
    name: 'Deal',
    displayField: 'title',
    fields: [
      { apiId: 'title', name: 'Title', type: 'Symbol', localized: false, position: 0 },
      { apiId: 'price', name: 'Price', type: 'Number', localized: false, position: 1 },
      { apiId: 'notes', name: 'Notes', type: 'Text', localized: false, position: 2 },
      { apiId: 'tags', name: 'Tags', type: 'Object', localized: false, position: 3 },
    ],
  });
  await send(`${M}/content-types/deal/published`, 'POST');
  const made = (await (
    await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'deal',
      fields: {
        title: { 'en-US': 'A' },
        price: { 'en-US': 250 },
        notes: { 'en-US': 'secret' },
        tags: { 'en-US': { b: 2, a: 1 } },
      },
    })
  ).json()) as { entry: { id: string } };
  const role = (await (
    await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Deal writer',
        scopes: ['content:write', 'preview:read'],
        contentGrants: [
          {
            contentTypeApiId: 'deal',
            actions: ['read', 'write'],
            readOnlyFields: ['price', 'tags'],
            deniedFields: ['notes'],
          },
        ],
      }),
    })
  ).json()) as { id: string };
  const { token } = (await (
    await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    })
  ).json()) as { token: string };
  const writer = as({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const id = made.entry.id;
  const read = async (by = writer) =>
    (await (await by(`${M}/entries/${id}`, 'GET')).json()) as {
      fields: Fields;
      entry: { currentVersion: number };
    };
  return { send, writer, id, read };
}

describe('saving every field a role may read', () => {
  it('saves when the read-only fields come back as they were read', async () => {
    const { send, writer, id, read } = await setup();
    const { fields } = await read();
    // The writer reads the read-only fields, never the hidden one.
    expect(Object.keys(fields).sort()).toEqual(['price', 'tags', 'title']);
    // Sent back with its keys in another order: the same value, so no write to it.
    const edit = { ...fields, title: { 'en-US': 'B' }, tags: { 'en-US': { a: 1, b: 2 } } };

    const checked = await writer(`${M}/entries/validate`, 'POST', { entryId: id, fields: edit });
    expect(checked.status, await checked.clone().text()).toBe(200);
    const saved = await writer(`${M}/entries/${id}`, 'PUT', { fields: edit, expectedVersion: 1 });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain('secret');

    // The hidden field kept its stored value through a save that never carried it.
    const stored = await read(send);
    expect(stored.fields).toEqual({
      title: { 'en-US': 'B' },
      price: { 'en-US': 250 },
      notes: { 'en-US': 'secret' },
      tags: { 'en-US': { a: 1, b: 2 } },
    });
  });

  it('still refuses a changed read-only value, on the save and its dry run', async () => {
    const { send, writer, id, read } = await setup();
    const { fields } = await read();
    const edit = { ...fields, title: { 'en-US': 'B' }, price: { 'en-US': 1 } };
    const checked = await writer(`${M}/entries/validate`, 'POST', { entryId: id, fields: edit });
    expect(checked.status).toBe(403);
    const saved = await writer(`${M}/entries/${id}`, 'PUT', { fields: edit });
    expect(saved.status).toBe(403);
    expect(await saved.text()).toContain('deal.price');
    // A read-only value the entry doesn't hold is a write too, not a value left alone.
    const cleared = await writer(`${M}/entries/${id}`, 'PUT', {
      fields: { title: { 'en-US': 'B' }, price: { 'en-US': null } },
    });
    expect(cleared.status).toBe(403);
    expect((await read(send)).entry.currentVersion).toBe(1);
  });

  it('refuses a hidden field even when sent with its stored value', async () => {
    const { send, writer, id, read } = await setup();
    // Accepting an unchanged hidden value would let a caller guess it, one save at a time.
    const saved = await writer(`${M}/entries/${id}`, 'PUT', {
      fields: { title: { 'en-US': 'B' }, notes: { 'en-US': 'secret' } },
    });
    expect(saved.status).toBe(403);
    expect((await read(send)).entry.currentVersion).toBe(1);
  });
});
