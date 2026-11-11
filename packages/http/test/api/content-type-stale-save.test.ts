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

const event = {
  apiId: 'event',
  name: 'Event',
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
};

function setup() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: cma, body: body ? JSON.stringify(body) : undefined });
  return { app, send };
}

describe('POST …/content-types held to expectedVersion', () => {
  it('answers 409 naming the stored version when the type changed since it was read', async () => {
    const { send } = setup();
    expect((await send(`${M}/content-types`, 'POST', event)).status).toBe(201);
    // Someone else saves a description over version 1.
    const theirs = await send(`${M}/content-types`, 'POST', { ...event, description: 'Theirs' });
    expect(((await theirs.json()) as { version: number }).version).toBe(2);

    const stale = await send(`${M}/content-types`, 'POST', {
      ...event,
      group: 'Mine',
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'conflict', details: { version: 2, expectedVersion: 1 } },
    });
    const stored = (await (await send(`${M}/content-types/event`, 'GET')).json()) as {
      version: number;
      description?: string;
      group?: string;
    };
    expect(stored).toMatchObject({ version: 2, description: 'Theirs' });
    expect(stored.group).toBeUndefined();

    const fresh = await send(`${M}/content-types`, 'POST', {
      ...event,
      group: 'Mine',
      expectedVersion: 2,
    });
    expect(fresh.status).toBe(201);
    // The version is the request's, never part of the stored definition.
    const saved = (await fresh.json()) as Record<string, unknown>;
    expect(saved).toMatchObject({ version: 3, group: 'Mine', description: 'Theirs' });
    expect(saved).not.toHaveProperty('expectedVersion');
  });

  it('takes a save without one, and refuses a malformed one', async () => {
    const { send } = setup();
    await send(`${M}/content-types`, 'POST', event);
    expect((await send(`${M}/content-types`, 'POST', { ...event, name: 'Gig' })).status).toBe(201);
    const bad = await send(`${M}/content-types`, 'POST', { ...event, expectedVersion: -1 });
    expect(bad.status).toBe(422);
  });

  it('describes expectedVersion and the 409 in the OpenAPI document', async () => {
    const { app } = setup();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            description?: string;
            requestBody?: {
              content: Record<
                string,
                { schema: { properties?: Record<string, { description?: string }> } }
              >;
            };
          }
        >
      >;
    };
    const post = spec.paths['/spaces/{space}/environments/{env}/content-types']?.post;
    expect(post?.description).toContain('expectedVersion');
    expect(post?.description).toContain('409');
    const props = post?.requestBody?.content['application/json']?.schema.properties;
    expect(props?.expectedVersion?.description).toContain('409');
  });
});
