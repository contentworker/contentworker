import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiFieldIssues,
  assetUsageOf,
  BOOKMARK_HEADER,
  type Connection,
  createManagementClient,
  currentBookmark,
  resetBookmark,
} from '~/cms/lib/management';

beforeEach(() => resetBookmark());

const conn: Connection = {
  space: 's1',
  environment: 'main',
  locale: 'en-US',
};

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = handler(url, init);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('admin ManagementClient', () => {
  it('lists content types from the same-origin management base, with no bearer token', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [{ apiId: 'article', name: 'Article' }] }));
    const client = createManagementClient(conn, fn);
    const types = await client.listContentTypes();
    expect(types[0]?.apiId).toBe('article');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/content-types');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(calls[0]!.init!.credentials).toBe('same-origin');
  });

  it('lists entries from the PREVIEW base (drafts), filtered by content type', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [] }));
    const client = createManagementClient(conn, fn);
    await client.listEntries('article');
    expect(calls[0]?.url).toBe('/preview/s1/main/entries?content_type=article');
  });

  it('sends localized fields through on create (the form owns localization)', async () => {
    const { fn, calls } = fakeFetch(() => ({ entry: { id: 'e1' }, fields: {} }));
    const client = createManagementClient(conn, fn);
    await client.createEntry('article', { title: { 'en-US': 'Hi', 'de-DE': 'Hallo' } });
    const body = JSON.parse((calls[0]?.init?.body as string) ?? '{}');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/entries');
    expect(body).toEqual({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hi', 'de-DE': 'Hallo' } },
    });
  });

  it('reads space config (locales) from the management base', async () => {
    const { fn, calls } = fakeFetch(() => ({
      spaceId: 's1',
      name: 'Space 1',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de-DE'],
    }));
    const client = createManagementClient(conn, fn);
    const cfg = await client.getSpaceConfig();
    expect(cfg.locales).toEqual(['en-US', 'de-DE']);
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/space-config');
  });

  it('publishes via the management entries action', async () => {
    const { fn, calls } = fakeFetch(() => ({ id: 'e1', status: 'published' }));
    const client = createManagementClient(conn, fn);
    await client.publishEntry('e1');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/entries/e1/published');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('uploadAsset creates → PUTs bytes to the presigned URL → publishes', async () => {
    const seq: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seq.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/assets')) {
        return new Response(
          JSON.stringify({
            asset: { id: 'asset_1', status: 'draft' },
            upload: { url: 'https://blob.test/put?sig', headers: { 'content-type': 'text/plain' } },
          }),
          { status: 201 },
        );
      }
      if (url === 'https://blob.test/put?sig') return new Response('', { status: 200 }); // presigned PUT
      return new Response(JSON.stringify({ id: 'asset_1', status: 'published' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createManagementClient(conn, fn);
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const published = await client.uploadAsset(file);
    expect(published.status).toBe('published');
    expect(seq).toEqual([
      'POST /spaces/s1/environments/main/assets',
      'PUT https://blob.test/put?sig',
      'POST /spaces/s1/environments/main/assets/asset_1/published',
    ]);
  });

  it('replaceAssetFile starts → PUTs the next version → commits what the start returned', async () => {
    const seq: string[] = [];
    const bodies: unknown[] = [];
    const commit = { version: 3, fileName: 'v3.txt', contentType: 'text/plain' };
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seq.push(`${init?.method ?? 'GET'} ${url}`);
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      if (url.endsWith('/assets/a1/file')) {
        return new Response(
          JSON.stringify({
            asset: { id: 'a1', version: 2 },
            upload: { url: 'https://blob.test/v3?sig', headers: { 'content-type': 'text/plain' } },
            commit,
          }),
          { status: 201 },
        );
      }
      if (url === 'https://blob.test/v3?sig') return new Response('', { status: 200 });
      return new Response(JSON.stringify({ id: 'a1', version: 3 }), { status: 200 });
    }) as unknown as typeof fetch;

    const next = await createManagementClient(conn, fn).replaceAssetFile(
      'a1',
      new File(['new'], 'v3.txt', { type: 'text/plain' }),
    );
    expect(next.version).toBe(3);
    expect(seq).toEqual([
      'POST /spaces/s1/environments/main/assets/a1/file',
      'PUT https://blob.test/v3?sig',
      'POST /spaces/s1/environments/main/assets/a1/file/commit',
    ]);
    expect(bodies).toEqual([{ fileName: 'v3.txt', contentType: 'text/plain' }, commit]);
  });

  it('does not commit a replacement whose bytes never arrived', async () => {
    const seq: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seq.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/file')) {
        return new Response(
          JSON.stringify({
            asset: { id: 'a1' },
            upload: { url: 'https://blob.test/v2', headers: {} },
            commit: { version: 2, fileName: 'x', contentType: 'x' },
          }),
          { status: 201 },
        );
      }
      return new Response('denied', { status: 403 });
    }) as unknown as typeof fetch;
    await expect(
      createManagementClient(conn, fn).replaceAssetFile('a1', new File(['x'], 'x')),
    ).rejects.toBeInstanceOf(ApiError);
    expect(seq.some((s) => s.endsWith('/commit'))).toBe(false);
  });

  it('reads the fields a 422 named, and nothing from other failures', () => {
    const body = {
      error: {
        code: 'validation',
        issues: [
          { field: 'rights.expiresAt', message: 'expiresAt must be after embargoUntil' },
          { field: 'rights.expiresAt', message: 'a second, ignored' },
          { field: 'rights.license', message: 'license is at most 500 characters' },
        ],
      },
    };
    expect(apiFieldIssues(new ApiError(422, 'PUT → 422', body))).toEqual({
      'rights.expiresAt': 'expiresAt must be after embargoUntil',
      'rights.license': 'license is at most 500 characters',
    });
    expect(apiFieldIssues(new ApiError(409, 'x', body))).toEqual({});
    expect(apiFieldIssues(new Error('x'))).toEqual({});
  });

  it('starts an asset bulk job and reads its report', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/report') ? { job: { id: 'j1' }, chunks: [] } : { id: 'j1', status: 'running' },
    );
    const client = createManagementClient(conn, fn);
    await client.startAssetBulkJob({ action: 'move', ids: ['a1'], folderId: null });
    await client.getBulkJobReport('j1');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/assets/bulk');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      action: 'move',
      ids: ['a1'],
      folderId: null,
    });
    expect(calls[1]?.url).toBe('/spaces/s1/environments/main/bulk/jobs/j1/report');
  });

  it('lists assets from the management base', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [{ id: 'a1' }], nextCursor: 'c2' }));
    const client = createManagementClient(conn, fn);
    const page = await client.listAssets();
    expect(page.items[0]?.id).toBe('a1');
    expect(page.nextCursor).toBe('c2');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/assets');
  });

  it('sends the library filters, sort and cursor as the query, leaving out empty ones', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [] }));
    const client = createManagementClient(conn, fn);
    await client.listAssets({
      kind: 'image',
      folder: 'root',
      status: 'archived',
      tag: '',
      sort: 'size',
      order: 'asc',
      limit: 50,
      cursor: 'abc',
    });
    const url = new URL(calls[0]?.url ?? '', 'http://x');
    expect(url.pathname).toBe('/spaces/s1/environments/main/assets');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'image',
      folder: 'root',
      status: 'archived',
      sort: 'size',
      order: 'asc',
      limit: '50',
      cursor: 'abc',
    });
  });

  it('moves, archives, restores and deletes assets, and manages folders', async () => {
    const { fn, calls } = fakeFetch((_url, init) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : { items: [], moved: 2 },
    );
    const client = createManagementClient(conn, fn);
    const base = '/spaces/s1/environments/main';
    expect(await client.moveAssets(['a1', 'a2'], 'f1')).toMatchObject({ moved: 2 });
    await client.archiveAsset('a1');
    await client.restoreAsset('a1');
    await client.deleteAsset('a1');
    await client.listAssetFolders();
    await client.createAssetFolder({ name: 'Brand', parentId: 'f0' });
    await client.updateAssetFolder('f1', { parentId: null });
    await client.deleteAssetFolder('f1');
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST ${base}/assets/move`,
      `POST ${base}/assets/a1/archive`,
      `POST ${base}/assets/a1/restore`,
      `DELETE ${base}/assets/a1`,
      `GET ${base}/asset-folders`,
      `POST ${base}/asset-folders`,
      `PATCH ${base}/asset-folders/f1`,
      `DELETE ${base}/asset-folders/f1`,
    ]);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      ids: ['a1', 'a2'],
      folderId: 'f1',
    });
    expect(JSON.parse(calls[6]?.init?.body as string)).toEqual({ parentId: null });
  });

  it('reads the entries that hold an asset from a refused delete', async () => {
    const usage = [
      {
        fromEntryId: 'e1',
        fromField: 'hero',
        toId: 'a1',
        toType: 'Asset',
        contentTypeApiId: 'page',
        entryTitle: 'Home page',
      },
    ];
    const { fn } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'asset_in_use', message: 'used', usage, total: 73 } }),
          { status: 409 },
        ),
    );
    const err = await createManagementClient(conn, fn)
      .deleteAsset('a1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('asset_in_use');
    // The titles and the full count ride in the body: nothing to fetch per link.
    expect(assetUsageOf(err)).toEqual({ usage, total: 73 });
    expect(assetUsageOf(new ApiError(409, 'conflict'))).toBeNull();
  });

  it('uploads into a folder', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/assets')
        ? { asset: { id: 'a1' }, upload: { url: 'https://blob.test/put', headers: {} } }
        : { id: 'a1', status: 'published' },
    );
    await createManagementClient(conn, fn).uploadAsset(new File(['x'], 'a.png'), {
      folderId: 'f1',
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({ folderId: 'f1' });
  });

  it('reads agent runs + usage from management, and searches via delivery', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('/agent-runs/usage')) return { runs: 2, inputTokens: 300, outputTokens: 50 };
      if (url.includes('/agent-runs'))
        return {
          items: [
            {
              id: 'r1',
              workflow: 'enrich',
              status: 'completed',
              inputTokens: 100,
              outputTokens: 20,
              decisions: [],
              entryId: 'e1',
              createdAt: 'now',
            },
          ],
        };
      return { hits: [{ entryId: 'e1', score: 0.9, snippet: 'hi' }] };
    });
    const client = createManagementClient(conn, fn);

    expect((await client.listAgentRuns())[0]?.workflow).toBe('enrich');
    expect((await client.agentUsage()).inputTokens).toBe(300);
    expect((await client.search('database'))[0]?.entryId).toBe('e1');

    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/agent-runs');
    expect(calls[1]?.url).toBe('/spaces/s1/environments/main/agent-runs/usage');
    expect(calls[2]?.url).toBe('/delivery/s1/main/search?q=database');
  });

  it('reads the published version via delivery (for diff), rendered for the locale', async () => {
    const { fn, calls } = fakeFetch(() => ({
      id: 'e1',
      contentType: 'article',
      fields: { title: 'Published' },
      publishedAt: 'then',
    }));
    const client = createManagementClient(conn, fn);
    const pub = await client.getPublished('e1');
    expect(pub.fields.title).toBe('Published');
    expect(calls[0]?.url).toBe('/delivery/s1/main/entries/e1?locale=en-US');
  });

  it('manages API keys at the space base (list + mint with one-time token)', async () => {
    const { fn, calls } = fakeFetch((_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return { items: [{ id: 'k1', kind: 'cda', scopes: ['delivery:read'], revoked: false }] };
      }
      return { id: 'k2', kind: 'cma', token: 'cwk_cma_secret' };
    });
    const client = createManagementClient(conn, fn);

    expect((await client.listApiKeys())[0]?.kind).toBe('cda');
    const minted = await client.createApiKey({ kind: 'cma', name: 'CI' });
    expect(minted.token).toBe('cwk_cma_secret');

    expect(calls[0]?.url).toBe('/spaces/s1/api-keys'); // space-scoped, no env
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '{}')).toEqual({
      kind: 'cma',
      name: 'CI',
    });
  });

  it('manages webhooks at the environment base', async () => {
    const { fn, calls } = fakeFetch(() => ({
      id: 'w1',
      url: 'https://x.test',
      topics: ['*'],
      active: true,
    }));
    const client = createManagementClient(conn, fn);
    await client.createWebhook({ url: 'https://x.test', secret: 's', topics: ['entry.published'] });
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/webhooks');
    expect(JSON.parse((calls[0]?.init?.body as string) ?? '{}').topics).toEqual([
      'entry.published',
    ]);
  });

  it('throws ApiError with status on non-2xx', async () => {
    const { fn } = fakeFetch(() => new Response('forbidden', { status: 403 }));
    const client = createManagementClient(conn, fn);
    await expect(client.listContentTypes()).rejects.toBeInstanceOf(ApiError);
    await expect(client.listContentTypes()).rejects.toMatchObject({ status: 403 });
  });
});

describe('plugin endpoints are space-scoped', () => {
  /**
   * A plugin is installed once for a space and runs in every environment in
   * it, so these routes carry no `/environments/:env`. Sending them there
   * 404s, and a 404 on the list reads as "no plugins installed" — a silent
   * failure that looks exactly like success.
   */
  const cases: [
    string,
    (c: ReturnType<typeof createManagementClient>) => Promise<unknown>,
    string,
  ][] = [
    ['list', (c) => c.listPlugins(), '/spaces/s1/plugins'],
    [
      'install',
      (c) =>
        c.installPlugin({
          manifest: {
            id: 'p',
            name: 'P',
            version: '1',
            capabilities: [],
            hooks: [],
            entrypoint: 'i.js',
          },
          bundle: 'x',
          approvedCapabilities: [],
        }),
      '/spaces/s1/plugins',
    ],
    [
      'install from url',
      (c) =>
        c.installPluginFromUrl({ packageUrl: 'https://x.test/p.json', approvedCapabilities: [] }),
      '/spaces/s1/plugins/from-url',
    ],
    [
      'enable',
      (c) => c.setPluginEnabled('com.example.seo', true),
      '/spaces/s1/plugins/com.example.seo/enabled',
    ],
    [
      'uninstall',
      (c) => c.uninstallPlugin('com.example.seo'),
      '/spaces/s1/plugins/com.example.seo',
    ],
  ];

  for (const [name, call, expected] of cases) {
    it(`${name} goes to the space, not the environment`, async () => {
      const { fn, calls } = fakeFetch(() => ({ items: [] }));
      await call(createManagementClient(conn, fn));
      expect(calls[0]?.url).toBe(expected);
    });
  }
});

describe('read-your-writes bookmark', () => {
  it('sends no bookmark until the api has answered with one', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [] }));
    await createManagementClient(conn, fn).listContentTypes();
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers[BOOKMARK_HEADER]).toBeUndefined();
  });

  it('keeps the latest x-cw-bookmark and sends it on every later request, from any client', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => {
      n += 1;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { [BOOKMARK_HEADER]: `bm-${n}` },
      });
    });
    await createManagementClient(conn, fn).listContentTypes();
    expect(currentBookmark()).toBe('bm-1');
    // A different client (another scope) still carries the browser's latest write position.
    await createManagementClient({ ...conn, space: 's2' }, fn).listContentTypes();
    expect((calls[1]!.init!.headers as Record<string, string>)[BOOKMARK_HEADER]).toBe('bm-1');
    expect(currentBookmark()).toBe('bm-2');
    await createManagementClient(conn, fn).listContentTypes();
    expect((calls[2]!.init!.headers as Record<string, string>)[BOOKMARK_HEADER]).toBe('bm-2');
  });

  it('keeps the bookmark a failed response carries, and the previous one when none comes back', async () => {
    const { fn } = fakeFetch((url) =>
      url.endsWith('/content-types')
        ? new Response('nope', { status: 500, headers: { [BOOKMARK_HEADER]: 'bm-err' } })
        : new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const client = createManagementClient(conn, fn);
    await expect(client.listContentTypes()).rejects.toBeInstanceOf(ApiError);
    expect(currentBookmark()).toBe('bm-err');
    await client.listAssets();
    expect(currentBookmark()).toBe('bm-err');
  });
});
