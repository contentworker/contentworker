import { z } from 'zod';
import { doc } from './openapi';
import {
  deliveredAsset,
  deliveredAssetPage,
  deliveredAssetSearchPage,
  deliveredCollection,
  deliveredConcept,
  deliveredConceptList,
  deliveredTag,
  deliveredTagList,
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
        'metadata.tags.slug':
          'Entries carrying the tag with this slug (also [in]=a,b, [ne], [nin]; ' +
          'metadata.concepts.slug for concepts, metadata.tags / metadata.concepts for ids)',
      },
    }),
  getEntry: () =>
    doc('Delivery', 'Get a published entry', {
      ok: publishedEntry,
      query: { locale: 'Resolve fields for one locale', include: 'Reference resolution depth' },
    }),
  listAssets: () =>
    doc('Delivery', 'List or search published assets', {
      ok: z.union([deliveredAssetPage, deliveredAssetSearchPage]),
      description:
        'In publish order. URLs are on the media origin and immutable (the file version is in ' +
        'them). Page with the response’s nextCursor. With q, a hybrid search (full text and ' +
        'semantic, fused by rank) over published assets only, best match first, with facet ' +
        'counts by kind, tag and folder; limit applies, paging does not. A search needs the ' +
        'search:read scope as well as delivery:read (403 without it).',
      query: {
        q: 'Search text (1–256 characters): file name, title, caption, alt text, tags, document text',
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
  getCollection: () =>
    doc('Delivery', 'Get a collection’s published assets', {
      ok: deliveredCollection,
      description:
        'Its name and its published members in the collection’s order, in the delivered asset ' +
        'shape (drafts and archived members are left out). Page with nextCursor.',
      query: {
        limit: 'Page size',
        cursor: 'nextCursor from the previous page',
        locale: 'Resolve title, description and alt text for one locale',
      },
    }),
  listTags: () =>
    doc('Delivery', 'List tags', {
      ok: deliveredTagList,
      description:
        'Every tag, by slug, with its label, description and how many published entries carry ' +
        'it (in all, and per content type). A key limited to some content types counts only ' +
        'those. Cached like any delivery read, and purged when a tag changes or an entry publishes.',
      query: {
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
    }),
  getTag: () =>
    doc('Delivery', 'Get a tag by slug', {
      ok: deliveredTag,
      description: 'As in the list; 404 when no tag has the slug.',
      query: {
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
    }),
  listConcepts: () =>
    doc('Delivery', 'List concepts', {
      ok: deliveredConceptList,
      description:
        'Every concept (of one scheme with scheme), by slug, with its label, description, ' +
        'parent and published usage counts, as for tags.',
      query: {
        scheme: 'Only this scheme’s concepts',
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
    }),
  getConcept: () =>
    doc('Delivery', 'Get a concept by slug', {
      ok: deliveredConcept,
      description:
        'A slug is unique within a scheme: without scheme, a slug two schemes share is a 409. ' +
        '404 when no concept has it.',
      query: {
        scheme: 'The concept’s scheme',
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
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
