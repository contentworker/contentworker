import { z } from 'zod';

/**
 * OpenAPI payload schemas for the documented routes. These describe the wire
 * shapes (zod 4 → JSON Schema via hono-openapi's resolver); they are not used
 * for runtime validation, so they stay deliberately permissive where the
 * domain model is dynamic (localized fields are `locale → value` maps whose
 * value type depends on the content type).
 */

export const errorResponse = z
  .object({
    error: z.object({
      code: z.string().describe('Machine-readable error code'),
      message: z.string(),
    }),
  })
  .describe('Error envelope');

export const localizedValue = z
  .record(z.string().describe('BCP-47 locale tag'), z.unknown())
  .describe('Localized value: locale → value (non-localized fields use the default locale)');

export const entryFields = z
  .record(z.string().describe('Field apiId'), localizedValue)
  .describe('Entry field values by field apiId');

export const field = z.object({
  apiId: z.string(),
  name: z.string(),
  type: z.string().describe('Field type (Symbol, Text, Integer, Reference, …)'),
  localized: z.boolean(),
  required: z.boolean(),
  position: z.int(),
});

export const contentType = z.object({
  apiId: z.string(),
  name: z.string(),
  displayField: z.string(),
  fields: z.array(field),
  version: z.int(),
  status: z.enum(['draft', 'published']),
});

export const entry = z.object({
  id: z.uuid().describe('UUIDv7 entry id'),
  contentTypeApiId: z.string(),
  status: z.enum(['draft', 'published', 'changed', 'archived']),
  currentVersion: z.int(),
  publishedVersion: z.int().optional(),
  fields: entryFields.optional(),
});

export const createdEntry = z.object({ entry, warnings: z.array(z.string()).optional() });

export const publishedEntry = z.object({
  id: z.uuid(),
  contentType: z.string().describe('Content type apiId'),
  fields: entryFields,
  publishedAt: z.iso.datetime(),
});

export const publishedEntryList = z.object({
  items: z.array(publishedEntry),
  total: z.int(),
});

export const searchHits = z.object({
  hits: z.array(
    z.object({
      entryId: z.uuid(),
      score: z.number().describe('Relevance (RRF-fused for hybrid mode)'),
      snippet: z.string(),
    }),
  ),
});

export const asset = z.object({
  id: z.uuid(),
  status: z.enum(['draft', 'published', 'archived']),
  file: z.object({
    url: z.string(),
    fileName: z.string(),
    contentType: z.string().describe('MIME type'),
    size: z.int().optional(),
    width: z.int().optional(),
    height: z.int().optional(),
  }),
  title: z.record(z.string(), z.unknown()),
  description: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  folderId: z.string().optional().describe('The folder it is filed in; absent at the root'),
  version: z.int().optional(),
  createdAt: z.iso.datetime().optional(),
  createdBy: z.string().optional(),
  archivedAt: z.iso.datetime().optional(),
  rights: z
    .object({
      license: z.string().optional(),
      credit: z.string().optional(),
      expiresAt: z.iso.datetime().optional(),
      embargoUntil: z.iso.datetime().optional(),
    })
    .optional(),
});

export const assetPage = z.object({
  items: z.array(asset),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass as ?cursor= for the next page; absent on the last page'),
});

export const assetFolder = z.object({
  id: z.uuid(),
  name: z.string(),
  parentId: z.string().optional().describe('Absent at the root'),
  path: z.string().describe('Materialized path of folder ids, e.g. /a/b/'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const assetFolderList = z.object({ items: z.array(assetFolder) });

export const assetMoved = z.object({
  moved: z.int().describe('How many of the ids were assets here and were filed'),
});

export const assetUsage = z.object({
  items: z.array(
    z.object({
      fromEntryId: z.string(),
      fromField: z.string(),
      toId: z.string(),
      toType: z.enum(['Entry', 'Asset']),
    }),
  ),
});

export const uploadTicket = z.object({
  asset,
  upload: z.object({
    url: z
      .string()
      .describe(
        'Signed PUT URL — upload bytes directly here (root-relative when the deployment has no MEDIA_BASE_URL)',
      ),
    headers: z.record(z.string(), z.string()),
  }),
});

export const videoUploadTicket = z.object({
  asset,
  upload: z.object({
    videoId: z.string().describe("The video host's id for the upload"),
    uploadUrl: z.url().describe('One-time direct upload URL on the video host'),
    method: z.literal('POST'),
    fileField: z.string().describe('Multipart form field carrying the file'),
  }),
});

export const principal = z.object({
  spaceId: z.string().describe('Space id, or `*` for the admin token'),
  kind: z.enum(['cma', 'cda', 'cpa', 'admin', 'user']),
  scopes: z.array(z.string()),
  restricted: z.boolean().optional(),
});

export const apiKeyCreated = z.object({
  id: z.uuid(),
  kind: z.enum(['cma', 'cda', 'cpa']),
  token: z.string().describe('Shown once — only its SHA-256 hash is stored'),
});

export const webhook = z.object({
  id: z.uuid(),
  url: z.url(),
  topics: z.array(z.string()).describe('Event types, e.g. entry.published'),
  active: z.boolean(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const spaceRef = z.object({ id: z.string(), name: z.string() });

export const createdSpace = spaceRef.extend({
  starter: z.enum(['empty', 'sample']),
  installed: z
    .object({
      contentTypes: z.number().int(),
      entries: z.number().int(),
      assets: z.number().int(),
      tags: z.number().int(),
      concepts: z.number().int(),
      releases: z.number().int(),
    })
    .optional()
    .describe('What the sample starter holds once installed (absent for `empty`)'),
});

export const health = z.object({ status: z.literal('ok') });
export const ready = z.object({ status: z.literal('ready'), role: z.string() });
