import {
  authorizeContent,
  type BlockLock,
  blockLocksFor,
  ConflictError,
  checkBlockLocks,
  diffBlockLocks,
  NotFoundError,
  type Principal,
  principalActorId,
  type Scope,
  sameBlockLocks,
  staleBlockLocks,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import type { AppContext } from './context';
import { assertExpectedVersion } from './publishing';

/**
 * Locked regions (see `@contentworker/domain`'s block-locks module): part of one entry's blocks
 * editors can't restructure. Locks are entry state, not content: setting them is its own write,
 * guarded like an entry write, that makes no version (so a restore never brings old locks back).
 * Locking and unlocking both take the `lock` content action on the entry's type, whoever locked;
 * reading them takes what reading the entry does, checked by the surfaces.
 *
 * Every save of the entry is held to them (`assertBlockConfigAllows`, from the save path in
 * `entries.ts`), so the editor, the API, MCP, imports, block patches and AI meet the same refusals.
 */

/** An entry's locks, and which of them no locale holds any more. */
export interface EntryBlockLocks {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  /** The entry's `currentVersion`: what a set sends back as `expectedVersion`. */
  readonly version: number;
  readonly locks: readonly BlockLock[];
  /** The locks whose blocks are gone: shown as stale, never blocking a save. */
  readonly stale: readonly BlockLock[];
}

async function read(ctx: AppContext, scope: Scope, id: string) {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const contentType = await ctx.store.contentTypes.get(scope, found.entry.contentTypeApiId);
  if (!contentType) throw new NotFoundError('ContentType', found.entry.contentTypeApiId);
  return { ...found, contentType };
}

const view = (
  entryId: string,
  contentTypeApiId: string,
  version: number,
  locks: readonly BlockLock[],
  stale: readonly BlockLock[],
): EntryBlockLocks => ({ entryId, contentTypeApiId, version, locks, stale });

/**
 * The entry's locks, the stale ones named: those `principal` may read (`blockLocksFor`: none on a
 * field it can't read, and no `lockedBy` for a reader that doesn't see who wrote what). Refused
 * with 403 without `read` on the entry's type. A read: writes nothing.
 */
export async function getEntryBlockLocks(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  id: string,
): Promise<EntryBlockLocks> {
  const { entry, fields, contentType } = await read(ctx, scope, id);
  authorizeContent(principal, 'read', entry.contentTypeApiId);
  const locks = entry.blockLocks ?? [];
  const readable = (l: readonly BlockLock[]) =>
    blockLocksFor(principal, entry.contentTypeApiId, l) as readonly BlockLock[];
  return view(
    entry.id,
    entry.contentTypeApiId,
    entry.currentVersion,
    readable(locks),
    readable(staleBlockLocks(contentType, fields, locks)),
  );
}

export interface SetEntryBlockLocksInput {
  /** The whole new list: a lock left out is unlocked. Checked here, whatever sent it. */
  readonly locks: unknown;
  /** The `currentVersion` the locks were chosen from: another is a conflict, as for an edit. */
  readonly expectedVersion?: number;
}

export interface EntryBlockLocksSet extends EntryBlockLocks {
  /** The entry already held exactly these locks: nothing written. */
  readonly unchanged: boolean;
}

/**
 * Replaces the entry's locks with `input.locks` (`checkBlockLocks`: keys its fields hold as a run,
 * no block in two regions), stamping each new lock with the principal and the clock; a lock it
 * already holds keeps its stamp. Sending the locks it holds writes nothing. Makes no version.
 *
 * Refused with 403 (`content:lock:<type>`) without the `lock` action on the entry's type; 409 when
 * the entry is not at `expectedVersion`, or a save or another lock set commits first; 422 naming
 * each lock that isn't one, names keys no locale holds as a run, or overlaps another.
 */
export async function setEntryBlockLocks(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  id: string,
  input: SetEntryBlockLocksInput,
): Promise<EntryBlockLocksSet> {
  const { entry, fields, contentType } = await read(ctx, scope, id);
  authorizeContent(principal, 'lock', entry.contentTypeApiId);
  assertExpectedVersion(entry, input);
  const current = entry.blockLocks ?? [];
  const locks = checkBlockLocks(contentType, fields, input.locks, current, {
    by: principalActorId(principal),
    at: ctx.clock.now().toISOString(),
  });
  const result = (unchanged: boolean): EntryBlockLocksSet => ({
    ...view(
      entry.id,
      entry.contentTypeApiId,
      entry.currentVersion,
      locks,
      staleBlockLocks(contentType, fields, locks),
    ),
    unchanged,
  });
  if (sameBlockLocks(current, locks)) return result(true);
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.entries.setBlockLocks(scope, entry.id, locks, {
        currentVersion: entry.currentVersion,
        locks: current,
      });
    });
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    throw new ConflictError(
      `Entry "${entry.id}" changed while its locks were being set: read it again`,
      { currentVersion: entry.currentVersion },
    );
  }
  // Committed: the audit row says what was locked and unlocked.
  ctx.changes?.noteBlockLocks(diffBlockLocks(entry.id, current, locks));
  return result(false);
}
