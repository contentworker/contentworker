import type { EnvironmentPurgeDueEvent, Scope } from '@contentworker/domain';
import type { BlobStore } from '@contentworker/ports';
import { allAssets } from './assets';
import type { AppContext } from './context';

/**
 * Removing a deleted environment's rows.
 *
 * `deleteEnvironment` takes the environment out of the registry at once, so it stops resolving
 * for reads and writes, and leaves a purge marker. The rows go here, in bounded steps, because D1
 * refuses a single statement that modifies hundreds of thousands of rows: each step deletes at
 * most {@link PURGE_ROWS_PER_TABLE} rows from each environment-scoped table, and one event runs
 * at most {@link PURGE_STEPS_PER_EVENT} steps before handing the rest to another. When a step
 * finds nothing left, the environment's files go and the marker is cleared, which frees its id.
 */

/** Rows per table per step: each DELETE stays small enough for D1 to run as one statement. */
export const PURGE_ROWS_PER_TABLE = 500;
/** Steps per `environment.purge_due` event before it hands on to the next one. */
export const PURGE_STEPS_PER_EVENT = 20;
/** A purge with no step for this long has lost its event; the sweep restarts it. */
export const PURGE_STALE_SECONDS = 300;

export interface PurgeDeps {
  /** Where asset files live; absent, a purge removes rows only. */
  readonly blob?: BlobStore;
}

export type PurgeOutcome = 'finished' | 'continued';

/**
 * Consumer body for one `environment.purge_due` event. Redelivery and a concurrent run are both
 * harmless: each step deletes whatever is still there, and finishing twice clears nothing twice.
 */
export async function runEnvironmentPurge(
  ctx: AppContext,
  deps: PurgeDeps,
  event: EnvironmentPurgeDueEvent,
): Promise<PurgeOutcome> {
  const { spaceId, environmentId } = event.scope;
  // A late or duplicate event for a purge that already finished: the id may name a new
  // environment by now, so do nothing at all (the store's step re-checks this per statement).
  if (!(await isPurging(ctx, event.scope))) return 'finished';
  for (let step = 0; step < PURGE_STEPS_PER_EVENT; step++) {
    const deleted = await ctx.store.spaces.purgeEnvironmentStep(
      spaceId,
      environmentId,
      PURGE_ROWS_PER_TABLE,
      ctx.clock.now(),
    );
    if (deleted === 0) {
      // Files before the marker: if this fails, the purge stays pending and the sweep retries.
      // Checked again first, since a concurrent run of the same purge may have just finished it.
      if (!(await isPurging(ctx, event.scope))) return 'finished';
      if (deps.blob?.deletePrefix) await deleteEnvironmentFiles(ctx, deps.blob, event.scope);
      await ctx.store.spaces.finishEnvironmentPurge(spaceId, environmentId);
      return 'finished';
    }
  }
  await ctx.store.outbox.append(purgeDue(ctx, event.scope));
  return 'continued';
}

/** Whether `scope` names a deleted environment whose rows are still being removed. */
export async function isPurging(ctx: AppContext, scope: Scope): Promise<boolean> {
  return (await ctx.store.spaces.resolveName(scope.spaceId, scope.environmentId)).purging;
}

/** The event that runs a purge's next steps. */
export function purgeDue(ctx: AppContext, scope: Scope): EnvironmentPurgeDueEvent {
  return {
    id: ctx.ids.newId(),
    type: 'environment.purge_due',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
  };
}

/**
 * Crash-recovery sweep (cron): restarts purges that made no progress for
 * {@link PURGE_STALE_SECONDS}, because their event was lost. Normally finds nothing.
 */
export async function resumeStalledEnvironmentPurges(
  ctx: AppContext,
  opts: { limit?: number } = {},
): Promise<number> {
  const now = ctx.clock.now();
  const stalled = await ctx.store.spaces.claimStalledPurges(
    new Date(now.getTime() - PURGE_STALE_SECONDS * 1000),
    now,
    opts.limit ?? 50,
  );
  if (stalled.length > 0) {
    await ctx.store.outbox.appendMany(stalled.map((scope) => purgeDue(ctx, scope)));
  }
  return stalled.length;
}

/**
 * Deletes a removed environment's asset files, except any another environment's asset records
 * still point at: an environment import keeps asset ids and their files, so a clone shares its
 * source's files. Keys are `${space}/${environment}/${assetId}/${fileName}` (assetObjectKey).
 */
async function deleteEnvironmentFiles(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
): Promise<void> {
  const inUse = new Set<string>();
  for (const env of await ctx.store.spaces.listEnvironments(scope.spaceId)) {
    if (env.id === scope.environmentId) continue;
    const other = { spaceId: scope.spaceId, environmentId: env.id };
    for (const asset of await allAssets(ctx, other)) inUse.add(asset.id);
  }
  await blob.deletePrefix?.(`${scope.spaceId}/${scope.environmentId}/`, (key) =>
    inUse.has(key.split('/')[2] ?? ''),
  );
  // Work staged for jobs in it (an import still running when it was deleted): never read now.
  await blob.deletePrefix?.(`imports/${scope.spaceId}/${scope.environmentId}/`, () => false);
  // Its archived version bodies (version-archive.ts).
  await blob.deletePrefix?.(`versions/${scope.spaceId}/${scope.environmentId}/`, () => false);
}
