import { z } from 'zod';

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
