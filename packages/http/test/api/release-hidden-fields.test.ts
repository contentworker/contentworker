import type { ApiConfig } from '@contentworker/platform/config';
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
const M = '/spaces/s1/environments/main';

describe('shipping a release with a refusal in a field the role can’t read', () => {
  let app: ReturnType<typeof createApp>;

  const keyFor = async (grant: Record<string, unknown>) => {
    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: `Role ${Math.random()}`,
        scopes: ['content:write', 'content:publish', 'preview:read'],
        contentGrants: [
          { contentTypeApiId: 'story', actions: ['read', 'write', 'publish'], ...grant },
        ],
      }),
    });
    expect(role.status).toBe(201);
    const { id } = (await role.json()) as { id: string };
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: id }),
    });
    const { token } = (await key.json()) as { token: string };
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };

  const post = async <T>(path: string, body?: unknown, headers = admin) =>
    (await (
      await app.request(`${M}${path}`, {
        method: 'POST',
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    ).json()) as T;

  /** A release holding a story whose `source` links an entry deleted since. */
  let releaseId: string;
  let sourceId: string;
  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
    await post('/content-types', {
      apiId: 'story',
      name: 'Story',
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
          apiId: 'source',
          name: 'Source',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    await post('/content-types/story/published');
    sourceId = (
      await post<{ entry: { id: string } }>('/entries', {
        contentTypeApiId: 'story',
        fields: { title: { 'en-US': 'Source' } },
      })
    ).entry.id;
    const story = await post<{ entry: { id: string } }>('/entries', {
      contentTypeApiId: 'story',
      fields: {
        title: { 'en-US': 'Story' },
        source: { 'en-US': { id: sourceId, linkType: 'Entry' } },
      },
    });
    await app.request(`${M}/entries/${sourceId}`, { method: 'DELETE', headers: admin });
    await app.request(`${M}/entries/${sourceId}/permanent`, { method: 'DELETE', headers: admin });
    releaseId = (await post<{ id: string }>('/releases', { title: 'Launch' })).id;
    await post(`/releases/${releaseId}/items`, { entityId: story.entry.id });
  });

  const ship = (headers: Record<string, string>) =>
    app.request(`${M}/releases/${releaseId}/published`, { method: 'POST', headers });

  it('counts the issue for a role that denies the field, naming neither it nor its target', async () => {
    const res = await ship(await keyFor({ deniedFields: ['source'] }));
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text).error.issues).toEqual([
      expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
    ]);
    expect(text).not.toContain('source');
    expect(text).not.toContain(sourceId);
  });

  it('names it to a role that reads the field', async () => {
    const res = await ship(await keyFor({}));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { issues: unknown } }).error.issues).toEqual([
      { field: 'source', message: `Linked entry "${sourceId}" does not exist` },
    ]);
  });
});
