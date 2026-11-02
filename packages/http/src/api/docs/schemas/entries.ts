import { z } from 'zod';

export const localizedValue = z
  .record(z.string().describe('BCP-47 locale tag'), z.unknown())
  .describe('Localized value: locale → value (non-localized fields use the default locale)');

export const entryFields = z
  .record(z.string().describe('Field apiId'), localizedValue)
  .describe('Entry field values by field apiId');

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
