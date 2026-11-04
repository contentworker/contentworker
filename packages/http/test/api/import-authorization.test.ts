import type { ApiConfig } from '@contentworker/platform/config';
import { spaceExportFixture } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const EMPTY = '/spaces/s1/environments/empty';

const field = (apiId: string, position: number) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

const CSV = 'id,title,notes\nA,One,\nB,Two,secret\n';
const importBody = (contentTypeApiId: string) =>
  JSON.stringify({
    source: 'csv',
    payload: CSV,
    mapping: { contentTypeApiId, fields: { title: 'title', internalNotes: 'notes' } },
    sourceOptions: { identityField: 'id' },
  });

let app: ReturnType<typeof createApp>;

/** A key bound to a new role holding `scopes` and `contentGrants`. */
const keyFor = async (scopes: string[], contentGrants: unknown[]) => {
  const roleRes = await app.request('/spaces/s1/roles', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: `r${Math.random()}`, scopes, contentGrants }),
  });
  expect(roleRes.status).toBe(201);
  const { id } = (await roleRes.json()) as { id: string };
  const keyRes = await app.request('/spaces/s1/api-keys', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ kind: 'cma', roleId: id }),
  });
  const { token } = (await keyRes.json()) as { token: string };
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
};

const titles = async (type: string) => {
  const res = await app.request(`/preview/s1/main/entries?contentType=${type}`, {
    headers: { Authorization: 'Bearer cpa' },
  });
  const { items } = (await res.json()) as {
    items: { fields: Record<string, Record<string, string>> }[];
  };
  return items.map((i) => i.fields);
};

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  for (const apiId of ['post', 'page']) {
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        apiId,
        name: apiId,
        displayField: 'title',
        fields: [field('title', 0), field('internalNotes', 1)],
      }),
    });
    await app.request(`${M}/content-types/${apiId}/published`, { method: 'POST', headers: admin });
  }
});

describe('importing as a role over HTTP', () => {
  const POST_ONLY = [{ contentTypeApiId: 'post', actions: ['read', 'write'] }];
  const NO_NOTES = [
    { contentTypeApiId: 'post', actions: ['read', 'write'], deniedFields: ['internalNotes'] },
  ];

  it.each(['/imports/analyze', '/imports', '/imports/job'])(
    'refuses a type the role cannot write at %s',
    async (path) => {
      const headers = await keyFor(['content:write'], POST_ONLY);
      const res = await app.request(`${M}${path}`, {
        method: 'POST',
        headers,
        body: importBody('page'),
      });
      expect(res.status).toBe(403);
      expect(await titles('page')).toHaveLength(0);
    },
  );

  it('reports a record setting a denied field and writes the rest', async () => {
    const headers = await keyFor(['content:write'], NO_NOTES);
    const analyzed = await app.request(`${M}/imports/analyze`, {
      method: 'POST',
      headers,
      body: importBody('post'),
    });
    expect(await analyzed.json()).toMatchObject({
      willCreate: 1,
      invalid: 1,
      issues: [
        { externalId: 'B', messages: ['internalNotes: your role may not write this field'] },
      ],
    });

    const run = await app.request(`${M}/imports`, {
      method: 'POST',
      headers,
      body: importBody('post'),
    });
    expect(run.status).toBe(201);
    expect(await run.json()).toMatchObject({ created: 1, skipped: 1 });
    expect(JSON.stringify(await titles('post'))).not.toContain('secret');
  });

  it('never queues a blocked record in a durable job', async () => {
    const headers = await keyFor(['content:write'], NO_NOTES);
    const res = await app.request(`${M}/imports/job`, {
      method: 'POST',
      headers,
      body: importBody('post'),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      job: { action: 'import', totalItems: 1 },
      analysis: { invalid: 1 },
    });
  });

  it('leaves a key with no role importing as before', async () => {
    const res = await app.request(`${M}/imports`, {
      method: 'POST',
      headers: cma,
      body: importBody('page'),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: 2, skipped: 0 });
  });
});

describe('environment-wide operations as a role over HTTP', () => {
  const NARROW = [{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }];
  const FIELD_RULE = [
    {
      contentTypeApiId: '*',
      actions: ['read', 'write', 'publish'],
      readOnlyFields: ['internalNotes'],
    },
  ];
  const WIDE = [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }];
  const scopes = ['content:manage', 'content:write', 'preview:read'];

  const snapshot = async () => {
    const res = await app.request(`${M}/export`, { headers: admin });
    expect(res.status).toBe(200);
    return res.text();
  };

  beforeEach(async () => {
    const res = await app.request('/spaces/s1/environments', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ id: 'empty', name: 'Empty' }),
    });
    expect(res.status).toBeLessThan(300);
  });

  it('needs content:manage for every one of them', async () => {
    const headers = await keyFor(['content:write', 'preview:read'], WIDE);
    const body = await snapshot();
    const calls: [string, RequestInit][] = [
      [`${M}/export`, { headers }],
      [`${EMPTY}/import`, { method: 'POST', headers, body }],
      [
        `${M}/clone`,
        { method: 'POST', headers, body: JSON.stringify({ targetEnvironmentId: 'empty' }) },
      ],
      [
        `${EMPTY}/imports/space-export`,
        { method: 'POST', headers, body: JSON.stringify({ payload: '{}' }) },
      ],
    ];
    for (const [url, init] of calls) {
      expect((await app.request(url, init)).status).toBe(403);
    }
  });

  it.each([
    ['limited to some types', NARROW],
    ['with a field rule', FIELD_RULE],
  ])('refuses a manager %s', async (_, grants) => {
    const headers = await keyFor(scopes, grants);
    const body = await snapshot();
    const spaceExport = JSON.stringify({ payload: JSON.stringify(spaceExportFixture()) });
    const calls: [string, RequestInit][] = [
      [`${M}/export`, { headers }],
      [`${EMPTY}/import`, { method: 'POST', headers, body }],
      [`${EMPTY}/import?dryRun=true`, { method: 'POST', headers, body }],
      [
        `${M}/clone`,
        { method: 'POST', headers, body: JSON.stringify({ targetEnvironmentId: 'empty' }) },
      ],
      [`${EMPTY}/imports/space-export/analyze`, { method: 'POST', headers, body: spaceExport }],
      [`${EMPTY}/imports/space-export`, { method: 'POST', headers, body: spaceExport }],
    ];
    for (const [url, init] of calls) {
      expect((await app.request(url, init)).status).toBe(403);
    }
  });

  it('asks for publish only when the import publishes', async () => {
    const headers = await keyFor(scopes, [{ contentTypeApiId: '*', actions: ['read', 'write'] }]);
    const body = await snapshot();
    const publishing = await app.request(`${EMPTY}/import?dryRun=true`, {
      method: 'POST',
      headers,
      body,
    });
    expect(publishing.status).toBe(403);
    const drafts = await app.request(`${EMPTY}/import?dryRun=true&publish=false`, {
      method: 'POST',
      headers,
      body,
    });
    expect(drafts.status).toBe(200);
  });

  it('lets a manager holding every type do all of it', async () => {
    const headers = await keyFor(scopes, WIDE);
    expect((await app.request(`${M}/export`, { headers })).status).toBe(200);
    const dryRun = await app.request(`${EMPTY}/import?dryRun=true`, {
      method: 'POST',
      headers,
      body: await snapshot(),
    });
    expect(dryRun.status).toBe(200);
    const clone = await app.request(`${M}/clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targetEnvironmentId: 'empty' }),
    });
    expect(clone.status).toBe(202);
  });
});
