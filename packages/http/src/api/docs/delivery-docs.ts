import { doc } from './openapi';
import { asset, publishedEntry, publishedEntryList, searchHits } from './schemas';

/**
 * The Delivery routes' OpenAPI descriptions, kept apart from the routes themselves so the
 * delivery Worker, which serves the routes but no API docs, never bundles zod, hono-openapi or
 * the response schemas (about 40% of its script). The api mounts the routes with these
 * (`deliveryRoutes(deps, describeDelivery)`), so its OpenAPI document is unchanged.
 */
const DOCS = {
  search: () =>
    doc('Delivery', 'Search published content', {
      ok: searchHits,
      description:
        'Hybrid search by default: Vectorize ANN + the FTS5 SearchShard full-text index, fused with Reciprocal Rank Fusion.',
      query: {
        q: 'Search query',
        mode: 'hybrid (default) | semantic | lexical',
        top_k: 'Max hits (default 10)',
      },
    }),
  listEntries: () =>
    doc('Delivery', 'List published entries', {
      ok: publishedEntryList,
      query: {
        content_type: 'Filter by content type apiId',
        locale: 'Resolve fields for one locale',
        include: 'Reference resolution depth',
      },
    }),
  getEntry: () =>
    doc('Delivery', 'Get a published entry', {
      ok: publishedEntry,
      query: { locale: 'Resolve fields for one locale', include: 'Reference resolution depth' },
    }),
  listAssets: () => doc('Delivery', 'List published assets', { query: { limit: 'Max items' } }),
  getAsset: () => doc('Delivery', 'Get a published asset', { ok: asset }),
  live: () =>
    doc('Delivery', 'Live Content API (SSE)', {
      okDescription: 'text/event-stream of published-content domain events for this scope',
      query: { types: 'Comma-separated event-type filter, e.g. entry.published' },
    }),
  transform: () =>
    doc('Delivery', 'Resolve a transformed image URL', {
      status: 302,
      okDescription: 'Redirects to the CDN-transformable image URL',
      query: {
        w: 'Width',
        h: 'Height',
        fit: 'Fit mode',
        fm: 'Output format: auto (AVIF/WebP negotiated from Accept) | jpg | png | webp | avif',
        q: 'Quality',
      },
    }),
} as const;

export type DeliveryDocKey = keyof typeof DOCS;

/** Describes a Delivery route for the api's OpenAPI document. */
export const describeDelivery = (key: DeliveryDocKey) => DOCS[key]();
