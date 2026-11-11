import { ConflictError, type FieldIssue, ValidationError } from '@contentworker/domain';
import type { UniqueConflict } from '@contentworker/ports';

/**
 * Refusals as a caller whose role denies some fields (`deniedFieldsFor`) may see them. A save keeps
 * the stored values of those fields and judges the whole entry, so one of them can still fail a
 * rule or hold a unique value another entry took; the refusal counts them and never names them.
 */

/**
 * The issue a save's refusal makes of fields the caller can't read: counted, never named. A stored
 * value it may not see can still fail a rule (a required field left empty by someone else), and
 * its path and message would say what it holds.
 */
export interface HiddenFieldsIssue extends FieldIssue {
  readonly code: 'hidden';
  readonly hidden: number;
}

/**
 * A refusal as the caller may see it, without the fields it can't read (by top-level field):
 * field issues in them fold into one issue that counts the fields, and a unique value one of them
 * holds that another entry already uses is counted, without the field, the value or the other
 * entry. Any other error passes through as it is.
 */
export function hideUnreadableIssues(err: unknown, unreadable: readonly string[] = []): unknown {
  if (unreadable.length === 0) return err;
  if (err instanceof ConflictError) return hideUnreadableConflicts(err, unreadable);
  if (!(err instanceof ValidationError)) return err;
  const hidden = new Set<string>();
  const shown = err.issues.filter((issue) => {
    const top = /^[A-Za-z]\w*/.exec(issue.field)?.[0] ?? '';
    if (!unreadable.includes(top)) return true;
    hidden.add(top);
    return false;
  });
  if (hidden.size === 0) return err;
  const n = hidden.size;
  const counted: HiddenFieldsIssue = {
    field: '',
    code: 'hidden',
    hidden: n,
    message: `${n} ${n === 1 ? 'field' : 'fields'} you can’t read ${n === 1 ? 'isn’t' : 'aren’t'} valid; someone who can read ${n === 1 ? 'it' : 'them'} has to fix ${n === 1 ? 'it' : 'them'} first`,
  };
  return new ValidationError([...shown, counted]);
}

/** `assertClaimsFree`'s refusal without the conflicts in fields the caller can't read. */
function hideUnreadableConflicts(err: ConflictError, unreadable: readonly string[]): ConflictError {
  const conflicts = (err.details as { conflicts?: readonly UniqueConflict[] } | undefined)
    ?.conflicts;
  if (!Array.isArray(conflicts)) return err;
  const shown = conflicts.filter((c) => !unreadable.includes(c.fieldApiId));
  if (shown.length === conflicts.length) return err;
  const n = new Set(
    conflicts.filter((c) => unreadable.includes(c.fieldApiId)).map((c) => c.fieldApiId),
  ).size;
  const counted =
    `${n === 1 ? 'A value' : 'Values'} in ${n} ${n === 1 ? 'field' : 'fields'} you can’t read ` +
    `${n === 1 ? 'is' : 'are'} already used by another entry; someone who can read ` +
    `${n === 1 ? 'it' : 'them'} has to change ${n === 1 ? 'it' : 'them'} first`;
  return new ConflictError([...shown.map(uniqueValueTaken), counted].join('; '), {
    conflicts: shown,
    hidden: n,
  });
}

/** `run`, with its refusal's issues in fields the caller can't read counted rather than named. */
export async function hidingUnreadable<T>(
  unreadable: readonly string[] | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw hideUnreadableIssues(err, unreadable);
  }
}

/** How a refusal names a unique value another entry holds (`assertClaimsFree`). */
export const uniqueValueTaken = (c: UniqueConflict) =>
  `${c.fieldApiId} "${c.value}" is already used by entry ${c.entryId}`;
