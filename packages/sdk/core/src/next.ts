/**
 * Draft mode for Next.js (App Router), scoped to one entry. A content type's preview URL points at
 * a route handler made by {@link createDraftRoute}: it checks the link's preview token against the
 * Preview API, keeps the entry id and the token in an HttpOnly cookie no longer than the token
 * lives (an hour at most), turns Next.js's draft mode on and redirects to the page. Pages read
 * through {@link createDraftClient}: in draft mode it reads that one entry as it is now, with the
 * link's token, and everything else from Delivery, as every visitor sees it. A preview link grants
 * its entry and nothing more, so the site needs no Preview key for draft mode.
 *
 * Nothing here imports Next.js: pass its `draftMode` and `cookies` from `next/headers`, so the same
 * code is tested without it and works on every Next.js version whose `draftMode` and `cookies` are
 * sync or async.
 */
import { CONTENT_REF_ATTRIBUTE, formatContentRef } from './content-ref.js';
import {
  type ClientOptions,
  createDeliveryClient,
  type DeliveredEntry,
  type DeliveryClient,
  DeliveryError,
  type EntryQuery,
  EntryQueryBuilder,
  type Fields,
} from './index.js';

/** What Next.js's `draftMode()` returns (a promise of it from Next.js 15). */
export interface DraftModeHandle {
  readonly isEnabled: boolean;
  enable(): void;
  disable(): void;
}

/** Next.js's `draftMode` from `next/headers`. */
export type DraftMode = () => DraftModeHandle | Promise<DraftModeHandle>;

/** The part of Next.js's request cookies (`cookies()` from `next/headers`) the client reads. */
export interface DraftCookieStore {
  get(name: string): { readonly value: string } | undefined;
}

/** Next.js's `cookies` from `next/headers`. */
export type DraftCookies = () => DraftCookieStore | Promise<DraftCookieStore>;

/** The cookie holding the entry draft mode shows and the token that reads it. HttpOnly. */
export const DRAFT_COOKIE = 'cw_draft';

/** Longest the draft cookie lives, in seconds, however long the link's token has left. */
export const DRAFT_COOKIE_MAX_AGE = 60 * 60;

/** The header the Preview API answers a token read with: when the token stops working. */
const EXPIRES_HEADER = 'x-cw-preview-expires';

export interface DraftRouteOptions {
  /** The api host the Preview API is on, e.g. `https://api.<your domain>`. */
  readonly baseUrl: string;
  readonly space: string;
  readonly environment: string;
  readonly draftMode: DraftMode;
  /**
   * The page that shows the entry, as a path on this site (`/blog/${entry.fields.slug}`). Without
   * it, or when it answers nothing, the link's `path` parameter, else `/`. Whatever it is, a path
   * that would leave this site is replaced by `/`.
   */
  readonly resolvePath?: (
    entry: DeliveredEntry,
  ) => string | undefined | Promise<string | undefined>;
  /** Override fetch (tests, a custom agent). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

// The link carries a preview token: nothing about the answer may be cached, and the page it
// redirects to must not learn the token from a Referer.
const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' },
  });

const redirect = (request: Request, path: string, cookie: string) =>
  new Response(null, {
    status: 307,
    headers: {
      ...HEADERS,
      location: new URL(path, request.url).toString(),
      'set-cookie': cookie,
    },
  });

/**
 * The draft cookie's `Set-Cookie`: never readable by the page's script (`HttpOnly`), sent only
 * over https (`Secure`; browsers treat `localhost` as secure), and kept when the admin frames the
 * site from another site (`SameSite=None`), but only in that top-level site's own jar
 * (`Partitioned`): a draft opened in the editor's frame is never sent when the site is visited
 * directly, or framed by anyone else. Empty with `maxAge` 0 clears it; a partitioned cookie is
 * cleared only by a `Set-Cookie` with the same attributes, so both use this one.
 */
const draftCookie = (value: string, maxAge: number) =>
  `${DRAFT_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`;

/**
 * What a draft link may be opened as (`Sec-Fetch-Dest`): a page, or a page in a frame. With the
 * cookie riding cross-site requests, another site's image, script or fetch pointed at a draft link
 * is refused before anything is read. A browser that doesn't send the header is let through: a
 * request it can't label could still be the person following a link. Defence in depth against a
 * draft link used as a subresource, not against someone sending a visitor their own preview link.
 */
const OPENED_AS = new Set(['document', 'iframe', 'frame']);

/** The entry and token a draft cookie holds, or null for anything else. */
export function readDraftCookie(
  value: string | undefined,
): { readonly entryId: string; readonly token: string } | null {
  if (!value) return null;
  const at = value.indexOf('~');
  if (at <= 0) return null;
  try {
    const entryId = decodeURIComponent(value.slice(0, at));
    const token = decodeURIComponent(value.slice(at + 1));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
    const bad = /[\u0000-\u001f\u007f]/;
    if (!entryId || !token || bad.test(entryId) || bad.test(token)) return null;
    return { entryId, token };
  } catch {
    return null;
  }
}

/**
 * `path` when it is a path on this site, else undefined: it starts with one `/` (never `//` or
 * `/\`, which browsers read as another host), holds no control characters, and resolves to the
 * same origin.
 */
export function safeRedirectPath(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  if (path[1] === '/' || path[1] === '\\') return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (/[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const probe = 'https://draft.invalid';
  try {
    return new URL(path, probe).origin === probe ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Seconds the draft cookie may live: what the token has left (when said), at most an hour. */
function cookieLife(res: Response, now: number): number {
  const expires = Date.parse(res.headers.get(EXPIRES_HEADER) ?? '');
  if (!Number.isFinite(expires)) return DRAFT_COOKIE_MAX_AGE;
  return Math.min(DRAFT_COOKIE_MAX_AGE, Math.floor((expires - now) / 1000));
}

/**
 * The route handler a type's preview URL opens: `app/api/draft/route.ts` with
 * `export const GET = createDraftRoute({ … })`, and the type's preview URL set to
 * `https://<site>/api/draft?entry={id}&token={token}&locale={locale}`.
 *
 * It reads the entry with its preview token (no key: the token is the grant, for that one entry,
 * until it expires). Answered, it sets the draft cookie ({@link DRAFT_COOKIE}: the entry and the
 * token, HttpOnly, for no longer than the token has left and an hour at most), turns draft mode on
 * and redirects (307) to the entry's page. A token the Preview API refuses gets 401 and changes
 * nothing; a link missing its entry or token, 400; a Preview API that can't answer, 502. The token
 * is never echoed back, and leaves the URL at once: the page it redirects to has none.
 *
 * It works top-level and framed by the admin (the editor's Site view and canvas), on another site
 * or the same: the cookie is `SameSite=None; Partitioned`, kept per top-level site, so a draft
 * opened in the admin's frame stays there. A request that isn't a page or a frame
 * (`Sec-Fetch-Dest`: an image, a script, a fetch) gets 403 before anything is read.
 */
export function createDraftRoute(o: DraftRouteOptions): (request: Request) => Promise<Response> {
  const doFetch = o.fetch ?? globalThis.fetch;
  const base = `${o.baseUrl.replace(/\/$/, '')}/preview/${encodeURIComponent(o.space)}/${encodeURIComponent(o.environment)}`;
  return async (request) => {
    const dest = request.headers.get('sec-fetch-dest');
    if (dest && !OPENED_AS.has(dest)) return text(403, 'A preview link opens as a page.');
    const query = new URL(request.url).searchParams;
    const entryId = query.get('entry');
    const token = query.get('token');
    if (!entryId || !token) return text(400, 'This preview link is missing its entry or token.');
    const qs = new URLSearchParams({ preview_token: token });
    const locale = query.get('locale');
    if (locale) qs.set('locale', locale);
    let res: Response;
    try {
      res = await doFetch(`${base}/entries/${encodeURIComponent(entryId)}?${qs}`, {
        headers: { accept: 'application/json' },
        // A token read is never kept: not by Next.js's data cache, whatever the site configures.
        cache: 'no-store',
      });
    } catch {
      return text(502, 'The Preview API could not be reached.');
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return text(401, 'This preview link is invalid or has expired.');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return text(502, `The Preview API answered ${res.status}.`);
    }
    let entry: DeliveredEntry;
    try {
      entry = (await res.json()) as DeliveredEntry;
    } catch {
      return text(502, 'The Preview API answered something other than an entry.');
    }
    const life = cookieLife(res, Date.now());
    if (life <= 0) return text(401, 'This preview link is invalid or has expired.');
    // Where to go first, so a resolvePath that throws leaves draft mode as it was.
    let resolved: string | undefined;
    try {
      resolved = safeRedirectPath(await o.resolvePath?.(entry));
    } catch {
      resolved = '/';
    }
    (await o.draftMode()).enable();
    const value = `${encodeURIComponent(entryId)}~${encodeURIComponent(token)}`;
    return redirect(
      request,
      resolved ?? safeRedirectPath(query.get('path')) ?? '/',
      draftCookie(value, life),
    );
  };
}

/**
 * A route handler that turns draft mode off, clears the draft cookie, and redirects (307) to
 * `path` (default `/`), or to the request's own `path` parameter when that is a path on this site:
 * `app/api/draft/exit/route.ts` with `export const GET = createExitDraftRoute({ draftMode })`.
 */
export function createExitDraftRoute(o: {
  readonly draftMode: DraftMode;
  readonly path?: string;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    // Another site's image or fetch can't switch a visitor's draft mode off either.
    const dest = request.headers.get('sec-fetch-dest');
    if (dest && !OPENED_AS.has(dest)) return text(403, 'A preview link opens as a page.');
    (await o.draftMode()).disable();
    const asked = safeRedirectPath(new URL(request.url).searchParams.get('path'));
    return redirect(request, asked ?? safeRedirectPath(o.path) ?? '/', draftCookie('', 0));
  };
}

export interface DraftClientOptions {
  readonly draftMode: DraftMode;
  /** Next.js's `cookies`, to read the draft cookie the route set. */
  readonly cookies: DraftCookies;
  /** The Delivery client's options: what every visitor reads, and draft mode reads too. */
  readonly delivery: ClientOptions;
  /**
   * Where the Preview API is when it isn't Delivery's host (`https://api.<your domain>`). The
   * draft entry is read there with the link's token: no key.
   */
  readonly preview?: { readonly baseUrl?: string };
}

/** A client that knows the entry draft mode shows. */
export type DraftClient = DeliveryClient & {
  /** The entry draft mode shows, or null outside draft mode. */
  readonly draft: { readonly entryId: string } | null;
  /**
   * The draft entry as it is now, or null outside draft mode or once its token stops working:
   * for a page that finds its entry another way than by id (a slug it hasn't published yet).
   */
  getDraftEntry(o?: { locale?: string }): Promise<DeliveredEntry | null>;
};

/**
 * The client to read with in a server component or route. Outside draft mode it is the Delivery
 * client. In draft mode it is the Delivery client too, except for the entry the draft cookie
 * names: `getEntry` of it, and it wherever it appears in `listEntries`, `query()` and
 * `getSingleton`, is that entry as it is now, read with the link's token, and `editable()` marks
 * only it. Every other entry reads published. When the token has expired the entry reads published
 * again. Delivery's own `include` still resolves what the draft links to as published.
 *
 * ```ts
 * export const getClient = createDraftClient({ draftMode, cookies, delivery, preview });
 * const client = await getClient();
 * ```
 */
export function createDraftClient(o: DraftClientOptions): () => Promise<DraftClient> {
  let delivery: DeliveryClient | undefined;
  let plain: DraftClient | undefined;
  const doFetch = o.delivery.fetch ?? globalThis.fetch;
  const previewBase =
    `${(o.preview?.baseUrl ?? o.delivery.baseUrl).replace(/\/$/, '')}/preview/` +
    `${encodeURIComponent(o.delivery.space)}/${encodeURIComponent(o.delivery.environment)}`;
  return async () => {
    delivery ??= createDeliveryClient({ ...o.delivery, preview: false });
    const d = delivery;
    const ref = (await o.draftMode()).isEnabled
      ? readDraftCookie((await o.cookies()).get(DRAFT_COOKIE)?.value)
      : null;
    if (!ref) {
      plain ??= { ...d, draft: null, getDraftEntry: async () => null };
      return plain;
    }
    // One read per locale per request: a page that asks twice gets the same answer.
    const reads = new Map<string, Promise<DeliveredEntry | null>>();
    const draftEntry = (locale?: string): Promise<DeliveredEntry | null> => {
      const key = locale ?? '';
      let read = reads.get(key);
      if (!read) {
        const qs = new URLSearchParams({ preview_token: ref.token });
        if (locale) qs.set('locale', locale);
        read = doFetch(`${previewBase}/entries/${encodeURIComponent(ref.entryId)}?${qs}`, {
          headers: { accept: 'application/json' },
          // A token read is never kept: not by Next.js's data cache, whatever the site configures.
          cache: 'no-store',
        }).then(
          async (res) => {
            if (!res.ok) {
              // An expired or revoked token: the entry reads published, as everyone sees it.
              await res.body?.cancel().catch(() => {});
              return null;
            }
            return (await res.json()) as DeliveredEntry;
          },
          () => null,
        );
        reads.set(key, read);
      }
      return read;
    };
    async function swap<F extends Fields>(
      page: { items: DeliveredEntry<F>[]; total: number; nextCursor?: string },
      locale: string | undefined,
    ) {
      if (!page.items.some((e) => e.id === ref?.entryId)) return page;
      const now = await draftEntry(locale);
      if (!now) return page;
      return {
        ...page,
        items: page.items.map((e) => (e.id === now.id ? (now as DeliveredEntry<F>) : e)),
      };
    }
    const listEntries = async <F extends Fields = Fields>(q: EntryQuery = {}) =>
      swap(await d.listEntries<F>(q), q.locale);
    const client: DraftClient = {
      ...d,
      draft: { entryId: ref.entryId },
      getDraftEntry: (q = {}) => draftEntry(q.locale),
      async getEntry<F extends Fields = Fields>(
        id: string,
        q: Pick<EntryQuery, 'locale' | 'include'> = {},
      ): Promise<DeliveredEntry<F>> {
        if (id === ref.entryId) {
          const now = await draftEntry(q.locale);
          if (now) return now as DeliveredEntry<F>;
        }
        return d.getEntry<F>(id, q);
      },
      async getSingleton<F extends Fields = Fields>(
        contentType: string,
        q: Pick<EntryQuery, 'locale' | 'include'> = {},
      ): Promise<DeliveredEntry<F>> {
        let found: DeliveredEntry<F>;
        try {
          found = await d.getSingleton<F>(contentType, q);
        } catch (err) {
          // Never published: the draft is the singleton, when it is this type's.
          if (!(err instanceof DeliveryError && err.status === 404)) throw err;
          const now = await draftEntry(q.locale);
          if (now?.contentType === contentType) return now as DeliveredEntry<F>;
          throw err;
        }
        if (found.id !== ref.entryId) return found;
        return ((await draftEntry(q.locale)) ?? found) as DeliveredEntry<F>;
      },
      listEntries,
      query: () => new EntryQueryBuilder<Fields>((q) => listEntries(q)),
      // Only the draft entry is marked: it is the one the editor is looking at.
      editable(entry, field, q = {}): Record<string, string> {
        if (entry.id !== ref.entryId) return {};
        return {
          [CONTENT_REF_ATTRIBUTE]: formatContentRef({
            space: o.delivery.space,
            environment: o.delivery.environment,
            entryId: entry.id,
            contentType: entry.contentType,
            field,
            locale: q.locale ?? o.delivery.locale ?? '*',
          }),
        };
      },
    };
    return client;
  };
}
