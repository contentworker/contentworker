import {
  assetTextKey,
  createAsset,
  createContentType,
  SYSTEM_CALLER,
} from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
import type { FakeBlobStore, InMemoryContentStore, StubAIProvider } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * `…/ai-projects`: read with `content:write` (never a Preview or Delivery key), written with
 * `content:manage`, the default `space:admin`'s; the project's text and references reach the AI
 * calls that take one, and what was used comes back in their answers; writes are audited by the
 * parts they changed.
 */
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
const scope = { spaceId: 's1', environmentId: 'main' };
const json = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: false,
        position: 0,
      },
    ],
  });
  const send = (method: string, path: string, body?: unknown, headers = json('admin')) =>
    app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** A key bound to a role holding exactly `scopes`. */
  const keyWith = async (scopes: string[]) => {
    const role = await send('POST', '/spaces/s1/roles', { name: scopes.join(' '), scopes });
    const { id } = (await role.json()) as { id: string };
    const key = await send('POST', '/spaces/s1/api-keys', { kind: 'cma', roleId: id });
    const { token } = (await key.json()) as { token: string };
    return json(token);
  };
  const doc = async (fileName: string, text: string) => {
    const blob = wired.blob as FakeBlobStore;
    const { asset } = await createAsset(wired.ctx, blob, scope, {
      fileName,
      contentType: 'application/pdf',
    });
    await blob.put(asset.r2Key as string, 'bytes', 'application/pdf');
    await blob.put(assetTextKey(scope, asset.id, 1) as string, text, 'text/markdown');
    return asset;
  };
  return { wired, send, keyWith, doc, ai: wired.ai as StubAIProvider };
}

describe('AI projects over HTTP', () => {
  it('creates, reads with reference status, updates at a version and deletes', async () => {
    const { send, doc } = await makeApp();
    const a = await doc('spec.pdf', 'The mixer weighs 40 kg.');
    const created = await send('POST', `${M}/ai-projects`, {
      name: 'Northwind launch',
      instructions: 'Say spec sheet.',
      writer: { name: 'Northwind team', description: 'Plain.' },
      references: [{ assetId: a.id }],
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string; version: number };
    const got = await send('GET', `${M}/ai-projects/${project.id}`);
    expect(await got.json()).toMatchObject({
      version: 1,
      references: [{ assetId: a.id, version: 1, text: 'ready', updateAvailable: false }],
    });
    const list = (await (await send('GET', `${M}/ai-projects`)).json()) as { total: number };
    expect(list.total).toBe(1);
    const stale = await send('PUT', `${M}/ai-projects/${project.id}`, {
      name: 'Renamed',
      expectedVersion: 7,
    });
    expect(stale.status).toBe(409);
    const updated = await send('PUT', `${M}/ai-projects/${project.id}`, {
      name: 'Renamed',
      expectedVersion: 1,
    });
    expect(await updated.json()).toMatchObject({ unchanged: false, project: { version: 2 } });
    expect((await send('DELETE', `${M}/ai-projects/${project.id}?version=2`)).status).toBe(204);
    expect((await send('GET', `${M}/ai-projects/${project.id}`)).status).toBe(404);
  });

  it('is read with content:write: a Preview or Delivery key can’t list projects', async () => {
    const { send } = await makeApp();
    expect((await send('GET', `${M}/ai-projects`, undefined, json('cpa'))).status).toBe(403);
    expect((await send('GET', `${M}/ai-projects`, undefined, json('cda'))).status).toBe(403);
    expect((await send('GET', `${M}/ai-projects`, undefined, json('cma'))).status).toBe(200);
  });

  it('gives content:manage 403 on the default project’s PUT and DELETE, and on setting it', async () => {
    const { send, keyWith } = await makeApp();
    const manager = await keyWith(['content:write', 'content:manage']);
    const created = await send('POST', `${M}/ai-projects`, { name: 'P' }, manager);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await send('PUT', `${M}/ai-projects/default`, { projectId: id }, manager)).status).toBe(
      403,
    );
    const set = await send('PUT', `${M}/ai-projects/default`, { projectId: id });
    expect(await set.json()).toEqual({ projectId: id, unchanged: false });
    expect(
      (await send('PUT', `${M}/ai-projects/${id}`, { name: 'Q', expectedVersion: 2 }, manager))
        .status,
    ).toBe(403);
    expect((await send('DELETE', `${M}/ai-projects/${id}`, undefined, manager)).status).toBe(403);
    // A project that isn't the default is content:manage's.
    const other = await send('POST', `${M}/ai-projects`, { name: 'Other' }, manager);
    const otherId = ((await other.json()) as { id: string }).id;
    expect((await send('DELETE', `${M}/ai-projects/${otherId}`, undefined, manager)).status).toBe(
      204,
    );
  });

  it('refuses to delete a project an AI action names: 409 project_in_use, listing it', async () => {
    const { send } = await makeApp();
    const { id } = (await (await send('POST', `${M}/ai-projects`, { name: 'P' })).json()) as {
      id: string;
    };
    const action = await send('POST', `${M}/ai-actions`, {
      name: 'Tagline',
      promptTemplate: 'Write',
      projectId: id,
    });
    expect(action.status).toBe(201);
    const actionId = ((await action.json()) as { id: string }).id;
    const refused = await send('DELETE', `${M}/ai-projects/${id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'project_in_use', aiActions: [actionId], agentSchedules: [] },
    });
    // An AI action can't name a project that isn't there.
    const bad = await send('POST', `${M}/ai-actions`, {
      name: 'X',
      promptTemplate: 'x',
      projectId: 'nope',
    });
    expect(bad.status).toBe(422);
  });

  it('carries the project into a draft and answers what it used', async () => {
    const { send, doc, ai } = await makeApp();
    const a = await doc('spec.pdf', 'The mixer weighs 40 kg.');
    const { id } = (await (
      await send('POST', `${M}/ai-projects`, {
        name: 'P',
        instructions: 'House style.',
        references: [{ assetId: a.id }],
      })
    ).json()) as { id: string };
    const drafted = await send('POST', `${M}/entries/generate`, {
      contentTypeApiId: 'article',
      prompt: 'Write about the mixer',
      projectId: id,
    });
    expect(drafted.status).toBe(200);
    const body = (await drafted.json()) as { project: unknown };
    expect(body.project).toMatchObject({
      id,
      version: 1,
      references: [{ assetId: a.id, version: 1, used: true }],
    });
    const req = ai.requests.at(-1);
    expect(req?.system).toContain('House style.');
    expect(req?.prompt).toContain('40 kg');
    // A project that isn't there is a 404, null takes none.
    expect(
      (
        await send('POST', `${M}/entries/generate`, {
          contentTypeApiId: 'article',
          prompt: 'x',
          projectId: 'nope',
        })
      ).status,
    ).toBe(404);
    const none = await send('POST', `${M}/entries/generate`, {
      contentTypeApiId: 'article',
      prompt: 'x',
      projectId: null,
    });
    expect(((await none.json()) as { project: unknown }).project).toBeNull();
  });

  it('pages a reference’s text for a caller who can read it, and 404s one who can’t', async () => {
    const { send, doc, keyWith } = await makeApp();
    const a = await doc('spec.pdf', 'x'.repeat(9_000));
    const { id } = (await (
      await send('POST', `${M}/ai-projects`, { name: 'P', references: [{ assetId: a.id }] })
    ).json()) as { id: string };
    const page = await send('GET', `${M}/ai-projects/${id}/references/${a.id}/text?limit=5000`);
    expect(await page.json()).toMatchObject({ offset: 0, nextOffset: 5000, total: 9000 });
    const noAssets = await keyWith(['content:write']);
    expect(
      (await send('GET', `${M}/ai-projects/${id}/references/${a.id}/text`, undefined, noAssets))
        .status,
    ).toBe(404);
  });

  it('audits a create and a default change by the project, naming parts, never text', async () => {
    const { send, wired } = await makeApp();
    const { id } = (await (
      await send('POST', `${M}/ai-projects`, { name: 'P', instructions: 'Secret wording' })
    ).json()) as { id: string };
    await send('PUT', `${M}/ai-projects/default`, { projectId: id });
    const rows = await (wired.ctx.store as InMemoryContentStore).audit.list('s1', {});
    const ours = rows.filter((r) => r.targetType === 'ai_project');
    expect(ours.map((r) => [r.action, r.targetId]).sort()).toEqual([
      [`POST ${M.replace('s1', ':space').replace('main', ':env')}/ai-projects`, id],
      [`PUT ${M.replace('s1', ':space').replace('main', ':env')}/ai-projects/default`, id],
    ]);
    expect(JSON.stringify(rows)).not.toContain('Secret wording');
  });
});
