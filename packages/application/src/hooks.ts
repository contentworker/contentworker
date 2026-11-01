import { HookRejectedError, type Scope, ValidationError } from '@contentworker/domain';
import type { HookName } from '@contentworker/ports';
import type { AppContext } from './context.js';

/**
 * The use-case side of the hook seam.
 *
 * Call sites get one line and no branching, and the rules that matter live here
 * rather than being restated (and eventually diverging) at five different
 * points on the write path:
 *
 * - No dispatcher configured means no cost at all — not an empty dispatch.
 * - A veto raises, so a caller can never accidentally continue past a refusal
 *   by forgetting to check a return value.
 * - A veto carrying field issues becomes a ValidationError, so a hook's
 *   complaint about a field reaches the editor exactly like a built-in one.
 *   Everything else becomes a HookRejectedError naming the hook, so an editor
 *   can tell "the CMS rejected this" from "your integration rejected this".
 */
export async function runHook<T>(
  ctx: AppContext,
  hook: HookName,
  scope: Scope,
  payload: T,
): Promise<T> {
  if (!ctx.hooks) return payload;

  const result = await ctx.hooks.dispatch(hook, payload, scope);
  if ('veto' in result) {
    const { veto } = result;
    if (veto.issues?.length) {
      throw new ValidationError(veto.issues);
    }
    throw new HookRejectedError(veto.hook, veto.reason);
  }
  return result.payload;
}
