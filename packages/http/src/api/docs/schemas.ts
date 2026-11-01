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

export const asset = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.string().describe('MIME type'),
  status: z.enum(['draft', 'published']).optional(),
  url: z.string().optional(),
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

export const health = z.object({ status: z.literal('ok') });
export const ready = z.object({ status: z.literal('ready'), role: z.string() });

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
