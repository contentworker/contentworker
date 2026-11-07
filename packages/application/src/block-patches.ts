import {
  applyBlockPatch,
  type BlockOp,
  type BlockOutline,
  type BlockPatchIssue,
  ForbiddenError,
  invertBlockPatch,
  type LocaleCode,
  NotFoundError,
  outlineBlocks,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { AppContext } from './context';
import { type EntryView, getEntry, saveEntryDraft } from './entries';
import { assertExpectedVersion } from './publishing';

/**
 * Key-addressed edits to an entry's blocks fields (`block-patch.ts` in the domain), saved as a new
 * draft version through the same save a whole-entry edit makes (`saveEntryDraft`): validated,
 * hooked, versioned and noted for the audit trail as `updateEntry` is. One patch is one save, so
 * either every op lands or none does.
 */

/** The most ops one patch carries. */
export const BLOCK_PATCH_MAX_OPS = 100;
/** The largest `ops` one patch carries, serialized: as large as a bulk field edit's values. */
export const BLOCK_PATCH_MAX_BYTES = 64 * 1024;

/** An op as a caller sends it: the locale may be left out, for the space's default. */
export type BlockOpInput = BlockOp extends infer O
  ? O extends BlockOp
    ? Omit<O, 'locale'> & { readonly locale?: LocaleCode }
    : never
  : never;

export interface PatchEntryBlocksInput {
  /** The `currentVersion` the caller read: a patch addresses blocks it saw, so it is required. */
  readonly expectedVersion: number;
  readonly ops: readonly BlockOpInput[];
}

export interface PatchEntryBlocksOptions {
  /**
   * Top-level fields the caller's role denies or makes read-only (`unwritableFieldsFor`): an op
   * on one of them is refused, as sending it in a whole-entry save is.
   */
  readonly unwritable?: readonly string[];
}

export interface BlockPatchView extends EntryView {
  /** The key each `ref` in the patch was given. */
  readonly keys: Readonly<Record<string, string>>;
  /** The ops that undo this patch, applied to the version it saved (`invertBlockPatch`). */
  readonly inverse: readonly BlockOp[];
}

/**
 * Applies `ops` to the entry's blocks fields and saves the result as a new draft version. Refused
 * with 409 when the entry is no longer at `expectedVersion` (or another save takes the version
 * first), 403 for an op on a field the caller may not write, and 422 with the failing op's index
 * when an op can't apply; nothing is saved in any of these cases.
 */
export async function patchEntryBlocks(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: PatchEntryBlocksInput,
  options: PatchEntryBlocksOptions = {},
): Promise<BlockPatchView> {
  // The caps are judged on the request alone, before anything is read.
  const capped: { field: string; message: string }[] = [];
  if (input.ops.length === 0) capped.push({ field: 'ops', message: 'No ops to apply' });
  if (input.ops.length > BLOCK_PATCH_MAX_OPS) {
    capped.push({ field: 'ops', message: `At most ${BLOCK_PATCH_MAX_OPS} ops per patch` });
  }
  if (new TextEncoder().encode(JSON.stringify(input.ops)).length > BLOCK_PATCH_MAX_BYTES) {
    capped.push({ field: 'ops', message: `Ops exceed ${BLOCK_PATCH_MAX_BYTES} bytes` });
  }
  if (capped.length > 0) throw new ValidationError(capped);

  const { entry, fields } = await getEntry(ctx, scope, id);
  assertExpectedVersion(entry, input);
  const [contentType, config] = await Promise.all([
    ctx.store.contentTypes.get(scope, entry.contentTypeApiId),
    ctx.store.spaces.getConfig(scope),
  ]);
  if (!contentType) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const blocked = input.ops.find((op) => options.unwritable?.includes(op.field));
  if (blocked) throw new ForbiddenError(`content:write:${contentType.apiId}.${blocked.field}`);

  // Validation reads a localized field in the space's locales only, and a field that isn't
  // localized in the default locale only: a block put anywhere else would be stored and never read.
  const issues: BlockPatchIssue[] = [];
  const ops = input.ops.map((op, i) => {
    const locale = op.locale ?? config.defaultLocale;
    const def = contentType.fields.find((f) => f.apiId === op.field);
    const issue = (message: string) => issues.push({ op: i, field: `ops[${i}]`, locale, message });
    if (!config.locales.includes(locale)) {
      issue(`"${locale}" is not one of this space’s locales`);
    } else if (def && !def.localized && locale !== config.defaultLocale) {
      issue(`"${op.field}" is not localized; only ${config.defaultLocale} is allowed`);
    }
    return { ...op, locale } as BlockOp;
  });
  if (issues.length > 0) throw new ValidationError(issues);

  const result = applyBlockPatch(contentType, fields, ops, () => ctx.ids.newId());
  if (!result.ok) throw new ValidationError(result.issues);
  const inverse = invertBlockPatch(contentType, fields, result.applied);
  // The applied ops carry every key they made, so they always replay on the fields they came
  // from: a refusal here is a bug in the patch engine, not the caller's mistake.
  if (!inverse.ok) throw new Error(`Block patch did not invert: ${inverse.issues[0]?.message}`);

  const view = await saveEntryDraft(
    ctx,
    scope,
    entry,
    contentType,
    { defaultLocale: config.defaultLocale, locales: config.locales, previous: fields },
    result.fields,
    fields,
  );
  return { ...view, keys: result.keys, inverse: inverse.ops };
}

export interface EntryBlocksOutline {
  readonly entryId: string;
  /** The version outlined: what a patch built from it passes as `expectedVersion`. */
  readonly version: number;
  /** Blocks field → locale → its blocks (`outlineBlocks`). */
  readonly fields: Readonly<Record<string, Readonly<Record<LocaleCode, readonly BlockOutline[]>>>>;
}

/**
 * The entry's blocks fields (the current draft) as a compact tree of keys, types and labels:
 * enough to build a patch without reading every value. Narrowed to one field or locale when given.
 */
export async function outlineEntryBlocks(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: { readonly field?: string; readonly locale?: LocaleCode } = {},
): Promise<EntryBlocksOutline> {
  const { entry, fields } = await getEntry(ctx, scope, id);
  const contentType = await ctx.store.contentTypes.get(scope, entry.contentTypeApiId);
  if (!contentType) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  return {
    entryId: entry.id,
    version: entry.currentVersion,
    fields: outlineBlocks(contentType, fields, opts),
  };
}
