/**
 * How the Generate dialog shows a drafted blocks field: an outline of the blocks the model
 * composed (their names from the content model, a line of their text, slots indented), and the
 * place each image it asked for sits, by name ("Main › Hero 1 › Image") rather than a path.
 * Presentation only: the server judged the draft before it came back.
 */
import {
  BLOCK_TYPE_KEY,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EntryFields,
  type FieldDefinition,
} from '@contentworker/domain';

export interface DraftBlockRow {
  readonly key: string;
  /** 0 for the field's own blocks, one more per slot. */
  readonly depth: number;
  /** The block's name, from its variant; the raw `_type` when the model named none we know. */
  readonly name: string;
  /** A line of its text: the first text field with a value. */
  readonly text?: string;
}

const TEXT_TYPES = new Set(['Symbol', 'Text']);
const TEXT_MAX = 80;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const variantOf = (variants: readonly ComponentVariant[], type: unknown) =>
  typeof type === 'string' ? variants.find((v) => v.apiId === type) : undefined;

function firstText(variant: ComponentVariant | undefined, block: Record<string, unknown>) {
  for (const f of variant?.fields ?? []) {
    const v = block[f.apiId];
    if (TEXT_TYPES.has(f.type) && typeof v === 'string' && v.trim()) {
      const line = v.trim().replace(/\s+/g, ' ');
      return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1)}…` : line;
    }
  }
  return undefined;
}

/** The outline of a drafted blocks value; empty when `field` isn't a blocks field. */
export function draftBlockRows(field: FieldDefinition, value: unknown): DraftBlockRow[] {
  const rows: DraftBlockRow[] = [];
  const walk = (
    variants: readonly ComponentVariant[],
    items: unknown,
    depth: number,
    at: string,
  ) => {
    if (!Array.isArray(items)) return;
    items.forEach((block, i) => {
      if (!isObject(block)) return;
      const variant = variantOf(variants, block[BLOCK_TYPE_KEY]);
      const key = `${at}[${i}]`;
      const text = firstText(variant, block);
      rows.push({
        key,
        depth,
        name: variant?.name ?? String(block[BLOCK_TYPE_KEY] ?? 'Block'),
        ...(text ? { text } : {}),
      });
      for (const slot of variant?.fields ?? []) {
        const inner = blockVariants(slot);
        if (inner) walk(inner, block[slot.apiId], depth + 1, `${key}.${slot.apiId}`);
      }
    });
  };
  const variants = blockVariants(field);
  if (variants) walk(variants, value, 0, field.apiId);
  return rows;
}

/** Whether a content type's field holds blocks. */
export const isBlocksField = (field: FieldDefinition | undefined) =>
  !!field && blockVariants(field) !== undefined;

const SEGMENT = /^([^[\]]+)((?:\[\d+\])*)$/;

/**
 * A draft path (`body[0].items[1].image`) by the names an editor sees: "Main › Hero 1 › Cards ›
 * Card 2 › Image". Falls back to the path when a step doesn't resolve.
 */
export function placeName(contentType: ContentType, fields: EntryFields, path: string): string {
  const parts: string[] = [];
  let defs: readonly FieldDefinition[] = contentType.fields;
  let value: unknown;
  let top = true;
  for (const segment of path.split('.')) {
    const m = SEGMENT.exec(segment);
    const def = m ? defs.find((f) => f.apiId === m[1]) : undefined;
    if (!m || !def) return path;
    parts.push(def.name || def.apiId);
    value = top
      ? Object.values((fields[def.apiId] ?? {}) as Record<string, unknown>)[0]
      : isObject(value)
        ? value[def.apiId]
        : undefined;
    top = false;
    const indexes = [...(m[2] ?? '').matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
    for (const index of indexes) {
      const variants = blockVariants(def);
      const block = Array.isArray(value) ? value[index] : undefined;
      const variant =
        variants && isObject(block) ? variantOf(variants, block[BLOCK_TYPE_KEY]) : undefined;
      if (!variant) return path;
      parts.push(`${variant.name} ${index + 1}`);
      value = block;
      defs = variant.fields;
    }
  }
  return parts.join(' › ');
}
