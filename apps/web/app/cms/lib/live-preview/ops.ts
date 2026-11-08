/**
 * What the Site pane sends the framed page after every change of the entry form, so it re-renders
 * the edit before anything is saved (docs/specs/live-preview-channel.md): one locale's values, as
 * the page renders them, and the edits between two of them.
 *
 * An ordinary field that changed goes in `entry.patch` (its new value, `null` when cleared). A
 * blocks field goes as `blocks.patch` ops, key-addressed in the applied form `patchBlocks` answers
 * with (every `_key` present, inserts carrying their own keys), so the page re-renders the block
 * that changed and its next click names a key the form holds. Where that can't be said exactly (a
 * block with no key yet, a key held twice, a reshuffle that would take more ops than blocks, more
 * ops than one patch carries) the field goes whole in `entry.patch` instead.
 */
import {
  BLOCK_KEY,
  blockVariants,
  type ContentType,
  type EntryFields,
  type FieldDefinition,
} from '@contentworker/domain';
import {
  contentValueIssue,
  type LiveFields,
  type LivePatchOp,
  MAX_PATCH_OPS,
} from '@contentworker/sdk-core/live-preview';

type Block = Record<string, unknown>;

/** The edits between two states of one entry in one locale. */
export interface LiveEdits {
  /** Changed top-level values; `null` clears one. */
  readonly fields: Record<string, unknown>;
  /** Key-addressed ops, one list per blocks field. */
  readonly blocks: readonly { readonly field: string; readonly ops: readonly LivePatchOp[] }[];
}

/**
 * The form's values in one locale, as the page renders them: a localized field's value in that
 * locale, any other field's from the default locale (where the form keeps it). A value that can't
 * cross the channel as it is typed (`contentValueIssue`: rich text that isn't a document) is left
 * out, never sent as markup.
 */
export function liveFields(
  contentType: Pick<ContentType, 'fields'>,
  fields: EntryFields,
  locale: string,
  defaultLocale: string,
): LiveFields {
  const out: LiveFields = {};
  for (const f of contentType.fields) {
    const byLocale = fields[f.apiId] as Record<string, unknown> | undefined;
    const value = byLocale?.[f.localized ? locale : defaultLocale];
    if (value === undefined || contentValueIssue(f.type, value) !== undefined) continue;
    out[f.apiId] = value;
  }
  return out;
}

/** The edits that turn `before` into `after`, both one locale's values (`liveFields`). */
export function liveEdits(
  contentType: Pick<ContentType, 'fields'>,
  locale: string,
  before: LiveFields,
  after: LiveFields,
): LiveEdits {
  const fields: Record<string, unknown> = {};
  const blocks: { field: string; ops: LivePatchOp[] }[] = [];
  for (const field of contentType.fields) {
    const a = before[field.apiId];
    const b = after[field.apiId];
    if (equal(a, b)) continue;
    const ops = isBlocksField(field) ? blocksOps(field.apiId, locale, a, b) : undefined;
    if (ops && ops.length > 0 && ops.length <= MAX_PATCH_OPS)
      blocks.push({ field: field.apiId, ops });
    else fields[field.apiId] = b === undefined ? null : b;
  }
  return { fields, blocks };
}

const isBlocksField = (field: FieldDefinition): boolean => blockVariants(field) !== undefined;

/**
 * One blocks field in one locale, by key: removes, then each block put where it now stands
 * (moved, or inserted with its key), then the changed properties of the blocks that stayed. A
 * slot inside a block changes as that block's property. Undefined when it can't be said by key.
 */
function blocksOps(
  field: string,
  locale: string,
  was: unknown,
  now: unknown,
): LivePatchOp[] | undefined {
  const a = was === undefined ? [] : was;
  const b = now === undefined ? [] : now;
  if (!keyedList(a) || !keyedList(b)) return undefined;
  const before = new Map(a.map((block) => [block[BLOCK_KEY] as string, block]));
  const kept = new Set(b.map((block) => block[BLOCK_KEY] as string));
  const ops: LivePatchOp[] = [];

  const order: string[] = [];
  for (const key of before.keys()) {
    if (kept.has(key)) order.push(key);
    else ops.push({ op: 'remove', field, locale, key });
  }
  b.forEach((block, i) => {
    const key = block[BLOCK_KEY] as string;
    if (order[i] === key) return;
    const prev = i > 0 ? (b[i - 1] as Block)[BLOCK_KEY] : undefined;
    const place = typeof prev === 'string' ? { after: prev } : { index: 0 };
    const at = order.indexOf(key);
    if (at >= 0) {
      ops.push({ op: 'move', field, locale, key, to: place });
      order.splice(at, 1);
    } else {
      ops.push({ op: 'insert', field, locale, block, ...place });
    }
    order.splice(i, 0, key);
  });
  for (const block of b) {
    const key = block[BLOCK_KEY] as string;
    const old = before.get(key);
    if (!old) continue;
    const set: Block = {};
    const unset: string[] = [];
    for (const [name, value] of Object.entries(block)) {
      if (name !== BLOCK_KEY && !equal(old[name], value)) set[name] = value;
    }
    for (const name of Object.keys(old)) if (!(name in block)) unset.push(name);
    if (Object.keys(set).length === 0 && unset.length === 0) continue;
    ops.push({
      op: 'update',
      field,
      locale,
      key,
      ...(Object.keys(set).length ? { set } : {}),
      ...(unset.length ? { unset } : {}),
    });
  }
  // A reshuffle that takes more ops than there are blocks reads better as the list itself.
  return ops.length > Math.max(b.length, 1) ? undefined : ops;
}

/**
 * A list of blocks the page can address by key: each a block with a `_key` no other block in the
 * list (or anywhere inside them) holds, and every block nested inside keyed too.
 */
function keyedList(value: unknown): value is Block[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  return value.every((item) => isRecord(item) && keyedBlock(item, seen));
}

function keyedBlock(block: Block, seen: Set<string>): boolean {
  const key = block[BLOCK_KEY];
  if (typeof key !== 'string' || key === '' || seen.has(key)) return false;
  seen.add(key);
  return Object.entries(block).every(
    ([name, value]) => name === BLOCK_KEY || nestedKeyed(value, seen),
  );
}

/** Blocks anywhere inside a value (a slot, a component holding one) are keyed. */
function nestedKeyed(value: unknown, seen: Set<string>): boolean {
  if (Array.isArray(value)) return value.every((v) => nestedKeyed(v, seen));
  if (!isRecord(value)) return true;
  if (typeof value._type === 'string' && value._type !== '') return keyedBlock(value, seen);
  return Object.values(value).every((v) => nestedKeyed(v, seen));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep equality of JSON values, whatever order an object's properties were written in. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => equal(a[k], b[k]));
}
