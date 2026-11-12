import { z } from 'zod';

/** A bulk field edit job as it starts (follow it at GET /bulk/jobs/{id}). */
export const setFieldsJob = z.looseObject({
  id: z.string(),
  action: z.literal('set_fields'),
  status: z.enum(['running', 'completed', 'cancelled']),
  totalItems: z.int(),
  totalChunks: z.int(),
  completedChunks: z.int(),
  succeeded: z.int(),
  failed: z.int(),
  config: z
    .looseObject({
      contentTypeApiId: z.string(),
      fieldNames: z
        .array(z.string())
        .describe('The fields it sets; their values are not read back'),
    })
    .describe('The type and the fields the job sets'),
});

/** An environment's search reindex job (`GET …/search/reindex-job`), or null when none has run. */
export const searchReindexJob = z.object({
  job: z
    .looseObject({
      id: z.string(),
      action: z.literal('search_reindex'),
      status: z.enum(['running', 'completed', 'cancelled']),
      totalItems: z.int().describe('Published entries and assets it covers'),
      totalChunks: z.int(),
      completedChunks: z.int(),
      succeeded: z.int(),
      failed: z.int(),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().optional(),
      config: z
        .looseObject({
          enabled: z.boolean().describe('Whether search was turned on (embed) or off (delete)'),
          settingsVersion: z.int().describe('The AI settings version that turned it'),
          actor: z.string().optional().describe('Who turned it'),
        })
        .optional(),
    })
    .nullable()
    .describe(
      'The latest search reindex in this environment, running or not; null before search was ' +
        'first turned on or off. Cancelled: a later toggle superseded it',
    ),
});
