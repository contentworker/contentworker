import { ApiError } from './management';

/**
 * A draft save refused because someone saved the entry after it was read (409, from
 * `expectedVersion`): the version it is at now, when the refusal says. Undefined for any other
 * error. The api names it in the 409's `details.currentVersion`; through Coworker the same refusal
 * arrives as the use-case's words ("… is at version 5, not 3 …"), which are read for the number.
 */
export function staleSave(err: unknown): { readonly theirs: number | null } | undefined {
  if (err instanceof ApiError) {
    if (err.status !== 409) return undefined;
    const details = (err.body as { error?: { details?: { currentVersion?: unknown } } } | undefined)
      ?.error?.details;
    // A 409 that isn't about the version (a unique value taken) is some other refusal.
    if (details && typeof details.currentVersion === 'number') {
      return { theirs: details.currentVersion };
    }
  }
  if (!(err instanceof Error)) return undefined;
  const m = /is at version (\d+), not \d+: it changed after it was read/.exec(err.message);
  if (m) return { theirs: Number(m[1]) };
  // The version's words without its number: still a newer save, at a version to read again.
  return /changed after it was read/.test(err.message) ? { theirs: null } : undefined;
}
