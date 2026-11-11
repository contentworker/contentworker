import type { ApiConfig } from '@contentworker/platform/config';
import type { StubAIProvider } from '@contentworker/test-kit';
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

const symbolField = (apiId: string, position: number) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

describe('granular RBAC over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  let model: StubAIProvider;
  let editor: Record<string, string>;
  let postId: string;
  let pageId: string;

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    model = ai as StubAIProvider;
    app = createApp(ctx, config, rag, blob, ai);

    // Model two types; publish both.
    for (const apiId of ['post', 'page']) {
      await app.request(`${M}/content-types`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          apiId,
          name: apiId,
          displayField: 'title',
          fields: [symbolField('title', 0), symbolField('internalNotes', 1)],
        }),
      });
      await app.request(`${M}/content-types/${apiId}/published`, {
        method: 'POST',
        headers: admin,
      });
    }

    // Author + publish one entry per type (with a sensitive field set).
    const mkEntry = async (contentTypeApiId: string) => {
      const res = await app.request(`${M}/entries`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          contentTypeApiId,
          fields: {
            title: { 'en-US': `A ${contentTypeApiId}` },
            internalNotes: { 'en-US': 'secret' },
          },
        }),
      });
      const { entry } = (await res.json()) as { entry: { id: string } };
      await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: admin });
      return entry.id;
    };
    postId = await mkEntry('post');
    pageId = await mkEntry('page');

    // A custom role: full coarse scopes, but content-wise only `post`,
    // no publish action, internalNotes hidden.
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Post editor',
        scopes: ['content:write', 'content:publish', 'preview:read', 'delivery:read'],
        contentGrants: [
          {
            contentTypeApiId: 'post',
            actions: ['read', 'write'],
            deniedFields: ['internalNotes'],
          },
        ],
      }),
    });
    expect(roleRes.status).toBe(201);
    const role = (await roleRes.json()) as { id: string };

    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    editor = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  });

  it('allows granted writes and rejects ungranted types and fields', async () => {
    const ok = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ contentTypeApiId: 'post', fields: { title: { 'en-US': 'Mine' } } }),
    });
    expect(ok.status).toBe(201);

    const wrongType = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ contentTypeApiId: 'page', fields: { title: { 'en-US': 'No' } } }),
    });
    expect(wrongType.status).toBe(403);

    const deniedField = await app.request(`${M}/entries/${postId}`, {
      method: 'PUT',
      headers: editor,
      body: JSON.stringify({ fields: { internalNotes: { 'en-US': 'sneaky' } } }),
    });
    expect(deniedField.status).toBe(403);
  });

  it('keeps the fields a writer may not write when it saves, and answers without them', async () => {
    const put = (fields: unknown) =>
      app.request(`${M}/entries/${postId}`, {
        method: 'PUT',
        headers: editor,
        body: JSON.stringify({ fields }),
      });
    const edit = { title: { 'en-US': 'B' } };

    const checked = await app.request(`${M}/entries/validate`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ entryId: postId, fields: edit }),
    });
    expect(checked.status).toBe(200);
    expect(((await checked.json()) as { fields: object }).fields).not.toHaveProperty(
      'internalNotes',
    );

    const saved = await put(edit);
    expect(saved.status, await saved.clone().text()).toBe(200);
    // The writer never sees the field it may not read, even though the save kept it.
    expect(((await saved.json()) as { fields: object }).fields).not.toHaveProperty('internalNotes');
    const asAdmin = (await (
      await app.request(`${M}/entries/${postId}`, { headers: admin })
    ).json()) as { entry: { currentVersion: number }; fields: Record<string, unknown> };
    expect(asAdmin.entry.currentVersion).toBe(2);
    expect(asAdmin.fields).toEqual({
      title: { 'en-US': 'B' },
      internalNotes: { 'en-US': 'secret' },
    });

    // A second save from the writer's own (masked) read keeps it too.
    const reread = (await (
      await app.request(`${M}/entries/${postId}`, { headers: editor })
    ).json()) as { fields: Record<string, unknown> };
    expect((await put({ ...reread.fields, title: { 'en-US': 'C' } })).status).toBe(200);
    const again = (await (
      await app.request(`${M}/entries/${postId}`, { headers: admin })
    ).json()) as { fields: Record<string, unknown> };
    expect(again.fields.internalNotes).toEqual({ 'en-US': 'secret' });
  });

  describe('AI runs over an entry', () => {
    const post = (path: string, headers: Record<string, string>, body: unknown) =>
      app.request(`${M}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const prompts = () => model.requests.map((r) => `${r.system}\n${r.prompt}`).join('\n');
    const stored = async (id: string) =>
      (
        (await (await app.request(`${M}/entries/${id}`, { headers: admin })).json()) as {
          fields: Record<string, unknown>;
        }
      ).fields;
    const retitle = async (promptTemplate: string, targetField = 'title') => {
      const res = await post('/ai-actions', admin, {
        name: 'Retitle',
        promptTemplate,
        targetField,
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };

    it('refuses every run on a type the role can’t read, as GET …/entries/:id does', async () => {
      expect((await app.request(`${M}/entries/${pageId}`, { headers: editor })).status).toBe(403);
      const actionId = await retitle('{{field.title}}');
      const runs: [string, unknown][] = [
        [`/entries/${pageId}/translate`, { targetLocale: 'en-US' }],
        [`/entries/${pageId}/summarize`, {}],
        [`/entries/${pageId}/autofill`, { field: 'title' }],
        [`/entries/${pageId}/suggest-tags`, {}],
        [`/entries/${pageId}/apply-tags`, { newTags: ['x'] }],
        [`/ai-actions/${actionId}/run`, { entryId: pageId }],
      ];
      for (const [path, body] of runs) {
        const res = await post(path, editor, body);
        expect(res.status, path).toBe(403);
        expect(await res.text(), path).not.toContain('secret');
      }
      expect(model.requests).toHaveLength(0);
      // A missing entry is a 404, as the read answers.
      expect((await post('/entries/nope/summarize', editor, {})).status).toBe(404);
    });

    it('never shows a denied field to the model or in the answer, and applies around it', async () => {
      // No localized field, so nothing to translate: the answer comes straight from the entry.
      const translated = await post(`/entries/${postId}/translate`, editor, {
        targetLocale: 'en-US',
        apply: true,
      });
      expect(translated.status, await translated.clone().text()).toBe(200);
      const body = (await translated.json()) as { fields: object; applied: boolean };
      expect(body.applied).toBe(false);
      expect(body.fields).toEqual({ title: { 'en-US': 'A post' } });

      const summarized = await post(`/entries/${postId}/summarize`, editor, {});
      expect(summarized.status, await summarized.clone().text()).toBe(200);

      expect(
        (await post(`/entries/${postId}/autofill`, editor, { field: 'internalNotes' })).status,
      ).toBe(403);
      const filled = await post(`/entries/${postId}/autofill`, editor, {
        field: 'title',
        apply: true,
      });
      expect(filled.status, await filled.clone().text()).toBe(200);

      const actionId = await retitle('{{field.title}} / {{field.internalNotes}}');
      const ran = await post(`/ai-actions/${actionId}/run`, editor, {
        entryId: postId,
        apply: true,
      });
      expect(ran.status, await ran.clone().text()).toBe(200);
      const notesAction = await retitle('{{field.title}}', 'internalNotes');
      const overwrite = await post(`/ai-actions/${notesAction}/run`, editor, {
        entryId: postId,
        apply: true,
      });
      expect(overwrite.status).toBe(403);

      expect(model.requests.length).toBeGreaterThan(0);
      expect(prompts()).not.toContain('secret');
      expect((await stored(postId)).internalNotes).toEqual({ 'en-US': 'secret' });
    });

    it('still runs for an unrestricted caller, over every type and field', async () => {
      const res = await post(`/entries/${pageId}/translate`, admin, { targetLocale: 'en-US' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { fields: object }).fields).toEqual({
        title: { 'en-US': 'A page' },
        internalNotes: { 'en-US': 'secret' },
      });
      const actionId = await retitle('{{field.internalNotes}}');
      expect((await post(`/ai-actions/${actionId}/run`, admin, { entryId: pageId })).status).toBe(
        200,
      );
      expect(prompts()).toContain('secret');
    });
  });

  it('counts an issue in a field the writer may not read, never naming it', async () => {
    // Saved without internalNotes; someone else's rule then makes it required.
    const bare = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ contentTypeApiId: 'post', fields: { title: { 'en-US': 'Bare' } } }),
    });
    const { entry } = (await bare.json()) as { entry: { id: string } };
    const tightened = await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        apiId: 'post',
        name: 'post',
        displayField: 'title',
        fields: [symbolField('title', 0), { ...symbolField('internalNotes', 1), required: true }],
      }),
    });
    expect([200, 201], await tightened.clone().text()).toContain(tightened.status);
    await app.request(`${M}/content-types/post/published`, { method: 'POST', headers: admin });

    const fields = { title: { 'en-US': 'Edited' } };
    for (const [method, path, body] of [
      ['PUT', `/entries/${entry.id}`, { fields }],
      ['POST', '/entries/validate', { entryId: entry.id, fields }],
      ['POST', '/entries', { contentTypeApiId: 'post', fields }],
      ['POST', '/entries/validate', { contentTypeApiId: 'post', fields }],
    ] as const) {
      const res = await app.request(`${M}${path}`, {
        method,
        headers: editor,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      expect(res.status, `${method} ${path}: ${text}`).toBe(422);
      expect(JSON.parse(text).error.issues).toEqual([
        expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
      ]);
      expect(text).not.toMatch(/notes/i);
    }
    // The admin, who can read it, is told which field.
    const named = await app.request(`${M}/entries/${entry.id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ fields }),
    });
    expect(named.status).toBe(422);
    expect(await named.text()).toContain('internalNotes');
  });

  it('publishes for a role without naming a dangling link in a field it may not read', async () => {
    const ghost = '01890000-0000-7000-8000-00000000dead';
    expect(
      (
        await app.request(`${M}/content-types`, {
          method: 'POST',
          headers: admin,
          body: JSON.stringify({
            apiId: 'card',
            name: 'Card',
            displayField: 'title',
            fields: [
              symbolField('title', 0),
              { ...symbolField('related', 1), type: 'Link', linkType: 'Entry' },
            ],
          }),
        })
      ).status,
    ).toBe(201);
    await app.request(`${M}/content-types/card/published`, { method: 'POST', headers: admin });
    // Someone else linked an entry that isn't there; saves don't check links, publishing does.
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        contentTypeApiId: 'card',
        fields: {
          title: { 'en-US': 'Card' },
          related: { 'en-US': { id: ghost, linkType: 'Entry' } },
        },
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { entry } = (await created.json()) as { entry: { id: string } };
    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Card publisher',
        scopes: ['content:write', 'content:publish', 'preview:read'],
        contentGrants: [
          { contentTypeApiId: 'card', actions: ['read', 'publish'], deniedFields: ['related'] },
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
    const publisher = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const res = await app.request(`${M}/entries/${entry.id}/published`, {
      method: 'POST',
      headers: publisher,
    });
    const text = await res.text();
    expect(res.status, text).toBe(422);
    expect(JSON.parse(text).error.issues).toEqual([
      expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
    ]);
    expect(text).not.toContain('related');
    expect(text).not.toContain(ghost);
    // The admin, who can read it, is told the field and its target.
    const named = await app.request(`${M}/entries/${entry.id}/published`, {
      method: 'POST',
      headers: admin,
    });
    expect(named.status).toBe(422);
    expect(await named.text()).toContain(ghost);
  });

  it('saves SEO for a role without naming a field it may not read', async () => {
    const seoField = { ...symbolField('seo', 2), type: 'Seo' };
    const define = (notesRequired: boolean) =>
      app.request(`${M}/content-types`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          apiId: 'post',
          name: 'post',
          displayField: 'title',
          fields: [
            symbolField('title', 0),
            { ...symbolField('internalNotes', 1), required: notesRequired },
            seoField,
          ],
        }),
      });
    expect([200, 201]).toContain((await define(false)).status);
    await app.request(`${M}/content-types/post/published`, { method: 'POST', headers: admin });
    const bare = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ contentTypeApiId: 'post', fields: { title: { 'en-US': 'Bare' } } }),
    });
    const { entry } = (await bare.json()) as { entry: { id: string } };
    expect([200, 201]).toContain((await define(true)).status);
    await app.request(`${M}/content-types/post/published`, { method: 'POST', headers: admin });

    const res = await app.request(`${M}/entries/${entry.id}/seo`, {
      method: 'PATCH',
      headers: editor,
      body: JSON.stringify({ title: 'Better' }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(422);
    expect(JSON.parse(text).error.issues).toEqual([
      expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
    ]);
    expect(text).not.toMatch(/notes/i);
  });

  it('duplicates for a writer without the fields it may not read; the copy keeps them', async () => {
    const res = await app.request(`${M}/entries/${postId}/duplicate`, {
      method: 'POST',
      headers: editor,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const copy = (await res.json()) as {
      entry: { id: string };
      fields: Record<string, unknown>;
    };
    expect(copy.fields).toEqual({ title: { 'en-US': 'A post (copy)' } });

    const asAdmin = (await (
      await app.request(`${M}/entries/${copy.entry.id}`, { headers: admin })
    ).json()) as { fields: Record<string, unknown> };
    expect(asAdmin.fields.internalNotes).toEqual({ 'en-US': 'secret' });
  });

  it('refuses a duplicate without write on the type, and leaves no copy behind', async () => {
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Post reader',
        scopes: ['content:write', 'preview:read'],
        contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    const reader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const res = await app.request(`${M}/entries/${postId}/duplicate`, {
      method: 'POST',
      headers: reader,
    });
    expect(res.status).toBe(403);

    // A type the role has no grant for at all is refused the same way.
    const other = await app.request(`${M}/entries/${pageId}/duplicate`, {
      method: 'POST',
      headers: editor,
    });
    expect(other.status).toBe(403);

    const counts = (await (
      await app.request(`${M}/content-types/entry-counts`, { headers: admin })
    ).json()) as { items: { contentType: string; total: number }[] };
    expect(counts.items.find((c) => c.contentType === 'post')?.total).toBe(1);
    expect(counts.items.find((c) => c.contentType === 'page')?.total).toBe(1);
  });

  it('counts entries per content type, leaving out types the role cannot read', async () => {
    type Counts = { items: { contentType: string; total: number; published: number }[] };
    const all = await app.request(`${M}/content-types/entry-counts`, { headers: admin });
    expect(all.status).toBe(200);
    const everything = ((await all.json()) as Counts).items;
    expect(everything.map((c) => c.contentType).sort()).toEqual(['page', 'post']);
    expect(everything.find((c) => c.contentType === 'post')).toMatchObject({
      total: 1,
      published: 1,
    });

    const scoped = await app.request(`${M}/content-types/entry-counts`, { headers: editor });
    expect(((await scoped.json()) as Counts).items.map((c) => c.contentType)).toEqual(['post']);
  });

  it('denies publish despite the coarse content:publish scope', async () => {
    const res = await app.request(`${M}/entries/${postId}/published`, {
      method: 'POST',
      headers: editor,
    });
    expect(res.status).toBe(403);
  });

  it('masks denied fields on management, preview, and delivery reads', async () => {
    const mgmt = (await (
      await app.request(`${M}/entries/${postId}`, { headers: editor })
    ).json()) as { fields: Record<string, unknown> };
    expect(mgmt.fields.title).toBeDefined();
    expect(mgmt.fields.internalNotes).toBeUndefined();

    const preview = (await (
      await app.request('/preview/s1/main/entries', { headers: editor })
    ).json()) as { items: { contentType: string; fields: Record<string, unknown> }[] };
    // Only `post` entries are visible, and the denied field is masked.
    expect(preview.items.every((e) => e.contentType === 'post')).toBe(true);
    expect(preview.items.every((e) => e.fields.internalNotes === undefined)).toBe(true);

    const delivery = (await (
      await app.request('/delivery/s1/main/entries', { headers: editor })
    ).json()) as { items: { contentType: string }[] };
    expect(delivery.items.map((e) => e.contentType)).toEqual(['post']);

    const deniedGet = await app.request(`/delivery/s1/main/entries/${pageId}`, {
      headers: editor,
    });
    expect(deniedGet.status).toBe(403);
  });

  it('pages the preview list over readable types only: no cursor names a hidden entry', async () => {
    // The `page` entry would end the first page in title order ("A page" < "A post").
    const first = (await (
      await app.request('/preview/s1/main/entries?order=fields.title&limit=1', { headers: editor })
    ).json()) as { items: { id: string }[]; nextCursor?: string };
    expect(first.items.map((e) => e.id)).toEqual([postId]);
    expect(first.nextCursor).toBeUndefined();
  });

  it('refuses queries that would reveal a hidden field, on every read surface', async () => {
    for (const url of [
      // A filter answers "does internalNotes match?" even though the value is masked.
      '/delivery/s1/main/entries?content_type=post&fields.internalNotes[match]=secret',
      '/preview/s1/main/entries?content_type=post&fields.internalNotes=secret',
      // Ordering by it leaks its order; free-text search runs over every field.
      '/delivery/s1/main/entries?content_type=post&order=fields.internalNotes',
      '/delivery/s1/main/entries?content_type=post&query=secret',
      // Naming no type is judged against every type's rules.
      '/delivery/s1/main/entries?fields.internalNotes[exists]=true',
    ]) {
      expect((await app.request(url, { headers: editor })).status, url).toBe(403);
    }
    // Queries over readable fields still work.
    const ok = await app.request(
      '/delivery/s1/main/entries?content_type=post&fields.title[match]=post&order=-sys.publishedAt',
      { headers: editor },
    );
    expect(ok.status).toBe(200);
    // The admin token has no field rules.
    expect(
      (
        await app.request('/delivery/s1/main/entries?content_type=post&query=secret', {
          headers: admin,
        })
      ).status,
    ).toBe(200);
  });

  it('kind-based keys and the admin token are unaffected', async () => {
    const full = (await (
      await app.request(`${M}/entries/${postId}`, { headers: admin })
    ).json()) as { fields: Record<string, unknown> };
    expect(full.fields.internalNotes).toBeDefined();
  });

  it('enforces granular RBAC on version-history reads', async () => {
    // Granted type: version snapshot is readable but the denied field is masked.
    const versions = (await (
      await app.request(`${M}/entries/${postId}/versions`, { headers: editor })
    ).json()) as { items: { fields: Record<string, unknown> }[] };
    expect(versions.items.length).toBeGreaterThan(0);
    expect(versions.items.every((v) => v.fields.title !== undefined)).toBe(true);
    expect(versions.items.every((v) => v.fields.internalNotes === undefined)).toBe(true);

    // Ungranted type: version history is forbidden, not leaked.
    const pageVersions = await app.request(`${M}/entries/${pageId}/versions`, { headers: editor });
    expect(pageVersions.status).toBe(403);

    // A single version snapshot of an ungranted type is likewise forbidden.
    const pageVersion = await app.request(`${M}/entries/${pageId}/versions/1`, { headers: editor });
    expect(pageVersion.status).toBe(403);
  });

  it('applies write authorization when restoring a version', async () => {
    // Restoring an ungranted type is rejected.
    const restorePage = await app.request(`${M}/entries/${pageId}/versions/1/restore`, {
      method: 'POST',
      headers: editor,
    });
    expect(restorePage.status).toBe(403);

    // Restoring a granted entry whose snapshot includes a denied field is rejected
    // (it would otherwise resurrect internalNotes past the field rule).
    const restorePost = await app.request(`${M}/entries/${postId}/versions/1/restore`, {
      method: 'POST',
      headers: editor,
    });
    expect(restorePost.status).toBe(403);
  });

  it('masks embedded entries at include depth (fields, grants, and stubs)', async () => {
    // A story links to a post (granted, with a denied field) and a page
    // (ungranted): the embed must be masked / reverted to a stub respectively.
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        apiId: 'story',
        name: 'story',
        displayField: 'title',
        fields: [
          symbolField('title', 0),
          {
            apiId: 'refPost',
            name: 'refPost',
            type: 'Link',
            linkType: 'Entry',
            localized: false,
            required: false,
            position: 1,
          },
          {
            apiId: 'refPage',
            name: 'refPage',
            type: 'Link',
            linkType: 'Entry',
            localized: false,
            required: false,
            position: 2,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/story/published`, { method: 'POST', headers: admin });
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        contentTypeApiId: 'story',
        fields: {
          title: { 'en-US': 'A story' },
          refPost: { 'en-US': { id: postId, linkType: 'Entry' } },
          refPage: { 'en-US': { id: pageId, linkType: 'Entry' } },
        },
      }),
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: admin });

    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Story reader',
        scopes: ['delivery:read'],
        contentGrants: [
          { contentTypeApiId: 'story', actions: ['read'] },
          { contentTypeApiId: 'post', actions: ['read'], deniedFields: ['internalNotes'] },
          // no grant on 'page'
        ],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cda', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    type Embedded = { id: string; contentType?: string; fields?: Record<string, unknown> };
    const fetchStory = async (bearer: string, query: string) => {
      const res = await app.request(`/delivery/s1/main/entries/${entry.id}?${query}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { fields: Record<string, unknown> };
    };

    // Locale-flattened read: post embed masked, page embed reverted to stub.
    const flat = await fetchStory(token, 'include=1&locale=en-US');
    const refPost = flat.fields.refPost as Embedded;
    expect(refPost.fields?.title).toBe('A post');
    expect(refPost.fields?.internalNotes).toBeUndefined();
    expect(flat.fields.refPage).toEqual({ id: pageId, linkType: 'Entry' });

    // Unflattened read: embeds sit inside per-locale maps — still reached.
    const mapped = await fetchStory(token, 'include=1');
    const mappedPost = (mapped.fields.refPost as Record<string, Embedded>)['en-US'];
    expect(mappedPost?.fields?.internalNotes).toBeUndefined();
    expect((mapped.fields.refPage as Record<string, unknown>)['en-US']).toEqual({
      id: pageId,
      linkType: 'Entry',
    });

    // The full-access key still gets complete embeds (no over-masking).
    const full = await fetchStory('cda', 'include=1&locale=en-US');
    expect((full.fields.refPost as Embedded).fields?.internalNotes).toBe('secret');
    expect((full.fields.refPage as Embedded).fields?.title).toBe('A page');
  });
});
