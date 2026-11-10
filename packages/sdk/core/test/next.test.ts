import { describe, expect, it, vi } from 'vitest';
import {
  createDraftClient,
  createDraftRoute,
  createExitDraftRoute,
  DRAFT_COOKIE,
  type DraftModeHandle,
  readDraftCookie,
  safeRedirectPath,
} from '../src/next.js';

const TOKEN = 'pw_secret-token-value';

/** Next.js's `draftMode()`, async as from Next.js 15 (or sync, as in 14). */
function fakeDraftMode(sync = false) {
  const handle = {
    isEnabled: false,
    enable: vi.fn(() => {
      handle.isEnabled = true;
    }),
    disable: vi.fn(() => {
      handle.isEnabled = false;
    }),
  } satisfies DraftModeHandle;
  return { handle, draftMode: sync ? () => handle : async () => handle };
}

function preview(answer: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init);
    return answer();
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls, inits };
}

const entry = { id: 'e1', contentType: 'post', fields: { slug: 'hello' }, publishedAt: '' };
const ok = () => new Response(JSON.stringify(entry), { status: 200 });

const link = (qs: string) => new Request(`https://site.test/api/draft?${qs}`);

function expectNoStore(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('createDraftRoute', () => {
  const opts = { baseUrl: 'https://api.test/', space: 's1', environment: 'main' };

  it('checks the token on the Preview API without a key, turns draft mode on and redirects to the page', async () => {
    const dm = fakeDraftMode();
    const p = preview(ok);
    const route = createDraftRoute({
      ...opts,
      draftMode: dm.draftMode,
      fetch: p.fetch,
      resolvePath: (e) => `/blog/${e.fields.slug}`,
    });
    const res = await route(link(`entry=e1&token=${TOKEN}&locale=de-DE`));
    expect(p.urls).toEqual([
      `https://api.test/preview/s1/main/entries/e1?preview_token=${TOKEN}&locale=de-DE`,
    ]);
    expect(new Headers(p.inits[0]?.headers).get('authorization')).toBeNull();
    // A read carrying the token is never cached.
    expect(p.inits[0]?.cache).toBe('no-store');
    expect(dm.handle.enable).toHaveBeenCalledOnce();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://site.test/blog/hello');
    expectNoStore(res);
    // The entry and its token go in an HttpOnly cookie, never in the URL the page gets.
    expect(res.headers.get('set-cookie')).toBe(
      `${DRAFT_COOKIE}=e1~${TOKEN}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(res.headers.get('location')).not.toContain(TOKEN);
    expect(await res.text()).toBe('');
  });

  it('keeps the cookie no longer than the token has left, an hour at most', async () => {
    const at = (ms: number) => () =>
      new Response(JSON.stringify(entry), {
        headers: { 'x-cw-preview-expires': new Date(Date.now() + ms).toISOString() },
      });
    const life = async (ms: number) => {
      const res = await createDraftRoute({
        ...opts,
        draftMode: fakeDraftMode().draftMode,
        fetch: preview(at(ms)).fetch,
      })(link(`entry=e1&token=${TOKEN}`));
      return { res, cookie: res.headers.get('set-cookie') };
    };
    expect((await life(10 * 60_000)).cookie).toMatch(/Max-Age=(599|600);/);
    expect((await life(72 * 3600_000)).cookie).toMatch(/Max-Age=3600;/);
    // A token that has run out by now turns nothing on.
    const spent = await life(-1000);
    expect(spent.res.status).toBe(401);
    expect(spent.cookie).toBeNull();
  });

  it('works with a synchronous draftMode (Next.js 14)', async () => {
    const dm = fakeDraftMode(true);
    const route = createDraftRoute({ ...opts, draftMode: dm.draftMode, fetch: preview(ok).fetch });
    const res = await route(link(`entry=e1&token=${TOKEN}&path=/about`));
    expect(dm.handle.isEnabled).toBe(true);
    expect(res.headers.get('location')).toBe('https://site.test/about');
  });

  it.each([
    'https://evil.test/',
    '//evil.test/',
    '/\\evil.test/',
    'javascript:alert(1)',
    '/%0d%0aSet-Cookie:x',
    'about',
    '',
  ])('sends a link whose path would leave the site (%s) to /', async (path) => {
    const dm = fakeDraftMode();
    const route = createDraftRoute({ ...opts, draftMode: dm.draftMode, fetch: preview(ok).fetch });
    const res = await route(link(`entry=e1&token=${TOKEN}&path=${encodeURIComponent(path)}`));
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin).toBe('https://site.test');
    if (path !== '/%0d%0aSet-Cookie:x') expect(location.pathname).toBe('/');
  });

  it('holds resolvePath to the same rule', async () => {
    const route = createDraftRoute({
      ...opts,
      draftMode: fakeDraftMode().draftMode,
      fetch: preview(ok).fetch,
      resolvePath: () => '//evil.test/x',
    });
    const res = await route(link(`entry=e1&token=${TOKEN}`));
    expect(res.headers.get('location')).toBe('https://site.test/');
  });

  it('works out where to go before turning draft mode on; a resolvePath that throws goes to /', async () => {
    const order: string[] = [];
    const dm = fakeDraftMode();
    dm.handle.enable.mockImplementation(() => {
      order.push('enable');
    });
    const route = createDraftRoute({
      ...opts,
      draftMode: dm.draftMode,
      fetch: preview(ok).fetch,
      resolvePath: () => {
        order.push('resolve');
        throw new Error('no slug');
      },
    });
    const res = await route(link(`entry=e1&token=${TOKEN}&path=/about`));
    expect(order).toEqual(['resolve', 'enable']);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://site.test/');
  });

  it.each([401, 403, 404])(
    'answers 401 for a token the Preview API refuses (%i), leaving draft mode off',
    async (status) => {
      const dm = fakeDraftMode();
      const route = createDraftRoute({
        ...opts,
        draftMode: dm.draftMode,
        fetch: preview(() => new Response('{"error":"nope"}', { status })).fetch,
      });
      const res = await route(link(`entry=e1&token=${TOKEN}`));
      expect(res.status).toBe(401);
      expect(dm.handle.enable).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.text()).not.toContain(TOKEN);
      expectNoStore(res);
    },
  );

  it.each(['token=x', 'entry=e1', ''])(
    'answers 400 for a link missing its entry or token (%s)',
    async (qs) => {
      const dm = fakeDraftMode();
      const p = preview(ok);
      const res = await createDraftRoute({ ...opts, draftMode: dm.draftMode, fetch: p.fetch })(
        link(qs),
      );
      expect(res.status).toBe(400);
      expect(p.urls).toHaveLength(0);
      expect(dm.handle.enable).not.toHaveBeenCalled();
      expectNoStore(res);
    },
  );

  it.each([
    ['a 500', () => new Response('oops', { status: 500 })],
    ['a network failure', () => Promise.reject(new TypeError(`fetch failed ${TOKEN}`))],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
  ])(
    'answers 502 for %s, leaving draft mode off and never echoing the token',
    async (_n, answer) => {
      const dm = fakeDraftMode();
      const res = await createDraftRoute({
        ...opts,
        draftMode: dm.draftMode,
        fetch: preview(answer as () => Response).fetch,
      })(link(`entry=e1&token=${TOKEN}`));
      expect(res.status).toBe(502);
      expect(dm.handle.enable).not.toHaveBeenCalled();
      expect(await res.text()).not.toContain(TOKEN);
      expectNoStore(res);
    },
  );
});

describe('createExitDraftRoute', () => {
  it('turns draft mode off and redirects to a safe path', async () => {
    const dm = fakeDraftMode();
    dm.handle.isEnabled = true;
    const route = createExitDraftRoute({ draftMode: dm.draftMode, path: '/blog' });
    const res = await route(new Request('https://site.test/api/draft/exit'));
    expect(dm.handle.disable).toHaveBeenCalledOnce();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://site.test/blog');
    expectNoStore(res);
    // The draft cookie goes with draft mode.
    expect(res.headers.get('set-cookie')).toBe(
      `${DRAFT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    const asked = await route(new Request('https://site.test/api/draft/exit?path=//evil.test'));
    expect(asked.headers.get('location')).toBe('https://site.test/blog');
    const back = await route(new Request('https://site.test/api/draft/exit?path=/post/1'));
    expect(back.headers.get('location')).toBe('https://site.test/post/1');
  });
});

describe('safeRedirectPath', () => {
  it.each([
    ['/', '/'],
    ['/blog/hello?x=1#y', '/blog/hello?x=1#y'],
    ['//evil.test', undefined],
    ['/\\evil.test', undefined],
    ['https://evil.test', undefined],
    ['/a\nb', undefined],
    ['/a\tb', undefined],
    [42, undefined],
    [undefined, undefined],
  ])('%s → %s', (input, want) => {
    expect(safeRedirectPath(input)).toBe(want);
  });
});

describe('readDraftCookie', () => {
  it.each([
    [`e1~${TOKEN}`, { entryId: 'e1', token: TOKEN }],
    ['e%7E1~a~b', { entryId: 'e~1', token: 'a~b' }],
    ['', null],
    [undefined, null],
    ['~tok', null],
    ['e1~', null],
    ['e1', null],
    ['e1~%0a', null],
    ['e1~%zz', null],
  ])('%s', (value, want) => {
    expect(readDraftCookie(value)).toEqual(want);
  });
});

describe('createDraftClient', () => {
  const published = (id: string, title: string) => ({
    id,
    contentType: 'post',
    fields: { title },
    publishedAt: '2026-01-01T00:00:00.000Z',
  });

  function site(o: { cookie?: string; draft?: () => Response } = {}) {
    const dm = fakeDraftMode();
    const urls: string[] = [];
    const auth: (string | null)[] = [];
    const caches: (RequestCache | undefined)[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      auth.push(new Headers(init?.headers).get('authorization'));
      if (url.includes('/preview/')) caches.push(init?.cache);
      if (url.includes('/preview/')) {
        return (
          o.draft?.() ??
          new Response(JSON.stringify({ ...published('e1', 'Draft title'), status: 'changed' }))
        );
      }
      if (url.includes('/entries/e1')) return new Response(JSON.stringify(published('e1', 'Live')));
      if (url.includes('/entries/e2')) {
        return new Response(JSON.stringify(published('e2', 'Other')));
      }
      if (url.includes('/singletons/home')) {
        return new Response('{"error":{"code":"not_found"}}', { status: 404 });
      }
      return new Response(
        JSON.stringify({ items: [published('e1', 'Live'), published('e2', 'Other')], total: 2 }),
      );
    }) as unknown as typeof fetch;
    const jar = new Map<string, string>(o.cookie === undefined ? [] : [[DRAFT_COOKIE, o.cookie]]);
    const getClient = createDraftClient({
      draftMode: dm.draftMode,
      cookies: async () => ({
        get: (name: string) => {
          const value = jar.get(name);
          return value === undefined ? undefined : { value };
        },
      }),
      delivery: {
        baseUrl: 'https://cdn.test',
        space: 's1',
        environment: 'main',
        token: 'cda',
        fetch: fetchImpl,
      },
      preview: { baseUrl: 'https://api.test' },
    });
    return { dm, urls, auth, caches, getClient };
  }

  it('is the Delivery client outside draft mode, made once', async () => {
    const s = site({ cookie: `e1~${TOKEN}` });
    const client = await s.getClient();
    expect(client.draft).toBeNull();
    expect((await client.getEntry('e1')).fields).toEqual({ title: 'Live' });
    expect(await client.getDraftEntry()).toBeNull();
    expect(client.editable({ id: 'e1', contentType: 'post' }, 'title')).toEqual({});
    expect(await s.getClient()).toBe(client);
    expect(s.urls).toEqual(['https://cdn.test/delivery/s1/main/entries/e1']);
  });

  it('in draft mode reads only the cookie’s entry with its token, every other one published', async () => {
    const s = site({ cookie: `e1~${TOKEN}` });
    s.dm.handle.isEnabled = true;
    const client = await s.getClient();
    expect(client.draft).toEqual({ entryId: 'e1' });
    expect((await client.getEntry('e1', { locale: 'en-US' })).fields).toEqual({
      title: 'Draft title',
    });
    // A second entry reads published, from Delivery, with the Delivery key.
    expect((await client.getEntry('e2')).fields).toEqual({ title: 'Other' });
    // In a list the draft takes its own place; the rest stay as delivered.
    const { items } = await client.listEntries({ contentType: 'post', locale: 'en-US' });
    expect(items.map((e) => e.fields.title)).toEqual(['Draft title', 'Other']);
    const viaQuery = await client.query().contentType('post').locale('en-US').fetch();
    expect(viaQuery.items[0]?.fields.title).toBe('Draft title');
    // One preview read per locale, without a key; nothing read with a Preview key.
    expect(s.urls.filter((u) => u.includes('/preview/'))).toEqual([
      `https://api.test/preview/s1/main/entries/e1?preview_token=${TOKEN}&locale=en-US`,
    ]);
    expect(s.caches).toEqual(['no-store']);
    s.urls.forEach((u, i) => {
      expect(s.auth[i]).toBe(u.includes('/preview/') ? null : 'Bearer cda');
    });
    // Only the draft entry is marked for the editor.
    expect(client.editable({ id: 'e1', contentType: 'post' }, 'title')).not.toEqual({});
    expect(client.editable({ id: 'e2', contentType: 'post' }, 'title')).toEqual({});
  });

  it('answers a never-published singleton with the draft when it is that type’s', async () => {
    const s = site({
      cookie: `h1~${TOKEN}`,
      draft: () => new Response(JSON.stringify({ id: 'h1', contentType: 'home', fields: {} })),
    });
    s.dm.handle.isEnabled = true;
    const client = await s.getClient();
    expect((await client.getSingleton('home')).id).toBe('h1');
  });

  it('reads published again once the token stops working', async () => {
    const s = site({
      cookie: `e1~${TOKEN}`,
      draft: () => new Response('{"error":"expired"}', { status: 401 }),
    });
    s.dm.handle.isEnabled = true;
    const client = await s.getClient();
    expect((await client.getEntry('e1')).fields).toEqual({ title: 'Live' });
    expect(await client.getDraftEntry()).toBeNull();
  });

  it('reads published in draft mode without a cookie, or with one it can’t read', async () => {
    for (const cookie of [undefined, 'garbage']) {
      const s = site(cookie === undefined ? {} : { cookie });
      s.dm.handle.isEnabled = true;
      const client = await s.getClient();
      expect(client.draft).toBeNull();
      expect((await client.getEntry('e1')).fields).toEqual({ title: 'Live' });
      expect(s.urls.some((u) => u.includes('/preview/'))).toBe(false);
    }
  });

  it('never puts the token in a published read, an error or a log', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const s = site({ cookie: `e1~${TOKEN}`, draft: () => new Response('oops', { status: 500 }) });
    s.dm.handle.isEnabled = true;
    const client = await s.getClient();
    await client.getEntry('e1');
    await client.listEntries();
    for (const u of s.urls.filter((x) => !x.includes('/preview/'))) expect(u).not.toContain(TOKEN);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
      spy.mockRestore();
    }
  });
});
