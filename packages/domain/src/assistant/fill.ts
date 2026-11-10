/**
 * "Fill this slot": the one place in one entry's blocks the canvas asks Coworker to fill, as both
 * sides read it. The admin sends it with the message (the entry page's `fill`), the agent quotes it
 * to the model as untrusted content, and the confirm card holds the model's patch to it: blocks put
 * in at that place and nowhere else, of the types the slot offers, within its bounds. What the
 * slot may hold (the block config's narrowing, its locks, the entry's locked regions) is still the
 * server's to judge, on the dry run and on the save.
 */

/** A block type the slot offers, with the text fields a proposal may fill in. */
export interface AssistantFillBlock {
  /** The variant's apiId: the `_type` a new block takes. */
  readonly type: string;
  readonly name: string;
  /** Its short text fields, by apiId and name. */
  readonly fields: readonly { readonly apiId: string; readonly name: string }[];
}

export interface AssistantFill {
  /** The top-level blocks field, and the locale its ops address. */
  readonly field: string;
  readonly locale: string;
  /** The block whose slot it is; absent for the field itself. */
  readonly parent?: { readonly key: string; readonly slot: string };
  /** The place: after this block, else before this one, else the slot is empty. */
  readonly after?: string;
  readonly before?: string;
  /** The slot as a person reads it: "Body", "Section › Items". */
  readonly slot: string;
  /** What may go there: the slot's blocks, narrowed by the block config. */
  readonly blocks: readonly AssistantFillBlock[];
  /** How many it holds now, and its bounds (the field's and the config's, the tighter). */
  readonly count: number;
  readonly min?: number;
  readonly max?: number;
  /** The slot's blocks in order, as the page names them ("Hero “Spring launch”"): content. */
  readonly around: readonly string[];
}

/** The most a fill names of each; the agent cuts what a page sends to these. */
export const FILL_LIMITS = { blocks: 40, fields: 8, around: 20, text: 120 } as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The first step of `ops` that doesn't keep to `fill`, or undefined when every one does. A step
 * keeps to it when it inserts a block of a type the slot offers, holding only text in that type's
 * listed fields, into that field, locale and slot, at that place or beside a block an earlier step
 * put there, and the slot's `max` still has room. Anything else (an update, a move, a remove,
 * another slot, a link or a nested block) is outside what was asked.
 */
export function outsideFill(fill: AssistantFill, ops: readonly unknown[]): number | undefined {
  const types = new Set(fill.blocks.map((b) => b.type));
  // The keys and refs of the blocks this patch has put in so far: the next may follow one.
  const placed = new Set<string>();
  let count = fill.count;
  for (const [i, op] of ops.entries()) {
    if (!isRecord(op) || op.op !== 'insert') return i;
    if (op.field !== fill.field || op.locale !== fill.locale) return i;
    const block = op.block;
    if (!isRecord(block) || typeof block._type !== 'string' || !types.has(block._type)) return i;
    if (!asked(fill, block)) return i;
    if (!sameParent(op.parent, fill.parent)) return i;
    if (!atPlace(op, fill, placed)) return i;
    count += 1;
    if (fill.max !== undefined && count > fill.max) return i;
    if (typeof block._key === 'string') placed.add(block._key);
    if (typeof op.ref === 'string') placed.add(op.ref);
  }
  return undefined;
}

/**
 * A new block holding only what the fill asked for: its type, its key, and plain text in the text
 * fields listed for its type. No other field (a link, a reference, an asset) and no blocks inside
 * it: those weren't asked about, so nothing the model was led to put there is offered for Confirm.
 */
function asked(fill: AssistantFill, block: Record<string, unknown>): boolean {
  const fields = new Set(
    fill.blocks.find((b) => b.type === block._type)?.fields.map((f) => f.apiId) ?? [],
  );
  return Object.entries(block).every(([name, value]) =>
    name === '_type'
      ? true
      : name === '_key'
        ? typeof value === 'string'
        : fields.has(name) && typeof value === 'string',
  );
}

function sameParent(a: unknown, b: AssistantFill['parent']): boolean {
  if (a === undefined) return b === undefined;
  return isRecord(a) && b !== undefined && a.key === b.key && a.slot === b.slot;
}

function atPlace(op: Record<string, unknown>, fill: AssistantFill, placed: Set<string>): boolean {
  const { after, before, index } = op;
  if (typeof after === 'string') return after === fill.after || placed.has(after);
  if (typeof before === 'string') {
    return before === fill.before || placed.has(before);
  }
  // At the end (no place given) is the place only when nothing follows it; index 0, when nothing
  // precedes it.
  if (index === undefined) return fill.before === undefined;
  return index === 0 && fill.after === undefined;
}

/**
 * A field or slot name and a locale, as the content model writes them; a block key, any stored
 * string (minted ones are UUIDs) short of control characters.
 */
const NAME = /^[A-Za-z_][\w-]{0,63}$/;
const LOCALE = /^[A-Za-z0-9-]{2,35}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const KEY = /^[^\u0000-\u001f\u007f]{1,128}$/;
const text = (v: unknown) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, FILL_LIMITS.text) : '';
const bound = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : undefined;
const key = (v: unknown) => (typeof v === 'string' && KEY.test(v) ? v : undefined);
const record = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * The slot a canvas asked Coworker to fill, or undefined when it doesn't name one exactly: the
 * field, locale and place as the store names them, and no more of anything than `FILL_LIMITS`. The
 * agent reads a message's with it, and a card its turn's. Its words (names, labels) are what a page
 * sent, so they reach the model quoted, never as instructions.
 */
export function readAssistantFill(raw: unknown): AssistantFill | undefined {
  const f = record(raw);
  if (!f) return undefined;
  if (typeof f.field !== 'string' || !NAME.test(f.field)) return undefined;
  if (typeof f.locale !== 'string' || !LOCALE.test(f.locale)) return undefined;
  let parent: AssistantFill['parent'];
  if (f.parent !== undefined) {
    const p = record(f.parent);
    const k = key(p?.key);
    if (!k || typeof p?.slot !== 'string' || !NAME.test(p.slot)) return undefined;
    parent = { key: k, slot: p.slot };
  }
  const after = key(f.after);
  const before = key(f.before);
  if ((f.after !== undefined && !after) || (f.before !== undefined && !before)) return undefined;
  const blocks = (Array.isArray(f.blocks) ? f.blocks : [])
    .slice(0, FILL_LIMITS.blocks)
    .flatMap((b): AssistantFillBlock[] => {
      const v = record(b);
      if (typeof v?.type !== 'string' || !NAME.test(v.type)) return [];
      const fields = (Array.isArray(v.fields) ? v.fields : [])
        .slice(0, FILL_LIMITS.fields)
        .flatMap((x) => {
          const y = record(x);
          return typeof y?.apiId === 'string' && NAME.test(y.apiId)
            ? [{ apiId: y.apiId, name: text(y.name) || y.apiId }]
            : [];
        });
      return [{ type: v.type, name: text(v.name) || v.type, fields }];
    });
  // Nothing it may hold: there is nothing to fill.
  if (blocks.length === 0) return undefined;
  const min = bound(f.min);
  const max = bound(f.max);
  return {
    field: f.field,
    locale: f.locale,
    ...(parent ? { parent } : {}),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    slot: text(f.slot) || f.field,
    blocks,
    count: bound(f.count) ?? 0,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    around: (Array.isArray(f.around) ? f.around : [])
      .slice(0, FILL_LIMITS.around)
      .map(text)
      .filter(Boolean),
  };
}
