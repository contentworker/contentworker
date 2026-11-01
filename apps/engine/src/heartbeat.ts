import { type AppContext, recordSchedulerTick, SchedulerTick } from '@contentworker/application';
import { redactCredentials } from '@contentworker/redaction';

/** The cron's sweeps, by the name the heartbeat records them under. */
export const CRON_JOBS = {
  prune: 'event-history-prune',
  reseal: 'secrets-reseal',
  scheduledActions: 'scheduled-actions',
  assetExpiry: 'asset-expiry',
  relay: 'outbox-relay',
  bulkResume: 'bulk-resume',
  purgeResume: 'environment-purge-resume',
  versionArchive: 'version-archive',
  agentSchedules: 'agent-schedules',
  abandonedUploads: 'abandoned-uploads',
  abandonedMultipart: 'abandoned-multipart-uploads',
  expiredZips: 'expired-zips',
} as const;

/** A tick's heartbeat, started when the tick starts. */
export const startTick = (ctx: AppContext) => new SchedulerTick(ctx.clock);

/**
 * Runs one sweep and records how it came out. A failure is recorded and handed to `onError`
 * (its log line and metric) and never thrown: one sweep must not skip the rest of the tick, and
 * the outbox relay is the crash backstop for everything else.
 */
export async function sweep(
  tick: SchedulerTick,
  job: string,
  run: () => Promise<unknown>,
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await run();
    tick.ok(job);
  } catch (err) {
    tick.fail(job, err);
    onError(err);
  }
}

/**
 * Writes the tick's heartbeat: one batch, at the end of the tick, whatever its sweeps did. A
 * failed write is logged, not thrown: the sweeps already ran, and the next tick writes again (the
 * api then reads the scheduler stale only if writes keep failing for five minutes).
 */
export async function finishTick(ctx: AppContext, tick: SchedulerTick): Promise<boolean> {
  try {
    await recordSchedulerTick(ctx, tick);
    return true;
  } catch (err) {
    console.error('scheduler heartbeat write failed', redactCredentials(err));
    return false;
  }
}
