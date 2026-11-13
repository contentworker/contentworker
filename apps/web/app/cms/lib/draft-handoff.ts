import type { EntryFields } from '@contentworker/domain';

/**
 * The entry form and the canvas are two views of one draft. Going from one to the other hands the
 * unsaved fields across, so switching views never asks to discard anything: the view left puts its
 * draft here as it goes, and the view opened takes it in as its own unsaved edits.
 *
 * Held in memory, for one switch: a reload starts from the saved entry (and the view being left
 * still warns before the page unloads). The draft carries the version it was made over, and the
 * view taking it in keeps that version as the one its save is held to, so a save someone made in
 * between still asks rather than being overwritten unseen.
 */
export interface HandedDraft {
  /** `space/environment/entryId`: a draft is only ever taken in by its own entry. */
  readonly id: string;
  /** The version the draft was made over: the one its save is held to. */
  readonly version: number;
  /** The top-level fields the view leaving had changed (`changedFields`), as it held them. */
  readonly fields: EntryFields;
  readonly at: number;
}

/** A draft not taken in within this long was for a switch that never happened. */
const FRESH_MS = 30_000;

let held: HandedDraft | null = null;

export const draftId = (space: string, environment: string, entryId: string) =>
  `${space}/${environment}/${entryId}`;

/** Leaves the draft for the entry's other view, replacing any left before. */
export function handOffDraft(id: string, version: number, fields: EntryFields, at = Date.now()) {
  held = { id, version, fields, at };
}

/**
 * The draft left for this entry, if one is waiting. A read, not a take, so a render that runs
 * twice reads the same draft; the view that keeps it calls `settleDraft` once it has.
 */
export function peekDraft(id: string, now = Date.now()): HandedDraft | null {
  if (!held || held.id !== id) return null;
  if (now - held.at > FRESH_MS) {
    held = null;
    return null;
  }
  return held;
}

/** The draft was taken in: it is not offered again. */
export function settleDraft(draft: HandedDraft) {
  if (held === draft) held = null;
}

/** For tests: nothing waiting. */
export function clearHandedDraft() {
  held = null;
}

/** `/content/:type/:entry` and `/content/:type/:entry/canvas`: the same entry, the other view. */
export function isOtherView(from: string, to: string): boolean {
  if (from === to) return false;
  const entryOf = (p: string) => p.replace(/\/+$/, '').replace(/\/canvas$/, '');
  return entryOf(from) === entryOf(to) && /^\/content\/[^/]+\/[^/]+$/.test(entryOf(from));
}

/** The top-level fields whose value differs from `base`: what a view has changed. */
export function changedFields(fields: EntryFields, base: EntryFields): EntryFields {
  const out: Record<string, unknown> = {};
  for (const [apiId, value] of Object.entries(fields)) {
    if (JSON.stringify(value) !== JSON.stringify(base[apiId])) out[apiId] = value;
  }
  return out as EntryFields;
}
