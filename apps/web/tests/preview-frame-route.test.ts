import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

// The Site frame: the page the entry editor frames, which frames the customer's page. Its loader
// mints a preview link as the signed-in person over the api binding; its document may frame that
// link's origin and nothing else, and only this origin may frame it. An entry the person can't
// read gets no link and no origin.

const me = { kind: 'user', id: 'usr_ann', email: 'ann@example.com', name: 'Ann', role: 'member' };
vi.mock('~/lib/auth.server', () => ({ requireUser: async () => me }));
const signed: string[] = [];
vi.mock('~/lib/principal.server', () => ({
  setPrincipalHeader: async (headers: Headers, _p: unknown, path: string) => {
    signed.push(path);
    headers.set('x-cw-principal', `signed:${path}`);
  },
}));
let answer: () => Response = () => new Response(null, { status: 500 });
const fetch = vi.fn(async (_url: string, _init: RequestInit) => answer());
vi.mock('~/lib/env.server', () => ({ api: () => ({ fetch }) }));

const route = await import('~/routes/preview-frame');
const {
  contentSecurityPolicy,
  EMBED_HEADER,
  FRAME_HEADER,
  parseEmbed,
  parseFrames,
  withSecurityHeaders,
} = await import('~/lib/csp');

const PATH = '/preview-frame/s1/main/e1';
const args = (path = PATH, headers: Record<string, string> = { 'sec-fetch-dest': 'iframe' }) =>
  ({
    request: new Request(`https://acme.contentworker.app${path}`, { headers }),
    params: { spaceId: 's1', environmentId: 'main', entryId: 'e1' },
    context: {},
  }) as never;

type Answered = {
  data: { ok: boolean; origin?: string; frontendUrl?: string; reason?: string };
  init: { status: number; headers: Headers };
};
const load = async (a = args()) => (await route.loader(a)) as unknown as Answered;

/** The document policy entry.server.tsx would send for the loader's headers. */
function policy(headers: Headers) {
  const csp = contentSecurityPolicy(
    'n0nce',
    parseEmbed(headers.get(EMBED_HEADER)),
    parseFrames(headers.get(FRAME_HEADER)),
  );
  const doc = withSecurityHeaders(
    new Response('', {
      headers: {
        'content-security-policy': csp,
        'x-frame-options': headers.get('x-frame-options') ?? '',
      },
    }),
    new URL('https://acme.contentworker.app/'),
  );
  return {
    csp,
    directives: Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d])),
    doc,
  };
}

beforeEach(() => {
  fetch.mockClear();
  signed.length = 0;
});

describe('the Site frame route', () => {
  it('mints a short preview link as the person, and frames exactly its origin', async () => {
    answer = () =>
      Response.json(
        {
          url: 'https://acme.contentworker.app/preview/s1/main/entries/e1?preview_token=pw_x',
          frontendUrl: 'https://site.example/blog/hello?entry=e1#token=pw_x',
          token: 'pw_x',
          expiresAt: '2026-11-07T01:00:00.000Z',
        },
        { status: 201 },
      );
    const res = await load(args(`${PATH}?locale=de`));
    expect(res.init.status).toBe(200);
    expect(res.data).toEqual({
      ok: true,
      origin: 'https://site.example',
      frontendUrl: 'https://site.example/blog/hello?entry=e1#token=pw_x',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api/spaces/s1/environments/main/entries/e1/preview-link');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      previewBaseUrl: 'https://acme.contentworker.app',
      ttlHours: 1,
      locale: 'de',
    });
    expect(signed).toEqual(['POST /spaces/s1/environments/main/entries/e1/preview-link']);

    const { directives, doc } = policy(res.init.headers);
    expect(directives['frame-src']).toBe("frame-src 'self' https://site.example");
    expect(directives['frame-ancestors']).toBe("frame-ancestors 'self'");
    expect(doc.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.init.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses an entry the person can’t read: no link, no origin to frame', async () => {
    answer = () => Response.json({ error: 'Not found' }, { status: 404 });
    const res = await load();
    expect(res.init.status).toBe(404);
    expect(res.data).toEqual({ ok: false, reason: 'not-found' });
    expect(res.init.headers.has(FRAME_HEADER)).toBe(false);
    const { directives } = policy(res.init.headers);
    expect(directives['frame-src']).toBe("frame-src 'self'");
    expect(directives['frame-ancestors']).toBe("frame-ancestors 'self'");

    answer = () => Response.json({ error: 'Forbidden' }, { status: 403 });
    expect((await load()).data).toEqual({ ok: false, reason: 'refused' });
  });

  it('frames nothing when the link has no frontend URL, or one the policy can’t carry', async () => {
    answer = () => Response.json({ url: 'u', token: 't', expiresAt: 'x' }, { status: 201 });
    expect((await load()).data).toEqual({ ok: false, reason: 'incomplete' });
    answer = () =>
      Response.json(
        { url: 'u', frontendUrl: 'http://evil.example/', token: 't', expiresAt: 'x' },
        { status: 201 },
      );
    const res = await load();
    expect(res.data).toEqual({ ok: false, reason: 'incomplete' });
    expect(res.init.headers.has(FRAME_HEADER)).toBe(false);
  });

  it('opens only as a frame, and never for ids that would name another path', async () => {
    await expect(route.loader(args(PATH, { 'sec-fetch-dest': 'document' }))).rejects.toMatchObject({
      init: { status: 404 },
    });
    const odd = await route.loader({
      ...(args() as object),
      params: { spaceId: 's1', environmentId: 'main', entryId: '..%2Fapi-keys' },
    } as never);
    expect((odd as unknown as Answered).init.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
