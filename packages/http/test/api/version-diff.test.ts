import type { ApiConfig } from '@contentworker/platform/config';
import { StubAIProvider } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
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

const doc = (...paragraphs: string[]) => ({
  nodeType: 'document',
  content: paragraphs.map((value) => ({
    nodeType: 'paragraph',
    content: [{ nodeType: 'text', value, marks: [] }],
  })),
});

interface Diff {
  from: number;
  to: number;
  hiddenChanges: number;
  changes: {
    field: string;
    name?: string;
    kind: string;
    locales: { locale: string; kind: string; detail?: Record<string, unknown> }[];
  }[];
}

describe('comparing entry versions over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  let id: string;

  const fieldDef = (apiId: string, name: string, type: string, position: number, extra = {}) => ({
    apiId,
    name,
    type,
    localized: false,
    required: false,
    position,
    ...extra,
  });

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
    for (const apiId of ['article', 'page']) {
      await app.request(`${M}/content-types`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          apiId,
          name: apiId,
          displayField: 'title',
          fields: [
            fieldDef('title', 'Headline', 'Symbol', 0),
            fieldDef('body', 'Body copy', 'RichText', 1),
            fieldDef('tags', 'Tags', 'Array', 2, { items: { type: 'Symbol' } }),
            fieldDef('internalNotes', 'Internal notes', 'Symbol', 3),
          ],
        }),
      });
      await app.request(`${M}/content-types/${apiId}/published`, {
        method: 'POST',
        headers: admin,
      });
    }
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        contentTypeApiId: 'article',
        fields: {
          title: { 'en-US': 'Spring launch' },
          body: { 'en-US': doc('We ship in May.', 'Thanks all.') },
          tags: { 'en-US': ['news', 'launch'] },
          internalNotes: { 'en-US': 'draft one' },
        },
      }),
    });
    id = ((await created.json()) as { entry: { id: string } }).entry.id;
    await app.request(`${M}/entries/${id}/published`, { method: 'POST', headers: admin });
    await app.request(`${M}/entries/${id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({
        fields: {
          title: { 'en-US': 'Summer launch' },
          body: { 'en-US': doc('We ship in June.', 'Thanks all.') },
          tags: { 'en-US': ['launch', 'news'] },
          internalNotes: { 'en-US': 'draft two' },
        },
      }),
    });
  });

  const diff = (query: string, headers: Record<string, string> = admin) =>
    app.request(`${M}/entries/${id}/versions/diff?${query}`, { headers });

  it('compares published with the draft, labelled and detailed by field type', async () => {
    const res = await diff('from=published&to=draft');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Diff;
    expect([body.from, body.to]).toEqual([1, 2]);
    expect(body.changes.map((c) => [c.field, c.name, c.kind])).toEqual([
      ['title', 'Headline', 'changed'],
      ['body', 'Body copy', 'changed'],
      ['tags', 'Tags', 'changed'],
      ['internalNotes', 'Internal notes', 'changed'],
    ]);
    const [title, richText, tags] = body.changes.map((c) => c.locales[0]?.detail);
    expect(title).toEqual({
      type: 'text',
      segments: [
        { kind: 'removed', text: 'Spring' },
        { kind: 'added', text: 'Summer' },
        { kind: 'unchanged', text: ' launch' },
      ],
    });
    expect(richText).toMatchObject({
      type: 'richText',
      blocks: [
        { kind: 'changed', nodeType: 'paragraph' },
        { kind: 'unchanged', nodeType: 'paragraph' },
      ],
    });
    expect(tags).toMatchObject({
      type: 'list',
      items: [{ after: 'launch', kind: 'unchanged', moved: true }, { after: 'news' }],
    });
  });

  it('accepts version numbers, and is unchanged against itself', async () => {
    const body = (await (await diff('from=2&to=draft')).json()) as Diff;
    expect(body.changes.every((c) => c.kind === 'unchanged')).toBe(true);
    expect(((await (await diff('from=1&to=2')).json()) as Diff).to).toBe(2);
  });

  it('refuses a reference that is not a version, and one that does not exist', async () => {
    for (const query of ['from=latest&to=draft', 'from=1', 'from=0&to=1', 'from=1.5&to=2']) {
      const res = await diff(query);
      expect(res.status, query).toBe(422);
    }
    expect((await diff('from=1&to=9')).status).toBe(404);
    // An entry never published has no published version to compare.
    const fresh = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ contentTypeApiId: 'article', fields: { title: { 'en-US': 'x' } } }),
    });
    const freshId = ((await fresh.json()) as { entry: { id: string } }).entry.id;
    const res = await app.request(`${M}/entries/${freshId}/versions/diff?from=published&to=draft`, {
      headers: admin,
    });
    expect(res.status).toBe(404);
  });

  it('leaves out fields the caller may not read, and refuses a type it may not', async () => {
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Article reader',
        scopes: ['preview:read'],
        contentGrants: [
          { contentTypeApiId: 'article', actions: ['read'], deniedFields: ['internalNotes'] },
        ],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cpa', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    const reader = { Authorization: `Bearer ${token}` };

    const res = await diff('from=published&to=draft', reader);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Diff;
    expect(body.changes.map((c) => c.field)).not.toContain('internalNotes');
    expect(JSON.stringify(body)).not.toContain('draft two');
    // Counted, so a publisher is never told nothing changed; never named.
    expect(body.hiddenChanges).toBe(1);
    expect(JSON.stringify(body)).not.toContain('internalNotes');

    const same = (await (await diff('from=draft&to=draft', reader)).json()) as Diff;
    expect(same.hiddenChanges).toBe(0);
    const open = (await (await diff('from=published&to=draft', admin)).json()) as Diff;
    expect(open.hiddenChanges).toBe(0);

    const page = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ contentTypeApiId: 'page', fields: { title: { 'en-US': 'p' } } }),
    });
    const pageId = ((await page.json()) as { entry: { id: string } }).entry.id;
    const denied = await app.request(`${M}/entries/${pageId}/versions/diff?from=1&to=draft`, {
      headers: reader,
    });
    expect(denied.status).toBe(403);
  });

  it('is described in the OpenAPI document, with its summary', async () => {
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<string, { summary?: string; responses: Record<string, unknown> }>
      >;
    };
    const op =
      spec.paths['/spaces/{space}/environments/{env}/entries/{id}/versions/diff/summary']?.post;
    expect(op?.summary).toBe('Summarize the changes between two versions');
    expect(JSON.stringify(op?.responses['200'])).toContain('highlights');
  });

  it('is described in the OpenAPI document', async () => {
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<string, { summary?: string; responses: Record<string, unknown> }>
      >;
    };
    const op = spec.paths['/spaces/{space}/environments/{env}/entries/{id}/versions/diff']?.get;
    expect(op?.summary).toBe('Compare two versions');
    expect(JSON.stringify(op?.responses['200'])).toContain('changes');
  });
});

describe('summarizing the changes between two versions over HTTP', () => {
  const answer = { summary: 'The headline moved from spring to summer.', highlights: ['Headline'] };
  const field = (apiId: string, name: string, position: number) => ({
    apiId,
    name,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
  });

  async function setup(mode?: 'mock') {
    const wired = wire(config);
    const ai = new StubAIProvider(() => answer);
    const ctx = mode ? { ...wired.ctx, ai: { mode, timeoutMs: 1000 } } : wired.ctx;
    const app = createApp(ctx, config, wired.rag, wired.blob, ai);
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        apiId: 'article',
        name: 'Article',
        displayField: 'title',
        fields: [field('title', 'Headline', 0), field('notes', 'Notes', 1)],
      }),
    });
    await app.request(`${M}/content-types/article/published`, { method: 'POST', headers: admin });
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': 'Spring' }, notes: { 'en-US': 'one' } },
      }),
    });
    const id = ((await created.json()) as { entry: { id: string } }).entry.id;
    await app.request(`${M}/entries/${id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({
        fields: { title: { 'en-US': 'Summer' }, notes: { 'en-US': 'CONFIDENTIAL two' } },
      }),
    });
    return { app, ai, id };
  }

  const summarize = (
    app: ReturnType<typeof createApp>,
    id: string,
    query: string,
    headers: Record<string, string> = admin,
  ) =>
    app.request(`${M}/entries/${id}/versions/diff/summary?${query}`, { method: 'POST', headers });

  it('answers with the model’s summary of the diff', async () => {
    const { app, ai, id } = await setup();
    const res = await summarize(app, id, 'from=1&to=draft');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      entryId: id,
      from: 1,
      to: 2,
      summary: answer.summary,
      highlights: answer.highlights,
      source: 'model',
      changedFields: 2,
      hiddenChanges: 0,
    });
    expect(ai.requests[0]?.prompt).toContain('"Headline"');
  });

  it('keeps fields the caller may not read from the model', async () => {
    const { app, ai, id } = await setup();
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Reviewer',
        scopes: ['preview:read'],
        contentGrants: [
          { contentTypeApiId: 'article', actions: ['read'], deniedFields: ['notes'] },
        ],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cpa', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    const res = await summarize(app, id, 'from=1&to=2', { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changedFields: 1, hiddenChanges: 1 });
    expect(ai.requests[0]?.prompt).not.toContain('CONFIDENTIAL');
    expect(ai.requests[0]?.prompt).not.toContain('Notes');
  });

  it('is built by rule in mock mode, refuses bad references, and is a 409 with field-assist off', async () => {
    const { app, id } = await setup('mock');
    const res = await summarize(app, id, 'from=1&to=draft');
    expect(await res.json()).toMatchObject({
      source: 'heuristic',
      summary: 'Changed 2 fields: Headline, Notes.',
    });
    expect((await summarize(app, id, 'from=latest&to=draft')).status).toBe(422);
    expect((await summarize(app, id, 'from=1&to=9')).status).toBe(404);
    const set = await app.request('/spaces/s1/ai-settings', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({
        expectedVersion: 0,
        capabilities: { 'field-assist': { enabled: false } },
      }),
    });
    expect(set.status).toBe(200);
    const off = await summarize(app, id, 'from=1&to=draft');
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ error: { code: 'ai_capability_disabled' } });
  });
});
