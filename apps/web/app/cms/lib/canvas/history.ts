/**
 * The canvas editor's undo history, as block-patch ops: every edit is applied with the domain's
 * `applyBlockPatch` and kept with its inverse (`invertBlockPatch` of the applied ops), so undo
 * applies the inverse and redo the applied ops again, each carrying every key, so a block comes
 * back under the key it had and the page re-renders the same block. Edits to one prop within
 * `BURST_MS` of each other (typing) are one step. Pure: the screen holds the result.
 */
import {
  applyBlockPatch,
  type BlockOp,
  type BlockPatchIssue,
  type ContentType,
  type EntryFields,
  invertBlockPatch,
} from '@contentworker/domain';

export const BURST_MS = 400;
export const HISTORY_LIMIT = 100;

export interface CanvasStep {
  /** The ops as they applied: every key present, positions resolved. */
  readonly ops: readonly BlockOp[];
  /** The ops that undo them, applied to the fields they produced. */
  readonly inverse: readonly BlockOp[];
  /** What it did, for the live region and the toast ("Removed Hero"). */
  readonly label: string;
  /** Steps with the same burst key in quick succession merge (one prop being typed). */
  readonly burst?: string;
  readonly at: number;
}

export interface CanvasHistory {
  readonly past: readonly CanvasStep[];
  readonly future: readonly CanvasStep[];
}

export const EMPTY_HISTORY: CanvasHistory = { past: [], future: [] };

export type Applied =
  | { readonly ok: true; readonly fields: EntryFields; readonly step: CanvasStep }
  | { readonly ok: false; readonly issues: readonly BlockPatchIssue[] };

/** Applies `ops` to `fields`, with the step that records them (and undoes them). */
export function applyOps(
  contentType: ContentType,
  fields: EntryFields,
  ops: readonly BlockOp[],
  newKey: () => string,
  meta: { readonly label: string; readonly burst?: string; readonly at: number },
): Applied {
  const result = applyBlockPatch(contentType, fields, ops, newKey);
  if (!result.ok) return result;
  const inverse = invertBlockPatch(contentType, fields, result.applied);
  if (!inverse.ok) return inverse;
  return {
    ok: true,
    fields: result.fields,
    step: { ops: result.applied, inverse: inverse.ops, ...meta },
  };
}

/** The history with `step` done: a burst merges into the step before it; redo is forgotten. */
export function record(history: CanvasHistory, step: CanvasStep): CanvasHistory {
  const last = history.past.at(-1);
  if (
    last &&
    step.burst !== undefined &&
    last.burst === step.burst &&
    step.at - last.at <= BURST_MS
  ) {
    const merged: CanvasStep = {
      ...last,
      ops: [...last.ops, ...step.ops],
      inverse: [...step.inverse, ...last.inverse],
      at: step.at,
    };
    return { past: [...history.past.slice(0, -1), merged], future: [] };
  }
  return { past: [...history.past, step].slice(-HISTORY_LIMIT), future: [] };
}

export type Travelled =
  | {
      readonly ok: true;
      readonly fields: EntryFields;
      readonly history: CanvasHistory;
      readonly step: CanvasStep;
    }
  | { readonly ok: false };

/** Takes back the last step: its inverse, applied to `fields`. */
export function undo(
  contentType: ContentType,
  fields: EntryFields,
  history: CanvasHistory,
): Travelled {
  const step = history.past.at(-1);
  if (!step) return { ok: false };
  const result = replay(contentType, fields, step.inverse);
  if (!result) return { ok: false };
  return {
    ok: true,
    fields: result,
    step,
    history: { past: history.past.slice(0, -1), future: [...history.future, step] },
  };
}

/** Does the last undone step again. */
export function redo(
  contentType: ContentType,
  fields: EntryFields,
  history: CanvasHistory,
): Travelled {
  const step = history.future.at(-1);
  if (!step) return { ok: false };
  const result = replay(contentType, fields, step.ops);
  if (!result) return { ok: false };
  return {
    ok: true,
    fields: result,
    step,
    history: { past: [...history.past, step], future: history.future.slice(0, -1) },
  };
}

/** Applies ops that carry every key: they never mint one, so nothing new is made up. */
function replay(contentType: ContentType, fields: EntryFields, ops: readonly BlockOp[]) {
  if (ops.length === 0) return fields;
  const result = applyBlockPatch(contentType, fields, ops, () => {
    throw new Error('A recorded op carries every key');
  });
  return result.ok ? result.fields : undefined;
}
