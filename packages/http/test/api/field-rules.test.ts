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

const listing = {
  apiId: 'listing',
  name: 'Listing',
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
    {
      apiId: 'status',
      name: 'Status',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 1,
    },
    {
      apiId: 'soldTo',
      name: 'Sold to',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 2,
      rules: [{ action: 'hide', when: { field: 'status', operator: 'ne', value: 'sold' } }],
    },
    {
      apiId: 'price',
      name: 'Price',
      type: 'Number',
      localized: false,
      required: false,
      position: 3,
      rules: [{ action: 'disable', when: { field: 'status', operator: 'eq', value: 'sold' } }],
    },
  ],
};

function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: cma, body: body ? JSON.stringify(body) : undefined });
  return { send, ctx };
}

describe('conditional field rules over HTTP', () => {
  it('stores rules and judges entries by them', async () => {
    const { send } = setup();
    expect((await send(`${M}/content-types`, 'POST', listing)).status).toBe(201);
    await send(`${M}/content-types/listing/published`, 'POST');
    const got = (await (await send(`${M}/content-types/listing`, 'GET')).json()) as {
      fields: Record<string, unknown>[];
    };
    expect(got.fields[2]?.rules).toEqual(listing.fields[2]?.rules);

    // Hidden while not sold: not required.
    const open = await send(`${M}/entries`, 'POST', {
      contentTypeApiId: 'listing',
      fields: { title: { 'en-US': 'Flat' }, status: { 'en-US': 'open' }, price: {} },
    });
    expect(open.status).toBe(201);
    const created = (await open.json()) as { entry: { id: string } };

    // Sold: shown, so required; price disabled, so it keeps its stored (empty) value.
    const sold = await send(`${M}/entries/${created.entry.id}`, 'PUT', {
      fields: {
        title: { 'en-US': 'Flat' },
        status: { 'en-US': 'sold' },
        price: { 'en-US': 100 },
      },
    });
    expect(sold.status).toBe(422);
    const text = JSON.stringify(await sold.json());
    expect(text).toContain('Field is required');
    expect(text).toContain('read-only while its rules disable it');
  });

  it('refuses a rule that reads no sibling, naming the field', async () => {
    const { send } = setup();
    const bad = {
      ...listing,
      fields: [
        listing.fields[0],
        {
          ...listing.fields[2],
          rules: [{ action: 'hide', when: { field: 'nope', operator: 'empty' } }],
        },
      ],
    };
    const res = await send(`${M}/content-types`, 'POST', bad);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('not a sibling field');
  });

  it('documents rules in the OpenAPI field schema', async () => {
    const { send } = setup();
    const spec = JSON.stringify(await (await send('/openapi.json', 'GET')).json());
    expect(spec).toContain('Hide or disable the field while a sibling matches');
    expect(spec).toContain('notEmpty');
  });
});
