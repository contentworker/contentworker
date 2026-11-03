import {
  assertQueryRespectsFieldRules,
  canAccessContentType,
  type Principal,
  resolveLocalizedValue,
  type Scope,
} from '@contentworker/domain';
import type { DeliveryResolvers, ResolvedEntry } from '@contentworker/ports';
import { getDeliveredAsset } from './asset-delivery';
import type { AppContext } from './context';
import {
  getPublishedEntry,
  listPublishedEntries,
  maskDeliveredFields,
  visibleSearchHits,
} from './delivery';
import { type DeliveryReads, deliveryReads } from './delivery-reads';
import { entryQueryFrom } from './entry-query';
import { hybridSearch, type RagDeps } from './rag';

export interface DeliveryGraphDeps {
  /** Semantic search's embeddings and index; absent, `search` is lexical only. */
  readonly rag: RagDeps | undefined;
  /**
   * The request's reads. The route passes the ones it built the schema with, so the space config
   * and content types it already read aren't read again by any field.
   */
  readonly reads?: DeliveryReads;
}

/**
 * The GraphQL Delivery resolvers for one request: one scope, one caller. They call the same
 * use-cases as the REST routes with the same authorization (per-type access, field masking, no
 * assets for a key with content grants), so the GraphQL surface can never read more than REST.
 *
 * Built per request and never stored in the (shared, cached) schema: they carry the caller's
 * principal and the request's reads.
 */
export function deliveryGraphResolvers(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  deps: DeliveryGraphDeps,
): DeliveryResolvers {
  const reads = deps.reads ?? deliveryReads(ctx);
  const spaceConfig = async () => (await reads.read(scope, { config: true })).config;
  // GraphQL types each field as one value (a String, not a map of locales), so a query that
  // names no locale reads the space's default one; REST, which can return the map, doesn't.
  const localeOr = async (locale: string | undefined) =>
    locale || (await spaceConfig())?.defaultLocale;
  return {
    entry: async (contentType, id, locale) => {
      if (!canAccessContentType(principal, 'read', contentType)) return null;
      try {
        const e = await getPublishedEntry(ctx, scope, id, {
          locale: await localeOr(locale),
          include: 1,
          reads,
        });
        if (e.contentType !== contentType) return null;
        // Same field-level masking as the REST single-entry path.
        return {
          ...e,
          fields: maskDeliveredFields(principal, e.contentType, e.fields),
        } as ResolvedEntry;
      } catch {
        return null;
      }
    },
    collection: async (contentType, args) => {
      if (!canAccessContentType(principal, 'read', contentType)) return [];
      const raw: [string, string][] = [];
      // `and`/`or` hold groups of predicates (`{ field, op, value }`), the REST `where` parameter's
      // JSON; every other key is a query-string key (`fields.title[startsWith]`, `links_to_entry`).
      const groups: Record<string, unknown>[] = [];
      for (const [k, v] of Object.entries(args.where ?? {})) {
        if (k === 'and' || k === 'or') groups.push({ [k]: v });
        else raw.push([k, Array.isArray(v) ? v.join(',') : String(v)]);
      }
      if (groups.length) {
        raw.push(['where', JSON.stringify(groups.length === 1 ? groups[0] : { and: groups })]);
      }
      if (args.order?.length) raw.push(['order', args.order.join(',')]);
      if (args.search) raw.push(['query', args.search]);
      const parsed = entryQueryFrom(raw);
      assertQueryRespectsFieldRules(principal, { ...parsed, contentTypeApiId: contentType });
      const items = await listPublishedEntries(
        ctx,
        scope,
        { ...parsed, contentTypeApiId: contentType, limit: args.limit, skip: args.skip },
        { locale: await localeOr(args.locale), include: 1, reads },
      );
      return items.map((e) => ({
        ...e,
        fields: maskDeliveredFields(principal, e.contentType, e.fields),
      })) as ResolvedEntry[];
    },
    asset: async (id, locale) => {
      if (principal.contentGrants) return null;
      try {
        // Text per locale: each Asset field resolves its own `locale`, then the query's.
        const asset = await getDeliveredAsset(ctx, scope, id, { reads });
        return { asset, ...(locale ? { locale } : {}) };
      } catch {
        return null;
      }
    },
    localize: async (value, locale) => {
      const config = await spaceConfig();
      if (!config) return null;
      const v = resolveLocalizedValue(
        value,
        {
          defaultLocale: config.defaultLocale,
          locales: config.locales,
          fallbacks: config.fallbacks,
        },
        locale ?? config.defaultLocale,
      );
      return typeof v === 'string' ? v : null;
    },
    search: async (query, topK) => {
      const raw = await hybridSearch(deps.rag, ctx, scope, query, { topK });
      return visibleSearchHits(ctx, scope, principal, raw);
    },
  };
}
