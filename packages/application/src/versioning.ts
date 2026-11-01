import { type EntryVersion, NotFoundError, type Scope } from '@contentworker/domain';
import type { AppContext } from './context.js';
import { type EntryView, updateEntry } from './entries.js';
import { assertExpectedVersion, type ExpectedVersion } from './publishing.js';

/** Lists every saved version of an entry, newest first. */
export async function listVersions(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<EntryVersion[]> {
  if (!(await ctx.store.entries.get(scope, entryId))) throw new NotFoundError('Entry', entryId);
  return ctx.store.entries.listVersions(scope, entryId);
}

/** Reads one specific version snapshot. */
export async function getVersion(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  version: number,
): Promise<EntryVersion> {
  const found = await ctx.store.entries.getVersion(scope, entryId, version);
  if (!found) throw new NotFoundError('EntryVersion', `${entryId}@${version}`);
  return found;
}

export type FieldChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** A single field's difference between two versions (localized values compared whole). */
export interface FieldChange {
  readonly field: string;
  readonly kind: FieldChangeKind;
  readonly before: unknown;
  readonly after: unknown;
}

export interface VersionDiff {
  readonly entryId: string;
  readonly from: number;
  readonly to: number;
  readonly changes: readonly FieldChange[];
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Diffs two versions of an entry field-by-field. `from` is the baseline and
 * `to` the comparand, so `kind` reads as the change applied going from→to.
 */
export async function diffVersions(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  from: number,
  to: number,
): Promise<VersionDiff> {
  const [a, b] = await Promise.all([
    getVersion(ctx, scope, entryId, from),
    getVersion(ctx, scope, entryId, to),
  ]);
  const fields = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  const changes: FieldChange[] = [];
  for (const field of fields) {
    const before = a.fields[field];
    const after = b.fields[field];
    let kind: FieldChangeKind;
    if (before === undefined) kind = 'added';
    else if (after === undefined) kind = 'removed';
    else kind = eq(before, after) ? 'unchanged' : 'changed';
    changes.push({ field, kind, before, after });
  }
  return { entryId, from, to, changes };
}

/**
 * Restores an older version by copying its fields into a NEW draft version
 * (history is append-only — nothing is rewritten). Validates the restored
 * fields against the current content type, so a restore can't reintroduce a
 * value the model no longer accepts. With `expectedVersion`, refused (409) when the entry has
 * moved past the version the caller saw.
 */
export async function restoreVersion(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  version: number,
  opts: ExpectedVersion = {},
): Promise<EntryView> {
  if (opts.expectedVersion !== undefined) {
    const found = await ctx.store.entries.get(scope, entryId);
    if (!found) throw new NotFoundError('Entry', entryId);
    assertExpectedVersion(found.entry, opts);
  }
  const target = await getVersion(ctx, scope, entryId, version);
  return updateEntry(ctx, scope, entryId, target.fields);
}
