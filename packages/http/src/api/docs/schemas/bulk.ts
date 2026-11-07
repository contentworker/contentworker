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
      fields: z.record(z.string(), z.record(z.string(), z.unknown())),
    })
    .describe('The type and the values the job sets'),
});
