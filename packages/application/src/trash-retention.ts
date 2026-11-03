import {
  authorize,
  DomainError,
  NotFoundError,
  type Principal,
  SCOPES,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { BlobStore } from '@contentworker/ports';
import type { AppContext } from './context';
import { purgeEntry } from './entries';

/**
 * Trash retention: a space may say how many days its trashed entries are kept, and the engine's
 * hourly sweep (`sweepExpiredTrash`) deletes the older ones permanently through `purgeEntry`, the
 * use-case "Delete permanently" calls. Off by default: a space that never sets it keeps its trash
 * until someone empties it, so turning this on is the only way existing data is ever swept.
 */

/** The longest retention a space can set: ten years. */
export const MAX_TRASH_RETENTION_DAYS = 3650;

/** Entries one sweep purges at most, across every space and environment. */
export const TRASH_SWEEP_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The space's trash settings: `retentionDays` null is off (trashed entries are kept). */
export interface TrashSettings {
  readonly retentionDays: number | null;
}

export async function getTrashSettings(ctx: AppContext, scope: Scope): Promise<TrashSettings> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { retentionDays: config.trashRetentionDays ?? null };
}

/**
 * Sets how many days the space keeps trashed entries (1 to {@link MAX_TRASH_RETENTION_DAYS}), or
 * null to turn retention off. It applies to every environment of the space, and to what is already
 * in the trash: an entry trashed longer ago than the new window goes on the next sweep. Needs
 * `space:admin`.
 */
export async function setTrashRetention(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  retentionDays: number | null,
): Promise<TrashSettings> {
  authorize(principal, SCOPES.spaceAdmin, scope.spaceId);
  if (
    retentionDays !== null &&
    (!Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > MAX_TRASH_RETENTION_DAYS)
  ) {
    throw new ValidationError([
      {
        field: 'retentionDays',
        message: `A whole number of days from 1 to ${MAX_TRASH_RETENTION_DAYS}, or null for off`,
      },
    ]);
  }
  if (!(await ctx.store.spaces.getConfig(scope))) throw new NotFoundError('Space', scope.spaceId);
  await ctx.store.spaces.setTrashRetentionDays(scope.spaceId, retentionDays);
  return { retentionDays };
}

export interface TrashSweepResult {
  readonly purged: number;
  /** Entries a rule refused (a plugin's veto, a link published since the read), kept for now. */
  readonly refused: number;
}

/**
 * The retention sweep: in every space with retention on, purges the entries each environment has
 * held in the trash longer than the space's window, through `purgeEntry`, so a sweep deletes only
 * what a person pressing "Delete permanently" could: an entry still in the trash, with no
 * published entry linking to it (never forced; linked ones are left out of the read and stay).
 *
 * Bounded: at most `limit` purges a run, each its own small unit of work, one after another (the
 * database has one writer), shared out between the environments due so one large trash can't
 * starve the rest. Idempotent: an entry restored or purged by someone else since the read is
 * refused by `purgeEntry` and left alone, and the next run starts from what is left.
 */
export async function sweepExpiredTrash(
  ctx: AppContext,
  opts: { readonly blob?: BlobStore; readonly limit?: number } = {},
): Promise<TrashSweepResult> {
  const now = ctx.clock.now().getTime();
  const due: { scope: Scope; before: Date }[] = [];
  for (const space of await ctx.store.spaces.list()) {
    if (!space.trashRetentionDays) continue;
    const before = new Date(now - space.trashRetentionDays * DAY_MS);
    for (const env of await ctx.store.spaces.listEnvironments(space.spaceId)) {
      due.push({ scope: { spaceId: space.spaceId, environmentId: env.id }, before });
    }
  }
  if (due.length === 0) return { purged: 0, refused: 0 };

  let budget = opts.limit ?? TRASH_SWEEP_LIMIT;
  const share = Math.max(1, Math.ceil(budget / due.length));
  let purged = 0;
  let refused = 0;
  for (const { scope, before } of due) {
    if (budget <= 0) break;
    const ids = await ctx.store.entries.listExpiredTrash(scope, before, Math.min(share, budget));
    budget -= ids.length;
    for (const id of ids) {
      try {
        await purgeEntry(ctx, scope, id, opts.blob ? { blob: opts.blob } : {});
        purged++;
      } catch (err) {
        // A rule said no (a plugin veto, an entry restored or relinked since the read, a lost
        // race): the entry stays, and is tried again next run. Anything else is the database's.
        if (!(err instanceof DomainError)) throw err;
        refused++;
      }
    }
  }
  return { purged, refused };
}
