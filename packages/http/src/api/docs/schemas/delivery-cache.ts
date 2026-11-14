import { z } from 'zod';

// --- delivery cache -------------------------------------------------------------

export const deliveryRefresh = z
  .object({
    enqueued: z.literal(true),
    environmentId: z
      .string()
      .describe('The environment refreshed (an alias resolves to the one it points at)'),
  })
  .describe('Accepted: the refresh runs on the queues');
