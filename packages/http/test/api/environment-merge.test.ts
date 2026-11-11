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
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };

const symbol = (apiId: string) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
});
const page = (variants: unknown[]) => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  fields: [
    { ...symbol('title'), required: true },
    { ...symbol('body'), position: 1, type: 'Array', items: { type: 'Component', variants } },
  ],
});
const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading')] };
const cta = { apiId: 'cta', name: 'CTA', fields: [symbol('label')] };

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  await app.request('/spaces/s1/environments', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ id: 'staging' }),
  });
  // Staging dropped the CTA block; main still has it.
  for (const [env, variants] of [
    ['staging', [hero]],
    ['main', [hero, cta]],
  ] as const) {
    const base = `/spaces/s1/environments/${env}`;
    await app.request(`${base}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify(page([...variants])),
    });
    await app.request(`${base}/content-types/page/published`, { method: 'POST', headers: admin });
  }
});

describe('merge over HTTP', () => {
  it('refuses with a 422 a content type that drops a block variant the target’s entries use', async () => {
    const held = await app.request('/spaces/s1/environments/main/entries', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': 'Home' },
          body: { 'en-US': [{ _type: 'cta', label: 'Secret launch copy' }] },
        },
      }),
    });
    const heldId = ((await held.json()) as { entry: { id: string } }).entry.id;

    const res = await app.request('/spaces/s1/merge', {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ source: 'staging', target: 'main', contentTypes: ['page'] }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: 'validation_failed',
        message: 'One or more fields are invalid',
        issues: [
          {
            field: 'contentTypes',
            message: `The content type "page" can't go to main: it removes a block variant 1 entry there still uses: body: cta (entry ${heldId}). Change or clear those values there first, or leave "page" out of the merge`,
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('Secret launch copy');
    // Main's page still takes the CTA block.
    const kept = await app.request('/spaces/s1/environments/main/content-types/page', {
      headers: admin,
    });
    expect(JSON.stringify(await kept.json())).toContain('"cta"');
  });

  it('merges the type once nothing in the target holds what it removes', async () => {
    const res = await app.request('/spaces/s1/merge', {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ source: 'staging', target: 'main', contentTypes: ['page'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mergedContentTypes: ['page'], mergedEntries: [] });
  });
});
