import { z } from 'zod';

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
