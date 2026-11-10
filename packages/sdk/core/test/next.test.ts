import { describe, expect, it, vi } from 'vitest';
import {
  createDraftClient,
  createDraftRoute,
  createExitDraftRoute,
  type DraftModeHandle,
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
    expect(dm.handle.enable).toHaveBeenCalledOnce();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://site.test/blog/hello');
    expectNoStore(res);
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

describe('createDraftClient', () => {
  it('answers a Preview client with the preview key while draft mode is on, else Delivery; each made once', async () => {
    const dm = fakeDraftMode();
    const urls: string[] = [];
    const auth: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      auth.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(JSON.stringify(entry));
    }) as unknown as typeof fetch;
    const getClient = createDraftClient({
      draftMode: dm.draftMode,
      delivery: {
        baseUrl: 'https://cdn.test',
        space: 's1',
        environment: 'main',
        token: 'cda',
        fetch: fetchImpl,
      },
      preview: { baseUrl: 'https://api.test', token: 'cpa' },
    });
    const delivery = await getClient();
    await delivery.getEntry('e1');
    expect(await getClient()).toBe(delivery);
    dm.handle.isEnabled = true;
    const draft = await getClient();
    expect(draft).not.toBe(delivery);
    expect(await getClient()).toBe(draft);
    await draft.getEntry('e1');
    expect(urls).toEqual([
      'https://cdn.test/delivery/s1/main/entries/e1',
      'https://api.test/preview/s1/main/entries/e1',
    ]);
    expect(auth).toEqual(['Bearer cda', 'Bearer cpa']);
    expect(draft.editable(entry, 'title')).not.toEqual({});
    expect(delivery.editable(entry, 'title')).toEqual({});
  });
});
