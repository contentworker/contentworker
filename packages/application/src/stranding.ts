import {
  type ContentType,
  canonicalJson,
  type FieldIssue,
  removedFields,
  removedFieldUses,
  removedVariants,
  removedVariantUses,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import {
  describeRemovedInUse,
  type RemovedContentInUse,
  removedContentInUse,
} from './content-types';
import type { AppContext } from './context';

/**
 * What copying content types into an environment would strand there, for the two operations that
 * do it in bulk (a promotion and a merge): the rule `updateContentType` keeps for one revision,
 * with the copies the operation replaces itself left out.
 */
export type CopyingOperation = 'promotion' | 'merge';

/** Entry ids by removed location: `location: variant` for a variant, the location for a field. */
export interface Held {
  readonly variants: Map<string, Set<string>>;
  readonly fields: Map<string, Set<string>>;
}

export const emptyHeld = (): Held => ({ variants: new Map(), fields: new Map() });

function noteHeld(into: Map<string, Set<string>>, at: string, entryId: string): void {
  into.set(at, (into.get(at) ?? new Set<string>()).add(entryId));
}

export function addHeld(held: Held, found: RemovedContentInUse): void {
  for (const v of found.variantsInUse)
    for (const id of v.entries) noteHeld(held.variants, v.variant, id);
  for (const f of found.fieldsInUse) for (const id of f.entries) noteHeld(held.fields, f.field, id);
}

export function toRemovedInUse(held: Held): RemovedContentInUse {
  const sorted = (m: Map<string, Set<string>>) =>
    [...m]
      .filter(([, ids]) => ids.size > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([at, ids]) => [at, [...ids].sort()] as const);
  return {
    variantsInUse: sorted(held.variants).map(([variant, entries]) => ({ variant, entries })),
    fieldsInUse: sorted(held.fields).map(([field, entries]) => ({ field, entries })),
  };
}

/**
 * Refuses (422) copying content types that would strand content in the target: a block variant
 * or a field, at any depth, that a type removes while entries there still hold it (their current
 * version, the trash, or their published snapshot), as revising the type there refuses it
 * (`updateContentType`). There is no override, as there is none there: change or clear those
 * values in the target first, or leave the type out. Judged against the target's working
 * definition and, when a published one replaces it, what the target serves.
 *
 * A copy the operation itself replaces doesn't count (`replacedCopies`), and a copied entry it
 * can't write is named (`trashed`). Like the direct revision, it reads before the saves rather
 * than in one unit with them: an entry written with the removed content in the moment between
 * fails its next save, naming it, rather than losing anything. Letting a copy off trusts the
 * operation to replace it, which is why each writes those entries (`relied`) before any other.
 */
export async function assertNothingStranded(
  ctx: AppContext,
  target: Scope,
  types: readonly ContentType[],
  replaced: ReplacedCopies,
): Promise<void> {
  if (types.length === 0) return;
  const kept = await ctx.store.contentTypes.publishedDefinitions(target);
  const issues: FieldIssue[] = [];
  for (const ct of types) {
    const current = await ctx.store.contentTypes.get(target, ct.apiId);
    if (!current) continue;
    const live = ct.status === 'published' ? kept.get(ct.apiId) : undefined;
    // What the target serves only when it differs from its working definition: the same fields
    // twice would scan the same entries twice for nothing.
    const served =
      live && canonicalJson(live.fields) !== canonicalJson(current.fields) ? live : undefined;
    const befores = served ? [current, { ...current, fields: served.fields }] : [current];
    // Entry ids by `location: variant` and by field location, over both definitions.
    const held = emptyHeld();
    for (const before of befores) addHeld(held, await removedContentInUse(ctx, target, before, ct));
    await replaced.letOff(held, befores, ct);
    const refuse = (what: string, verb: [string, string], at: string, ids: Set<string>) => {
      if (ids.size === 0) return;
      const n = ids.size;
      issues.push({
        field: 'contentTypes',
        message:
          `The content type "${ct.apiId}" can't go to ${target.environmentId}: it removes ${what} ` +
          `${n} ${n === 1 ? `entry there still ${verb[0]}` : `entries there still ${verb[1]}`}: ` +
          `${describeRemovedInUse(at, [...ids].sort())}. Change or clear those values there ` +
          `first, or leave "${ct.apiId}" out of the ${replaced.operation}`,
      });
    };
    for (const [at, ids] of [...held.variants].sort(([a], [b]) => a.localeCompare(b))) {
      refuse('a block variant', ['uses', 'use'], at, ids);
    }
    for (const [at, ids] of [...held.fields].sort(([a], [b]) => a.localeCompare(b))) {
      refuse('a field', ['holds a value for', 'hold a value for'], at, ids);
    }
  }
  issues.push(...(await replaced.trashed()));
  if (issues.length > 0) throw new ValidationError(issues);
}

/** How an operation treats the target's copies of the entries it copies. */
export interface ReplacedCopiesRule {
  readonly operation: CopyingOperation;
  /**
   * Whether it writes over a copy in the target's trash (a merge appends a version there, which
   * stays in the trash) or can't (a promotion refuses to, so that copy counts whole).
   */
  readonly writesTrash: boolean;
  /** Whether the entry goes live, replacing its published snapshot in the target too. */
  readonly goesLive: (entryId: string) => boolean;
}

/**
 * The copies of the target's entries an operation replaces, which a removal it brings doesn't
 * strand: a copied entry's current version (the source's version takes its place) and, when it
 * goes live, its published snapshot. One that stays a draft keeps whatever the target last
 * published of it, so that snapshot is checked on its own. A copy in the target's trash is
 * replaced only by an operation that writes there (`writesTrash`); otherwise it counts whole.
 *
 * Letting a copy off leans on the operation getting as far as the entries: `relied` names them,
 * for it to write first. Where the trash can't be written, `trashed` then refuses a copied entry
 * in the target's trash, which would fail the operation after the types are saved; one there that
 * itself holds what is removed is refused the same way, whatever else is let off: changing its
 * values there can't be done, restoring or purging it can.
 */
export interface ReplacedCopies {
  readonly operation: CopyingOperation;
  /** The copied entries a removal was let off for, which the operation must replace first. */
  relied(): ReadonlySet<string>;
  /** Takes the replaced copies out of `held`, found over `befores` against `after`. */
  letOff(
    held: Held,
    befores: readonly Pick<ContentType, 'fields'>[],
    after: Pick<ContentType, 'fields'>,
  ): Promise<void>;
  /** The copied entries in the target's trash the operation can't write, as issues. */
  trashed(): Promise<FieldIssue[]>;
}

export function replacedCopies(
  ctx: AppContext,
  target: Scope,
  entryIds: readonly string[],
  rule: ReplacedCopiesRule,
): ReplacedCopies {
  const copied = new Set(entryIds);
  const relied = new Set<string>();
  const trashedHolders = new Set<string>();
  return {
    operation: rule.operation,
    relied: () => relied,
    async letOff(held, befores, after) {
      const all = [...held.variants.values(), ...held.fields.values()];
      const holders = [...new Set(all.flatMap((s) => [...s]))].filter((id) => copied.has(id));
      if (holders.length === 0) return;
      const there = await ctx.store.entries.getMany(target, holders);
      const unwritable = (status: string) => status === 'archived' && !rule.writesTrash;
      for (const e of there) if (unwritable(e.entry.status)) trashedHolders.add(e.entry.id);
      const written = there.filter((e) => !unwritable(e.entry.status)).map((e) => e.entry.id);
      if (written.length === 0) return;
      for (const id of written) relied.add(id);
      for (const ids of all) for (const id of written) ids.delete(id);
      // A copied entry that stays a draft keeps whatever the target last published of it.
      const drafts = written.filter((id) => !rule.goesLive(id));
      if (drafts.length === 0) return;
      const snapshots = await ctx.store.entries.getPublishedMany(target, drafts);
      for (const before of befores) {
        const removedV = removedVariants(before.fields, after.fields);
        const removedF = removedFields(before.fields, after.fields);
        for (const s of snapshots) {
          for (const at of removedVariantUses(before.fields, s.fields, removedV)) {
            noteHeld(held.variants, at, s.entryId);
          }
          for (const at of removedFieldUses(before.fields, s.fields, removedF)) {
            noteHeld(held.fields, at, s.entryId);
          }
        }
      }
    },
    async trashed() {
      if (rule.writesTrash) return [];
      // An archived entry takes no new version, so the operation fails on it after the types are
      // saved: every one once a copy was let off, else each that holds what is removed.
      const ids =
        relied.size > 0
          ? (await ctx.store.entries.getMany(target, [...copied]))
              .filter((e) => e.entry.status === 'archived')
              .map((e) => e.entry.id)
          : [...trashedHolders];
      return ids.sort().map((id) => ({
        field: 'entries',
        message: `Entry ${id} is in the trash in ${target.environmentId}, so the ${rule.operation} can't write it. Restore it there or purge it first, or leave it out of the ${rule.operation}`,
      }));
    },
  };
}
