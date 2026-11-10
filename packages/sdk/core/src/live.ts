/**
 * The Live Content API: Delivery's server-sent event stream of published-content changes
 * (`GET /delivery/:space/:env/live`). Read with `fetch` rather than `EventSource`, which can't
 * send the bearer key. The server decides what a key sees (its space, environment and content
 * grants) and ends each stream after ten minutes so the key is authorized again; this module
 * reconnects across that, and across failures, and stops for good when the key is refused.
 */

/** Where an event happened. */
export interface LiveScope {
  readonly spaceId: string;
  readonly environmentId: string;
}

interface LiveEventBase {
  readonly id: string;
  readonly scope: LiveScope;
  readonly occurredAt: string;
}

/** An entry was published: `fields` are its delivered values, keyed by locale. */
export interface LiveEntryPublished extends LiveEventBase {
  readonly type: 'entry.published';
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly version: number;
  readonly fields: Record<string, unknown>;
}

export interface LiveEntryUnpublished extends LiveEventBase {
  readonly type: 'entry.unpublished';
  readonly entryId: string;
  readonly contentTypeApiId: string;
}

/** One chunk of a bulk publish or unpublish: the entries it changed, by id. */
export interface LiveEntriesPublishedBulk extends LiveEventBase {
  readonly type: 'entries.published_bulk';
  readonly jobId: string;
  readonly chunkId: string;
  readonly action: 'publish' | 'unpublish';
  readonly entryIds: readonly string[];
}

export interface LiveAssetPublished extends LiveEventBase {
  readonly type: 'asset.published';
  readonly assetId: string;
  /** The file version this publish took out of Delivery, when a newer one replaced it. */
  readonly replacedVersion?: number;
}

export interface LiveAssetUnpublished extends LiveEventBase {
  readonly type: 'asset.unpublished';
  readonly assetId: string;
}

export interface LiveContentTypePublished extends LiveEventBase {
  readonly type: 'content_type.published';
  readonly contentTypeApiId: string;
  readonly version: number;
}

export interface LiveContentTypeDeleted extends LiveEventBase {
  readonly type: 'content_type.deleted';
  readonly contentTypeApiId: string;
  readonly version: number;
}

/** A release shipped; each of its entries also gets its own `entry.published`. */
export interface LiveReleasePublished extends LiveEventBase {
  readonly type: 'release.published';
  readonly releaseId: string;
  readonly entryIds: readonly string[];
}

/** The environment alias this stream reads through was repointed (or removed: `null`). */
export interface LiveEnvironmentAliasChanged extends LiveEventBase {
  readonly type: 'environment_alias.changed';
  readonly targetEnvironmentId: string | null;
}

/** Every event the live stream carries. */
export type LiveEvent =
  | LiveEntryPublished
  | LiveEntryUnpublished
  | LiveEntriesPublishedBulk
  | LiveAssetPublished
  | LiveAssetUnpublished
  | LiveContentTypePublished
  | LiveContentTypeDeleted
  | LiveReleasePublished
  | LiveEnvironmentAliasChanged;

export type LiveEventType = LiveEvent['type'];

/**
 * Where a subscription stands: `connecting` (the first attempt), `open` (the stream is up),
 * `reconnecting` (waiting to try again after a failure or the stream's end) or `closed` (for good:
 * `close()`, the signal, or a refused key).
 */
export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** What to listen for, and what to do with it. */
export interface LiveOptions {
  /** Only these event types; filtered by the server (`?types=`). Default: every type. */
  readonly types?: readonly LiveEventType[];
  /**
   * Only events about these entries: their publishes and unpublishes, and bulk jobs and releases
   * that include one. With `contentTypes` too, an event passes when it matches either.
   */
  readonly entryIds?: readonly string[];
  /**
   * Only events about entries of these content types, and the types' own changes. A bulk job or
   * release names its entries but not their types, so it always passes this filter.
   */
  readonly contentTypes?: readonly string[];
  readonly onEvent: (event: LiveEvent) => void;
  readonly onStatus?: (status: LiveStatus) => void;
  /**
   * A failure: transient while `status` is `reconnecting`, final once it is `closed` (a
   * `DeliveryError` for a refused key, a wrong space or environment, or a bad request).
   */
  readonly onError?: (error: Error) => void;
  /** Reconnect backoff, ms: exponential from `minMs` (default 1000) up to `maxMs` (30000). */
  readonly retry?: { readonly minMs?: number; readonly maxMs?: number };
  /** Aborting it closes the subscription. */
  readonly signal?: AbortSignal;
}

export interface LiveSubscription {
  /** Ends the stream and stops reconnecting. Safe to call more than once. */
  close(): void;
  readonly status: LiveStatus;
}

/** One dispatched server-sent event. */
export interface SseMessage {
  /** The `event:` field, `message` when none was sent. */
  readonly event: string;
  readonly data: string;
  /** The last `id:` seen on the stream, when one was. */
  readonly id?: string;
  /** A `retry:` the server asked for, in ms, when this message carried one. */
  readonly retry?: number;
}

/**
 * An incremental parser for `text/event-stream`, as the HTML standard defines it: lines end in
 * CRLF, LF or CR, and a chunk may end anywhere, even between the CR and LF of one line break; a
 * leading byte-order mark is dropped; `:` lines are comments; a blank line dispatches the event,
 * unless it carried no data. Feed it decoded text; it returns the events each chunk completed.
 */
export function createSseParser(): { push(chunk: string): SseMessage[] } {
  let buffer = '';
  let first = true;
  /** The previous chunk ended in CR: an LF starting this one belongs to that line break. */
  let afterCr = false;
  let event = '';
  let data: string[] = [];
  let lastId: string | undefined;
  let retry: number | undefined;

  const line = (text: string, out: SseMessage[]) => {
    if (text === '') {
      if (data.length > 0) {
        out.push({
          event: event || 'message',
          data: data.join('\n'),
          ...(lastId !== undefined ? { id: lastId } : {}),
          ...(retry !== undefined ? { retry } : {}),
        });
      }
      event = '';
      data = [];
      retry = undefined;
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        event = value;
        return;
      case 'data':
        data.push(value);
        return;
      case 'id':
        if (!value.includes('\0')) lastId = value;
        return;
      case 'retry':
        if (/^\d+$/.test(value)) retry = Number(value);
        return;
    }
  };

  return {
    push(chunk) {
      // Nothing to read, and nothing to forget: a CR that ended the last chunk still waits for its LF.
      if (chunk === '') return [];
      let text = chunk;
      if (first && text.length > 0) {
        first = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (afterCr && text.startsWith('\n')) text = text.slice(1);
      afterCr = false;
      buffer += text;
      const out: SseMessage[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== '\n' && c !== '\r') continue;
        line(buffer.slice(start, i), out);
        if (c === '\r') {
          if (i + 1 === buffer.length) afterCr = true;
          else if (buffer[i + 1] === '\n') i++;
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
  };
}

/**
 * Whether an event passes the client-side filters (`entryIds`, `contentTypes`). Without either,
 * everything does. An alias change always does: everything read through it may have changed.
 */
export function liveEventMatches(
  event: LiveEvent,
  filter: Pick<LiveOptions, 'entryIds' | 'contentTypes'>,
): boolean {
  const ids = filter.entryIds;
  const types = filter.contentTypes;
  if (!ids && !types) return true;
  switch (event.type) {
    case 'entry.published':
    case 'entry.unpublished':
      return (
        (ids?.includes(event.entryId) ?? false) ||
        (types?.includes(event.contentTypeApiId) ?? false)
      );
    case 'entries.published_bulk':
    case 'release.published':
      // The event names entries, not their types: a type filter can't rule it out.
      return types !== undefined || event.entryIds.some((id) => ids?.includes(id));
    case 'content_type.published':
    case 'content_type.deleted':
      return types?.includes(event.contentTypeApiId) ?? false;
    case 'environment_alias.changed':
      return true;
    default:
      return false;
  }
}

/** What the Delivery client hands the live stream; `random` and timers are for tests. */
export interface LiveConnection {
  /** The stream's URL, without `?types=`. */
  readonly url: string;
  readonly token: string;
  readonly fetch: typeof fetch;
  /** The error for a response that won't get better by retrying. */
  readonly toError: (res: Response, url: string) => Promise<Error>;
  readonly random?: () => number;
}

const MIN_MS = 1000;
const MAX_MS = 30_000;
/** Longest wait a `Retry-After` is followed for: past it, the backoff's ceiling applies. */
const RETRY_AFTER_CAP_MS = 10 * 60_000;

/** Responses worth another try: a timeout, a rate limit, a server or gateway failure. */
const retriable = (status: number) => status === 408 || status === 429 || status >= 500;

function retryAfterMs(res: Response, now: number): number | undefined {
  const value = res.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : undefined;
}

/** Opens the live stream and keeps it open until closed; see {@link LiveOptions}. */
export function openLive(conn: LiveConnection, options: LiveOptions): LiveSubscription {
  const minMs = Math.max(0, options.retry?.minMs ?? MIN_MS);
  const maxMs = Math.max(minMs, options.retry?.maxMs ?? MAX_MS);
  const random = conn.random ?? Math.random;
  // Called unbound: a browser's `fetch` refuses any `this` but the window.
  const doFetch = conn.fetch;
  const qs = options.types?.length ? `?types=${encodeURIComponent(options.types.join(','))}` : '';
  const url = `${conn.url}${qs}`;

  let status: LiveStatus = 'connecting';
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const setStatus = (next: LiveStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };
  const report = (err: unknown) =>
    options.onError?.(err instanceof Error ? err : new Error(String(err)));

  const close = () => {
    if (status === 'closed') return;
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    options.signal?.removeEventListener('abort', close);
    setStatus('closed');
  };

  /** Full jitter: anywhere from `minMs` up to the attempt's exponential ceiling. */
  const backoff = () => {
    const ceiling = Math.min(maxMs, minMs * 2 ** failures);
    failures++;
    return minMs + random() * (ceiling - minMs);
  };

  const again = (waitMs?: number) => {
    if (status === 'closed') return;
    setStatus('reconnecting');
    const delay = Math.max(waitMs ?? 0, backoff());
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
  };

  const deliver = (message: SseMessage) => {
    if (message.event === 'ping') return;
    let event: LiveEvent;
    try {
      event = JSON.parse(message.data) as LiveEvent;
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null || typeof event.type !== 'string') return;
    if (!liveEventMatches(event, options)) return;
    // The caller's handler failing is the caller's: reported, and the stream reads on.
    try {
      options.onEvent(event);
    } catch (err) {
      report(err);
    }
  };

  const connect = async () => {
    if (status === 'closed') return;
    const abort = new AbortController();
    controller = abort;
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { authorization: `Bearer ${conn.token}`, accept: 'text/event-stream' },
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      report(err);
      again();
      return;
    }
    if (abort.signal.aborted) return;
    if (!res.ok) {
      if (retriable(res.status)) {
        report(await conn.toError(res, url));
        again(retryAfterMs(res, Date.now()));
        return;
      }
      // A refused key, a space or environment it can't read, a bad request: retrying would only
      // be refused again.
      const err = await conn.toError(res, url);
      close();
      report(err);
      return;
    }
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
      await res.body?.cancel().catch(() => {});
      close();
      report(new Error(`Live stream answered ${res.status} without an event stream: ${url}`));
      return;
    }

    failures = 0;
    setStatus('open');
    const parser = createSseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          if (abort.signal.aborted) return;
          deliver(message);
        }
      }
      for (const message of parser.push(decoder.decode())) deliver(message);
    } catch (err) {
      if (abort.signal.aborted) return;
      report(err);
      // A read that failed may leave the connection half open: end it before the next one.
      void reader.cancel().catch(() => {});
    }
    if (abort.signal.aborted) return;
    // The stream ended: the server's lifetime for it ran out (the key is authorized again on the
    // next connect), or the connection dropped.
    again();
  };

  if (options.signal?.aborted) {
    status = 'closed';
    options.onStatus?.('closed');
  } else {
    options.signal?.addEventListener('abort', close);
    options.onStatus?.('connecting');
    void connect();
  }

  return {
    close,
    get status() {
      return status;
    },
  };
}
