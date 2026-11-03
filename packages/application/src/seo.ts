import {
  type ContentType,
  canAccessContentType,
  deniedFieldsFor,
  type EntryFields,
  entrySitemapUrls,
  NotFoundError,
  type Principal,
  type Scope,
  type SeoMetadata,
  type SitemapUrl,
  seoFieldOf,
  sitemapFieldsOf,
  sitemapPageSize,
  urlPatternSlugFields,
  ValidationError,
} from '@contentworker/domain';
import type { SitemapPage } from '@contentworker/ports';
import type { AppContext } from './context';
import { type DeliveryReads, deliveryReads } from './delivery-reads';
import { type EntryView, getEntry, saveEntryDraft } from './entries';

/**
 * Search engine metadata and the sitemap. An entry's SEO metadata is its content type's `Seo`
 * field (see `SEO_FIELDS` in the domain), so it is saved, published and delivered like any field;
 * the use-cases here are a partial write for it and the sitemap built from what is published.
 */

// --- writing an entry's SEO --------------------------------------------------

/** A change to one locale's SEO metadata: a part left out keeps its value; null clears it. */
export type EntrySeoPatch = {
  readonly [K in keyof SeoMetadata]?: SeoMetadata[K] | null;
};

export interface SetEntrySeoOptions {
  /** The locale to change; the default locale when left out. Only a localized Seo field takes another. */
  readonly locale?: string;
}

/**
 * Changes an entry's SEO metadata in one locale and saves the result as a new draft version, as
 * an edit of the whole entry would (validated, hooked and versioned as `updateEntry` does); publish to
 * put it live. Refused when the entry's content type declares no Seo field.
 */
export async function setEntrySeo(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: EntrySeoPatch,
  opts: SetEntrySeoOptions = {},
): Promise<EntryView> {
  const { entry, fields } = await getEntry(ctx, scope, id);
  const [contentType, config] = await Promise.all([
    ctx.store.contentTypes.get(scope, entry.contentTypeApiId),
    ctx.store.spaces.getConfig(scope),
  ]);
  if (!contentType) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const field = seoFieldOf(contentType);
  if (!field) {
    throw new ValidationError([
      {
        field: 'seo',
        message: `Content type "${contentType.apiId}" has no Seo field: add one to give its entries SEO metadata`,
      },
    ]);
  }
  const locale = opts.locale ?? config.defaultLocale;
  // Validation reads a localized field in the space's locales only: a value under any other
  // would be stored and never read.
  if (!config.locales.includes(locale)) {
    throw new ValidationError([
      { field: field.apiId, locale, message: `"${locale}" is not one of this space's locales` },
    ]);
  }
  if (!field.localized && locale !== config.defaultLocale) {
    throw new ValidationError([
      {
        field: field.apiId,
        locale,
        message: `The Seo field is not localized; only ${config.defaultLocale} is allowed`,
      },
    ]);
  }
  const current = fields[field.apiId] ?? {};
  const value: Record<string, unknown> = {
    ...((current[locale] as SeoMetadata | undefined) ?? {}),
  };
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete value[key];
    else value[key] = v;
  }
  const { [locale]: _old, ...others } = current;
  const localized = Object.keys(value).length > 0 ? { ...others, [locale]: value } : others;
  const { [field.apiId]: _seo, ...rest } = fields;
  const next: EntryFields =
    Object.keys(localized).length > 0 ? { ...rest, [field.apiId]: localized } : rest;
  return saveEntryDraft(
    ctx,
    scope,
    entry,
    contentType,
    {
      defaultLocale: config.defaultLocale,
      locales: config.locales,
    },
    next,
  );
}

// --- the sitemap ---------------------------------------------------------------

/** One published entry in the sitemap: where it lives, in each locale it lives at. */
export interface DeliveredSitemapEntry {
  readonly entryId: string;
  readonly contentType: string;
  /** When its live version was published (ISO-8601). */
  readonly lastmod: string;
  /** At least one; alternates of each other when more than one (`hreflang`). */
  readonly urls: readonly SitemapUrl[];
}

export interface SitemapOptions {
  /**
   * The reader: types it may not read are left out, and so is a type whose URL pattern names a
   * field it may not read (the path would reveal the value). Default: everything.
   */
  readonly principal?: Principal;
  /**
   * The site's origin (`https://example.com`), when known: an entry whose canonical URL is on
   * another site is left out. Without it an absolute canonical is judged by its path alone.
   */
  readonly origin?: string;
  readonly reads?: DeliveryReads;
  /** Entries per sitemap file (`deliveredSitemapFile`); default `sitemapPageSize`. */
  readonly pageSize?: number;
}

/** The largest page `listDeliveredSitemap` returns. */
export const MAX_SITEMAP_PAGE = 5_000;
/** Its page size when the caller names none. */
export const DEFAULT_SITEMAP_PAGE = 1_000;

/** What the sitemap reads: the routable types, and the locales to list them in. */
async function sitemapPlan(ctx: AppContext, scope: Scope, opts: SitemapOptions) {
  const reads = opts.reads ?? deliveryReads(ctx);
  const { config, contentTypes = [] } = await reads.read(scope, {
    config: true,
    contentTypes: true,
  });
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const principal = opts.principal;
  const types = new Map<string, ContentType>();
  for (const t of contentTypes) {
    if (t.status !== 'published' || !t.urlPattern) continue;
    if (principal && !canAccessContentType(principal, 'read', t.apiId)) continue;
    const denied = principal ? deniedFieldsFor(principal, t.apiId) : [];
    if (urlPatternSlugFields(t.urlPattern).some((f) => denied.includes(f))) continue;
    types.set(t.apiId, t);
  }
  const fields = [...new Set([...types.values()].flatMap(sitemapFieldsOf))];
  return { reads, config, types, fields };
}

type Plan = Awaited<ReturnType<typeof sitemapPlan>>;

const toEntries = (plan: Plan, page: SitemapPage, origin?: string): DeliveredSitemapEntry[] =>
  page.items.flatMap((row) => {
    const type = plan.types.get(row.contentTypeApiId);
    if (!type) return [];
    const urls = entrySitemapUrls(
      type,
      { id: row.entryId, fields: row.fields },
      plan.config,
      origin,
    );
    return urls.length > 0
      ? [{ entryId: row.entryId, contentType: type.apiId, lastmod: row.publishedAt, urls }]
      : [];
  });

export interface SitemapPageRequest {
  /** The first entry id of the page: a previous page's `next`. From the start when absent. */
  readonly from?: string;
  /** Entries per page, 1..{@link MAX_SITEMAP_PAGE}. */
  readonly limit?: number;
}

/**
 * A page of the sitemap: the published entries of every published type with a URL pattern, by
 * entry id, each with its URLs. An entry with no URL (no slug, `noindex`, canonical elsewhere) is
 * left out, so a page can hold fewer than `limit`; `next` is null on the last.
 */
export async function listDeliveredSitemap(
  ctx: AppContext,
  scope: Scope,
  request: SitemapPageRequest = {},
  opts: SitemapOptions = {},
): Promise<{ items: DeliveredSitemapEntry[]; next: string | null }> {
  const plan = await sitemapPlan(ctx, scope, opts);
  if (plan.types.size === 0) return { items: [], next: null };
  const limit = Math.min(Math.max(1, request.limit ?? DEFAULT_SITEMAP_PAGE), MAX_SITEMAP_PAGE);
  const { sitemap } = await plan.reads.read(scope, {
    sitemap: {
      contentTypes: [...plan.types.keys()],
      fields: plan.fields,
      ...(request.from !== undefined ? { from: request.from } : {}),
      limit: limit + 1,
    },
  });
  const page = sitemap ?? { items: [] };
  const more = page.items.length > limit;
  return {
    items: toEntries(plan, { items: page.items.slice(0, limit) }, opts.origin),
    next: more ? (page.items[limit]?.entryId ?? null) : null,
  };
}

/**
 * One sitemap file for crawlers: the whole sitemap when it fits one file, else (without `page`)
 * an index of its pages, each named by its first entry id. Pages hold as many entries as keep
 * them under the protocol's 50,000 URLs (`sitemapPageSize`).
 */
export type SitemapFile =
  | { readonly kind: 'urlset'; readonly items: DeliveredSitemapEntry[] }
  | { readonly kind: 'index'; readonly pages: string[] };

export async function deliveredSitemapFile(
  ctx: AppContext,
  scope: Scope,
  page: string | undefined,
  opts: SitemapOptions = {},
): Promise<SitemapFile> {
  const plan = await sitemapPlan(ctx, scope, opts);
  if (plan.types.size === 0) return { kind: 'urlset', items: [] };
  const size = opts.pageSize ?? sitemapPageSize(plan.config.locales.length);
  const query = { contentTypes: [...plan.types.keys()], fields: plan.fields, limit: size };
  // The first page and the page boundaries in one round trip: a small space is served from it.
  const { sitemap } = await plan.reads.read(scope, {
    sitemap: page !== undefined ? { ...query, from: page } : { ...query, pageStarts: size },
  });
  const read = sitemap ?? { items: [] };
  if (page === undefined && (read.pageStarts?.length ?? 0) > 1) {
    return { kind: 'index', pages: read.pageStarts ?? [] };
  }
  return { kind: 'urlset', items: toEntries(plan, read, opts.origin) };
}
