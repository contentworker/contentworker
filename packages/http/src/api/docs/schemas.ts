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

export const contentTypeEntryCounts = z.object({
  items: z.array(
    z.object({
      contentType: z.string().describe('Content type apiId'),
      total: z.int().describe('Live entries: draft, changed and published (not the trash)'),
      draft: z.int(),
      changed: z.int().describe('Published, with unpublished edits'),
      published: z.int(),
      archived: z.int().describe('In the trash'),
    }),
  ),
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

export const assetPlaceholder = z
  .object({
    thumbhash: z
      .string()
      .describe('ThumbHash of the image (base64): decode it on the client to a blurred preview'),
    dominantColor: z.string().describe('The image’s dominant colour, #rrggbb'),
  })
  .describe('What to show while a raster image loads, computed by ingest');

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
    placeholder: assetPlaceholder.optional().describe('Absent until ingest has computed one'),
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
  contentHash: z.string().optional().describe('SHA-256 of the bytes (hex), once ingested'),
  ingestStatus: z
    .enum(['pending', 'processing', 'ready', 'error'])
    .optional()
    .describe('Where ingest stands on the current file; absent when it never ran'),
  ingestError: z.string().optional().describe('Why the last ingest failed'),
  duplicateOf: z
    .string()
    .optional()
    .describe('The oldest other asset here with the same bytes (a warning, not a block)'),
  aiSuggestions: z
    .object({
      altText: z.array(z.string()).optional().describe('Locales whose alt text a model wrote'),
      tags: z.array(z.string()).optional().describe('Tag ids a model chose'),
    })
    .optional()
    .describe('What ingest filled from a model that no person has saved yet'),
});

const assetFacets = z
  .object({
    kind: z.record(z.string(), z.int()),
    tag: z.record(z.string(), z.int()).describe('By tag id'),
    folder: z.record(z.string(), z.int()).describe('By folder id; root for assets in no folder'),
  })
  .describe('Matches per value, each counted with the other filters but not its own');

export const assetSearchPage = z.object({
  items: z.array(asset).describe('Best match first'),
  total: z.int().describe('Matches after the filters'),
  facets: assetFacets,
});

export const assetReindex = z.object({
  assets: z.int().describe('Assets sent through ingest'),
  job: z
    .looseObject({ id: z.string(), status: z.string(), totalItems: z.int() })
    .optional()
    .describe('The bulk job (GET /bulk-jobs/{id}); absent when there was nothing to do'),
  running: z
    .literal(true)
    .optional()
    .describe('Set when job is a reindex that was already running, not a new one'),
});

export const assetPage = z.object({
  items: z.array(asset),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass as ?cursor= for the next page; absent on the last page'),
});

const localizedText = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.null()])
  .describe('One locale’s value with ?locale=, else the value per locale');

export const deliveredAsset = z.object({
  id: z.string(),
  title: localizedText,
  description: localizedText,
  altText: localizedText,
  focalPoint: z.object({ x: z.number(), y: z.number() }).nullable(),
  contentType: z.string().describe('MIME type'),
  size: z.int().nullable(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  kind: z.enum(['image', 'video', 'audio', 'document', 'other']),
  url: z.string().describe('The original file on the media origin (a video’s HLS manifest)'),
  renditions: z
    .record(z.string(), z.string())
    .describe('The space’s renditions of this image, by name'),
  srcset: z
    .array(z.object({ width: z.int(), url: z.string() }))
    .describe('The width ladder (320–2560), up to the image’s own width'),
  placeholder: assetPlaceholder
    .nullable()
    .describe('A raster image’s ThumbHash and dominant colour; null until ingest computed them'),
  video: z
    .object({
      status: z.string(),
      hlsUrl: z.string().optional(),
      dashUrl: z.string().optional(),
      thumbnailUrl: z.string().optional(),
      durationSeconds: z.number().optional(),
    })
    .optional(),
  rights: z.object({ credit: z.string().optional(), license: z.string().optional() }).optional(),
  file: z
    .record(z.string(), z.unknown())
    .describe('The stored file description, kept for existing readers; file.url is url'),
});

export const deliveredAssetPage = z.object({
  items: z.array(deliveredAsset),
  total: z.int().describe('Items on this page'),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass as ?cursor= for the next page; absent on the last page'),
});

export const deliveredAssetSearchPage = z.object({
  items: z.array(deliveredAsset).describe('Best match first'),
  total: z.int().describe('Matches after the filters'),
  facets: assetFacets,
});

export const assetRendition = z.object({
  name: z.string().describe('Its URL segment: …/r-<name>/…'),
  width: z.int().optional(),
  height: z.int().optional(),
  fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
  format: z.enum(['auto', 'jpg', 'png', 'webp', 'avif']).optional(),
  quality: z.int().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const assetRenditionList = z.object({ items: z.array(assetRendition) });

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

export const assetFileReplacement = z.object({
  asset,
  upload: z.object({
    url: z.string().describe('Signed PUT URL for the new file (expires); upload the bytes here'),
    headers: z.record(z.string(), z.string()),
  }),
  commit: z
    .object({ version: z.int(), fileName: z.string(), contentType: z.string() })
    .describe('POST this to /assets/{id}/file/commit once the bytes are uploaded'),
});

export const assetVersionList = z.object({
  items: z.array(
    z.object({
      version: z.int(),
      file: asset.shape.file.describe('file.url is a short-lived signed read URL'),
      contentHash: z.string().optional(),
      createdAt: z.iso.datetime().optional().describe('When this file became the asset’s'),
      createdBy: z.string().optional(),
      current: z.boolean(),
      published: z.boolean().describe('The file Delivery serves now'),
      restoredFrom: z
        .int()
        .optional()
        .describe('For a restore: the earliest version with the same file'),
    }),
  ),
});

export const assetBulkJob = z.looseObject({
  id: z.string(),
  action: z.enum(['asset_move', 'asset_tag', 'asset_publish', 'asset_unpublish', 'asset_archive']),
  status: z.enum(['running', 'completed', 'cancelled']),
  totalItems: z.int(),
  totalChunks: z.int(),
  completedChunks: z.int(),
  succeeded: z.int(),
  failed: z.int(),
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
  environmentId: z
    .string()
    .nullable()
    .describe('The one environment whose events it receives; null for every environment'),
});

export const webhookList = z.object({ items: z.array(webhook) });

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

export const health = z.object({
  status: z.literal('ok'),
  scheduler: z
    .enum(['ok', 'stale', 'unknown'])
    .describe(
      'Whether the engine cron ticked in the last five minutes: `stale` when it has not (or never ' +
        'has), `unknown` when its heartbeat could not be read',
    ),
});
export const ready = z.object({ status: z.literal('ready'), role: z.string() });

export const schedulerStatus = z.object({
  scheduler: z.enum(['ok', 'stale']),
  lastTickAt: z.iso.datetime().optional().describe('When the cron last ticked; absent if never'),
  staleAfterSeconds: z.number().int(),
  jobs: z.array(
    z.object({
      job: z.string().describe('The sweep (`outbox-relay`, `scheduled-actions`, …)'),
      lastRunAt: z.iso.datetime(),
      lastSuccessAt: z.iso.datetime().optional(),
      lastErrorAt: z.iso.datetime().optional(),
      lastError: z.string().optional().describe('Redacted, at most 500 characters'),
    }),
  ),
});

export const releaseList = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(['open', 'published', 'archived']),
      createdAt: z.iso.datetime(),
      publishedAt: z.iso.datetime().optional(),
      itemCount: z.int().describe('Members (entries) in the release, from one grouped count'),
    }),
  ),
});

const workflowTrigger = z.object({
  type: z.string().describe('Trigger node type, e.g. trigger.manual or trigger.entry_published'),
  label: z.string().describe('The node catalog’s name for it, e.g. "Submit for review"'),
});

export const workflowList = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      contentTypes: z.array(z.string()).describe('Content type apiIds; empty covers every type'),
      graph: z
        .object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) })
        .describe('The DRAFT graph (what the editor shows), not necessarily what runs'),
      steps: z.array(z.unknown()).describe('Legacy steps, derived from the graph'),
      gatesPublish: z.boolean(),
      latestVersion: z.int().nullable().describe('Highest published version; null if never'),
      legacy: z.boolean(),
      updatedAt: z.iso.datetime().nullable(),
      publishedTrigger: workflowTrigger
        .nullable()
        .describe('What starts the latest PUBLISHED version; null when never published'),
      startsAlongside: z
        .array(z.string())
        .nullable()
        .describe(
          'Ids of the other published workflows that start on the same trigger for an ' +
            'overlapping content type (each of them starts too; for trigger.manual the editor ' +
            'chooses). Null when never published',
        ),
    }),
  ),
});

export const assetCollection = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().optional(),
  itemCount: z.int().describe('Assets in it, of every status'),
  createdAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

export const assetCollectionPage = z.object({
  items: z.array(assetCollection),
  nextCursor: z.string().optional(),
});

export const collectionAdded = z.object({
  added: z.int().describe('Assets added (members already in it are left where they are)'),
  skipped: z.array(z.string()).describe('Ids that are not assets in this environment'),
});

export const collectionRemoved = z.object({ removed: z.int() });

export const deliveredCollection = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  items: z.array(deliveredAsset).describe('Published members, in the collection’s order'),
  nextCursor: z.string().optional(),
});

export const shareLink = z.object({
  id: z.uuid(),
  targetType: z.enum(['asset', 'collection']),
  targetId: z.string(),
  expiresAt: z.iso.datetime(),
  allowDownload: z.boolean(),
  hasPassword: z.boolean(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  revokedAt: z.iso.datetime().optional(),
  url: z
    .string()
    .optional()
    .describe('The link to hand out, on the media origin (absent without MEDIA_PUBLIC_URL)'),
});

export const shareLinkList = z.object({ items: z.array(shareLink) });

export const multipartUpload = z.object({
  asset,
  upload: z.object({
    uploadId: z.string(),
    partSize: z.int().describe('Every part but the last has exactly this many bytes'),
    partCount: z.int(),
  }),
});

export const signedParts = z.object({
  parts: z.array(
    z.object({
      partNumber: z.int(),
      url: z
        .string()
        .describe('PUT exactly `length` bytes here; the response’s ETag names the part'),
      length: z.int(),
      expiresAt: z.iso.datetime(),
    }),
  ),
});

export const assetZip = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  source: z.union([
    z.object({ kind: z.literal('selection'), assetIds: z.array(z.string()) }),
    z.object({ kind: z.literal('collection'), collectionId: z.string() }),
  ]),
  fileName: z.string(),
  fileCount: z.int().optional(),
  totalBytes: z.int().optional(),
  partsDone: z.int(),
  partCount: z.int().optional(),
  error: z.string().optional(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  completedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime().describe('The archive is removed then'),
  downloadUrl: z
    .string()
    .optional()
    .describe(
      'Once completed: a signed URL that works for 15 minutes (get the job again for another)',
    ),
});

export const assetZipList = z.object({ items: z.array(assetZip) });
