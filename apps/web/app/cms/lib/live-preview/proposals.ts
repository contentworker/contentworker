/**
 * Coworker's proposal as the page shows it: ghost blocks over the entry's state, named by `_key`
 * (docs/specs/live-preview-channel.md, `view.ghosts`). The ops are the dry run's applied ops, so
 * every block they bring carries its key; the page can show inserts, updates, moves and removes,
 * and nothing that would mint a key on its side (a duplicate) or set a whole field.
 */
import { parseContentRef, parseFieldPath } from '@contentworker/sdk-core';
import type { LivePatchOp } from '@contentworker/sdk-core/live-preview';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What each ghost is: a block it brings, one it changes or moves, or one it takes away. */
export type GhostKind = 'inserted' | 'changed' | 'removed';

/**
 * The ops, when the page can show every one of them as a ghost; null otherwise (the proposal is
 * then shown in Coworker's card alone).
 */
export function ghostOps(ops: readonly unknown[]): LivePatchOp[] | null {
  if (ops.length === 0) return null;
  const out: LivePatchOp[] = [];
  for (const op of ops) {
    if (!isRecord(op) || typeof op.field !== 'string' || typeof op.locale !== 'string') return null;
    if (op.op === 'insert') {
      if (!isRecord(op.block) || !keyed(op.block)) return null;
    } else if (op.op !== 'update' && op.op !== 'move' && op.op !== 'remove') return null;
    else if (typeof op.key !== 'string') return null;
    out.push(op as unknown as LivePatchOp);
  }
  return out;
}

/** A block with a `_key`, and every block anywhere inside it keyed too. */
function keyed(block: Record<string, unknown>): boolean {
  if (typeof block._key !== 'string' || block._key === '') return false;
  return Object.entries(block).every(([name, value]) => name === '_key' || nestedKeyed(value));
}

function nestedKeyed(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(nestedKeyed);
  if (!isRecord(value)) return true;
  if (typeof value._type === 'string' && value._type !== '') return keyed(value);
  return Object.values(value).every(nestedKeyed);
}

/** The blocks a proposal names, by key, with what it does to each (the first op that names it). */
export function ghostKeys(ops: readonly LivePatchOp[]): Map<string, GhostKind> {
  const out = new Map<string, GhostKind>();
  for (const op of ops) {
    const key =
      op.op === 'insert'
        ? (op.block._key as string | undefined)
        : 'key' in op && typeof op.key === 'string'
          ? op.key
          : undefined;
    if (key === undefined || out.has(key)) continue;
    out.set(key, op.op === 'insert' ? 'inserted' : op.op === 'remove' ? 'removed' : 'changed');
  }
  return out;
}

/** The key of the block a ref names (its path's last key), when it names one of `entryId`'s. */
export function refBlockKey(ref: string, entryId: string): string | undefined {
  const parsed = parseContentRef(ref);
  if (!parsed || parsed.entryId !== entryId) return undefined;
  const path = parseFieldPath(parsed.field);
  const steps = path?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step && 'key' in step) return step.key;
  }
  return undefined;
}

/** "Proposed", "Proposed change", "Proposed removal": what a ghost's label says, in words. */
export const ghostLabel = (kind: GhostKind) =>
  kind === 'inserted' ? 'Proposed' : kind === 'removed' ? 'Proposed removal' : 'Proposed change';
