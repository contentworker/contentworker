/**
 * @contentworker/sdk-edge — minimal Delivery client for IoT, wearables, and kiosks. Zero
 * dependencies, tiny surface. It always requests a single locale so the API
 * returns flattened field values (no per-locale maps, no reference graphs), and
 * can project to a field subset to keep payloads as small as the device needs.
 */

export interface EdgeClientOptions {
  readonly baseUrl: string;
  readonly space: string;
  readonly environment: string;
  readonly token: string;
  /** The single locale to flatten to. */
  readonly locale: string;
  readonly fetch?: typeof fetch;
}

/** A compact, single-locale entry. */
export interface CompactEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
}

interface RawEntry {
  id: string;
  contentType: string;
  fields: Record<string, unknown>;
}

const project = (
  fields: Record<string, unknown>,
  pick?: readonly string[],
): Record<string, unknown> => {
  if (!pick || pick.length === 0) return fields;
  const out: Record<string, unknown> = {};
  for (const k of pick) if (k in fields) out[k] = fields[k];
  return out;
};

/** Creates a tiny edge client bound to one space/environment/locale. */
export function createEdgeClient(opts: EdgeClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = `${opts.baseUrl.replace(/\/$/, '')}/delivery/${opts.space}/${opts.environment}`;
  const headers = { authorization: `Bearer ${opts.token}` };

  async function get<T>(url: string): Promise<T> {
    const res = await doFetch(url, { headers });
    if (!res.ok) throw new Error(`edge delivery ${res.status}`);
    return (await res.json()) as T;
  }

  type ListOptions = { limit?: number; skip?: number; pick?: readonly string[] };
  async function list(contentType: string, options: ListOptions = {}): Promise<CompactEntry[]> {
    const qs = new URLSearchParams({ locale: opts.locale, content_type: contentType });
    if (options.limit !== undefined) qs.set('limit', String(options.limit));
    if (options.skip !== undefined) qs.set('skip', String(options.skip));
    if (options.pick?.length) qs.set('select', options.pick.join(','));
    const res = await get<{ items: RawEntry[] }>(`${base}/entries?${qs}`);
    return res.items.map((e) => ({
      id: e.id,
      contentType: e.contentType,
      fields: project(e.fields, options.pick),
    }));
  }

  return {
    /** Fetch one entry, flattened to the client locale, optionally field-projected. */
    async get(id: string, pick?: readonly string[]): Promise<CompactEntry> {
      const qs = new URLSearchParams({ locale: opts.locale });
      if (pick?.length) qs.set('select', pick.join(','));
      const e = await get<RawEntry>(`${base}/entries/${encodeURIComponent(id)}?${qs}`);
      return { id: e.id, contentType: e.contentType, fields: project(e.fields, pick) };
    },

    list,
    /** Walk a playlist one page at a time, stopping when the consumer breaks. */
    async *iterate(contentType: string, options: ListOptions = {}): AsyncGenerator<CompactEntry> {
      const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 100) || 1));
      for (
        let skip = Number.isFinite(options.skip) ? Math.max(0, Math.trunc(options.skip ?? 0)) : 0;
        ;
        skip += limit
      ) {
        const page = await list(contentType, { ...options, limit, skip });
        yield* page;
        if (page.length < limit) return;
      }
    },
  };
}

export type EdgeClient = ReturnType<typeof createEdgeClient>;
