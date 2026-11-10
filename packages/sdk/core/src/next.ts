/**
 * Draft mode for Next.js (App Router). A content type's preview URL points at a route handler
 * made by {@link createDraftRoute}; it checks the entry's preview token against the Preview API,
 * turns draft mode on and redirects to the page. Pages then read through {@link createDraftClient},
 * which answers a Preview client while draft mode is on and the Delivery client otherwise.
 *
 * Nothing here imports Next.js: pass its `draftMode` from `next/headers`, so the same code is
 * tested without it and works on every Next.js version whose `draftMode` is sync or async.
 */
import {
  type ClientOptions,
  createDeliveryClient,
  type DeliveredEntry,
  type DeliveryClient,
} from './index.js';

/** What Next.js's `draftMode()` returns (a promise of it from Next.js 15). */
export interface DraftModeHandle {
  readonly isEnabled: boolean;
  enable(): void;
  disable(): void;
}

/** Next.js's `draftMode` from `next/headers`. */
export type DraftMode = () => DraftModeHandle | Promise<DraftModeHandle>;

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

const redirect = (request: Request, path: string) =>
  new Response(null, {
    status: 307,
    headers: { ...HEADERS, location: new URL(path, request.url).toString() },
  });

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

/**
 * The route handler a type's preview URL opens: `app/api/draft/route.ts` with
 * `export const GET = createDraftRoute({ … })`, and the type's preview URL set to
 * `https://<site>/api/draft?entry={id}&token={token}&locale={locale}`.
 *
 * It reads the entry with its preview token (no key: the token is the grant, for that one entry,
 * until it expires). Answered, it turns draft mode on and redirects (307) to the entry's page.
 * A token the Preview API refuses gets 401 and leaves draft mode as it was; a link missing its
 * entry or token, 400; a Preview API that can't answer, 502. The token is never echoed back.
 *
 * Draft mode is Next.js's, and site-wide: once one entry's link turns it on, every page that reads
 * through {@link createDraftClient} reads with the site's Preview key, for as long as Next.js keeps
 * its draft-mode cookie, after the link's token has expired too. So whoever opens a preview link
 * can read every draft that key can. Bind the Preview key to a role that reads only the types the
 * site previews.
 */
export function createDraftRoute(o: DraftRouteOptions): (request: Request) => Promise<Response> {
  const doFetch = o.fetch ?? globalThis.fetch;
  const base = `${o.baseUrl.replace(/\/$/, '')}/preview/${encodeURIComponent(o.space)}/${encodeURIComponent(o.environment)}`;
  return async (request) => {
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
    // Where to go first, so a resolvePath that throws leaves draft mode as it was.
    let resolved: string | undefined;
    try {
      resolved = safeRedirectPath(await o.resolvePath?.(entry));
    } catch {
      resolved = '/';
    }
    (await o.draftMode()).enable();
    return redirect(request, resolved ?? safeRedirectPath(query.get('path')) ?? '/');
  };
}

/**
 * A route handler that turns draft mode off and redirects (307) to `path` (default `/`), or to
 * the request's own `path` parameter when that is a path on this site:
 * `app/api/draft/exit/route.ts` with `export const GET = createExitDraftRoute({ draftMode })`.
 */
export function createExitDraftRoute(o: {
  readonly draftMode: DraftMode;
  readonly path?: string;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    (await o.draftMode()).disable();
    const asked = safeRedirectPath(new URL(request.url).searchParams.get('path'));
    return redirect(request, asked ?? safeRedirectPath(o.path) ?? '/');
  };
}

export interface DraftClientOptions {
  readonly draftMode: DraftMode;
  /** The Delivery client's options: what every visitor reads. */
  readonly delivery: ClientOptions;
  /**
   * The Preview client's: a preview key (kept on the server) and, when the Preview API is on
   * another host than Delivery (`https://api.<your domain>`), its base URL. Everything else is
   * the Delivery client's.
   */
  readonly preview: Partial<Omit<ClientOptions, 'preview' | 'token'>> & { readonly token: string };
}

/**
 * The client to read with in a server component or route: a Preview client (drafts, and
 * `editable()` markup) while draft mode is on, the Delivery client otherwise. Each is made once.
 *
 * ```ts
 * export const getClient = createDraftClient({ draftMode, delivery, preview });
 * const client = await getClient();
 * ```
 */
export function createDraftClient(o: DraftClientOptions): () => Promise<DeliveryClient> {
  let delivery: DeliveryClient | undefined;
  let preview: DeliveryClient | undefined;
  return async () => {
    if ((await o.draftMode()).isEnabled) {
      preview ??= createDeliveryClient({ ...o.delivery, ...o.preview, preview: true });
      return preview;
    }
    delivery ??= createDeliveryClient(o.delivery);
    return delivery;
  };
}
