import { doc } from './openapi';
import {
  deliveredAsset,
  deliveredAssetPage,
  publishedEntry,
  publishedEntryList,
  searchHits,
} from './schemas';

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
  listAssets: () =>
    doc('Delivery', 'List published assets', {
      ok: deliveredAssetPage,
      description:
        'In publish order. URLs are on the media origin and immutable (the file version is in ' +
        'them). Page with the response’s nextCursor.',
      query: {
        limit: 'Page size',
        cursor: 'nextCursor from the previous page',
        skip: 'Offset (without a cursor)',
        kind: 'image | video | audio | document | other',
        tag: 'A taxonomy tag id',
        folder: 'A folder id, or root for assets in no folder',
        locale: 'Resolve title, description and alt text for one locale',
      },
    }),
  getAsset: () =>
    doc('Delivery', 'Get a published asset', {
      ok: deliveredAsset,
      query: { locale: 'Resolve title, description and alt text for one locale' },
    }),
  live: () =>
    doc('Delivery', 'Live Content API (SSE)', {
      okDescription: 'text/event-stream of published-content domain events for this scope',
      query: { types: 'Comma-separated event-type filter, e.g. entry.published' },
    }),
  transform: () =>
    doc('Delivery', 'Resolve a transformed image URL (deprecated)', {
      status: 301,
      okDescription:
        'Redirects (permanently, cacheably) to the media URL of the next width step up from w, ' +
        'or of the named rendition. Use the asset’s srcset and renditions instead.',
      query: {
        w: 'Width: the next ladder step (320, 640, 960, 1280, 1920, 2560) at or above it',
        rendition: 'A rendition name',
      },
    }),
} as const;

export type DeliveryDocKey = keyof typeof DOCS;

/** Describes a Delivery route for the api's OpenAPI document. */
export const describeDelivery = (key: DeliveryDocKey) => DOCS[key]();
