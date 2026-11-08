import { ApiError } from './management';

/**
 * A draft save refused because someone saved the entry after it was read (409, from
 * `expectedVersion`): the version it is at now. Undefined for any other error. The api names it
 * in the 409's `details.currentVersion`; through Coworker the refusal arrives as the MCP tool's
 * error text, which is that same 409 body as JSON.
 */
export function staleSave(err: unknown): { readonly theirs: number } | undefined {
  if (err instanceof ApiError) return err.status === 409 ? versionOf(err.body) : undefined;
  if (!(err instanceof Error)) return undefined;
  return versionOf(bodyOf(err.message));
}

/** The version a 409 body names; a conflict that names none (a unique value taken) is another. */
function versionOf(body: unknown): { readonly theirs: number } | undefined {
  const error = (body as { error?: { code?: unknown; details?: { currentVersion?: unknown } } })
    ?.error;
  const now = error?.code === 'conflict' ? error.details?.currentVersion : undefined;
  return typeof now === 'number' ? { theirs: now } : undefined;
}

/** A tool error's text as the JSON body it holds, or undefined when it is words. */
function bodyOf(text: string): unknown {
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
