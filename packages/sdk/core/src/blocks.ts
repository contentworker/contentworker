/**
 * Blocks renderers, framework-free: a blocks field's value resolved to what a page renders. Each
 * block becomes one unit with its current `_type` (a renamed block's former id read through its
 * aliases), its `_key`, its slots resolved the same way below it, Coworker's ghost state from a
 * live preview, and, only when asked for a preview, the `data-cw-ref` and `data-cw-slot` marks
 * the admin maps clicks and seams from. `@contentworker/sdk/react`'s `<Blocks>` and
 * `@contentworker/sdk/vue`'s `<CwBlocks>` render these; {@link renderBlocks} hands them to plain
 * functions, for a renderer of your own (strings, DOM nodes, another framework).
 *
 * Values are rendered as they come: a block that isn't an object with a string `_type` is
 * skipped, never thrown on, since Delivery, Preview and the live preview channel can each hand a
 * page a value an older renderer doesn't know.
 */
import {
  CONTENT_REF_ATTRIBUTE,
  type ContentRef,
  type FieldPath,
  formatContentRef,
  formatFieldPath,
  parseFieldPath,
} from './content-ref.js';

/** A stored block: `{ _type, _key, ...its fields }`. Codegen's block types satisfy it. */
export interface BlockValue {
  readonly _type: string;
  /** Assigned by the server on write; only a block a live preview patch just brought may lack it. */
  readonly _key?: string;
}

/** A block whose fields aren't typed: what a fallback renders. */
export type UnknownBlock = BlockValue & { readonly [field: string]: unknown };

/**
 * A block id → block type map, as codegen emits it (`BlockTypes`): each block's id, and the
 * shape the component for it is given.
 */
export type BlockTypeMap<M> = { readonly [K in keyof M]: BlockValue };

/** How a block shows in a live preview with Coworker's proposals laid over it. */
export type BlockGhost = 'inserted' | 'changed' | 'removed';

/** `view.ghosts` from `connectPreview`'s `onState`: the proposals' blocks by `_key`. */
export interface BlockGhosts {
  readonly inserted?: readonly string[];
  readonly changed?: readonly string[];
  readonly removed?: readonly string[];
}

/** The attribute a ghost block carries in a preview render, for styling it (`[data-cw-ghost]`). */
export const GHOST_ATTRIBUTE = 'data-cw-ghost';
/** The live preview's slot mark (the `layout` extension), on the element holding a slot's blocks. */
export const BLOCKS_SLOT_ATTRIBUTE = 'data-cw-slot';

/** Spread onto a block's root element. Empty outside a preview render. */
export interface BlockAttrs {
  readonly 'data-cw-ref'?: string;
  readonly 'data-cw-ghost'?: BlockGhost;
}

/** Spread onto an element rendering one of a block's fields. Empty outside a preview render. */
export interface FieldAttrs {
  readonly 'data-cw-ref'?: string;
}

/** Spread onto the element directly holding a slot's blocks. Empty outside a preview render. */
export interface SlotAttrs {
  readonly 'data-cw-slot'?: string;
}

/**
 * The block catalog, or the part of it a renderer reads: what `GET …/block-catalog` answers, and
 * the shape of your `contentworker.blocks.json`. Gives each block's former ids and its slots.
 */
export interface BlockCatalogLike {
  readonly blocks: readonly {
    readonly id: string;
    readonly aliases?: readonly string[];
    readonly slots?: readonly { readonly apiId: string }[];
  }[];
}

/** A blocks field's variant, as the content type defines it (`field.items.variants`). */
export interface BlockVariantLike {
  readonly apiId: string;
  readonly aliases?: readonly string[];
  readonly fields: readonly {
    readonly apiId: string;
    readonly type: string;
    readonly items?: { readonly type?: string; readonly variants?: readonly BlockVariantLike[] };
  }[];
}

export interface ResolveBlocksOptions {
  /**
   * The catalog, so a block stored under a former id renders as its block, and a slot that holds
   * nothing yet is still known. Delivery and Preview's REST APIs serve each block as stored until
   * its entry is saved again.
   */
  readonly catalog?: BlockCatalogLike;
  /** Or the blocks field's variants from its content type; the catalog wins when both are given. */
  readonly variants?: readonly BlockVariantLike[];
  /** Ghost blocks by `_key` (`view.ghosts`); each unit carries its `ghost`. */
  readonly ghosts?: BlockGhosts;
  /**
   * The blocks field as a live preview ref (`field` its apiId, or a path to a slot). Given, every
   * block, slot and field carries its mark; absent, nothing does. Pass it only in a preview render.
   */
  readonly preview?: ContentRef | null | false;
}

/** A blocks value resolved: the slot's mark and its blocks. */
export interface ResolvedBlocks {
  /** The slot's field path (`body`, `body[k1].items`), when rendering for a preview. */
  readonly path: string | undefined;
  readonly attrs: SlotAttrs;
  readonly blocks: readonly ResolvedBlock[];
}

/** One block, ready to render. */
export interface ResolvedBlock {
  /** The block's current id: its `_type`, or the block a former id now names. */
  readonly type: string;
  /** The `_type` as stored, which differs from `type` for a block renamed since it was saved. */
  readonly storedType: string;
  /** Its `_key`; undefined for a block not yet keyed. */
  readonly key: string | undefined;
  /** A key unique among its siblings, for a framework's list key: `_key`, else its position. */
  readonly renderKey: string;
  readonly index: number;
  /** The stored value, with `_type` set to {@link type}. */
  readonly block: UnknownBlock;
  readonly ghost: BlockGhost | undefined;
  /** Its field path (`body[k1]`), when rendering for a preview and it has a key. */
  readonly path: string | undefined;
  readonly attrs: BlockAttrs;
  /** Marks for an element rendering one of its fields: `fieldAttrs('heading')`. */
  fieldAttrs(field: string): FieldAttrs;
  /**
   * The slots it is known to have: those its definition names (from `catalog` or `variants`),
   * and any field holding a list of blocks.
   */
  readonly slotNames: readonly string[];
  /** One of its slots, resolved; an empty one when the block holds nothing there. */
  slot(name: string): ResolvedBlocks;
}

interface Definition {
  readonly slots: readonly string[];
  /** A slot's own variants, when the definition came from variants (they nest). */
  readonly slotVariants?: ReadonlyMap<string, readonly BlockVariantLike[]>;
}

interface Scope {
  readonly lookup: (type: string) => { readonly type: string; readonly def?: Definition };
  readonly slotScope: (def: Definition | undefined, slot: string) => Scope;
}

const EMPTY: Readonly<Record<string, never>> = Object.freeze({});
const NO_GHOSTS: ReadonlyMap<string, BlockGhost> = new Map();

/** A list a definition holds, or none: definitions come from JSON a renderer didn't check. */
const list = <T>(v: readonly T[] | undefined): readonly T[] => (Array.isArray(v) ? v : []);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A block id the way the domain matches it: an exact id first, then a former one. */
function byIdOrAlias<T>(
  items: readonly T[],
  id: (t: T) => string,
  aliases: (t: T) => readonly string[] | undefined,
  type: string,
): T | undefined {
  return (
    items.find((t) => id(t) === type) ??
    items.find((t) => {
      const a = aliases(t);
      return Array.isArray(a) && a.includes(type);
    })
  );
}

function catalogScope(catalog: BlockCatalogLike): Scope {
  const blocks = list(catalog.blocks);
  const scope: Scope = {
    lookup(type) {
      const b = byIdOrAlias(
        blocks,
        (x) => x.id,
        (x) => x.aliases,
        type,
      );
      if (!b) return { type };
      const slots = list(b.slots).map((s) => s.apiId);
      return { type: b.id, def: { slots } };
    },
    // A catalog names blocks once, whatever slot they sit in.
    slotScope: () => scope,
  };
  return scope;
}

function variantsScope(variants: readonly BlockVariantLike[]): Scope {
  return {
    lookup(type) {
      const v = byIdOrAlias(
        variants,
        (x) => x.apiId,
        (x) => x.aliases,
        type,
      );
      if (!v) return { type };
      const slotVariants = new Map<string, readonly BlockVariantLike[]>();
      for (const f of list(v.fields)) {
        const nested = f.type === 'Array' && f.items?.type === 'Component' && f.items.variants;
        if (Array.isArray(nested)) slotVariants.set(f.apiId, nested);
      }
      return { type: v.apiId, def: { slots: [...slotVariants.keys()], slotVariants } };
    },
    slotScope: (def, slot) => {
      const nested = def?.slotVariants?.get(slot);
      return nested ? variantsScope(nested) : UNTYPED;
    },
  };
}

const UNTYPED: Scope = { lookup: (type) => ({ type }), slotScope: () => UNTYPED };

function ghostsByKey(ghosts: BlockGhosts | undefined): ReadonlyMap<string, BlockGhost> {
  if (!ghosts) return NO_GHOSTS;
  const out = new Map<string, BlockGhost>();
  // Later wins: a block both changed and removed shows as going.
  for (const kind of ['changed', 'removed', 'inserted'] as const) {
    for (const key of ghosts[kind] ?? []) out.set(key, kind);
  }
  return out;
}

/** A path one step into a block by key, or a field by name; undefined below a block with no key. */
const intoBlock = (path: FieldPath | undefined, key: string | undefined): FieldPath | undefined =>
  path && key ? { field: path.field, steps: [...path.steps, { key }] } : undefined;
const intoField = (path: FieldPath | undefined, field: string): FieldPath | undefined =>
  path ? { field: path.field, steps: [...path.steps, { field }] } : undefined;

/** A path as a ref holds it; undefined for one `formatFieldPath` refuses (a field name with `.`). */
function formatPath(path: FieldPath | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return formatFieldPath(path);
  } catch {
    return undefined;
  }
}

interface Context {
  readonly ghosts: ReadonlyMap<string, BlockGhost>;
  readonly preview: ContentRef | undefined;
}

function mark(ctx: Context, path: string | undefined): string | undefined {
  return ctx.preview && path !== undefined
    ? formatContentRef({ ...ctx.preview, field: path })
    : undefined;
}

function resolveList(
  value: unknown,
  scope: Scope,
  ctx: Context,
  at: FieldPath | undefined,
): ResolvedBlocks {
  const path = formatPath(at);
  const slotMark = mark(ctx, path);
  const attrs: SlotAttrs = slotMark ? { [BLOCKS_SLOT_ATTRIBUTE]: slotMark } : EMPTY;
  const items = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const blocks: ResolvedBlock[] = [];
  items.forEach((item, index) => {
    if (!isObject(item) || typeof item._type !== 'string' || item._type === '') return;
    const storedType = item._type;
    const key = typeof item._key === 'string' && item._key !== '' ? item._key : undefined;
    const { type, def } = scope.lookup(storedType);
    const block = (type === storedType ? item : { ...item, _type: type }) as UnknownBlock;
    const renderKey = key && !seen.has(key) ? key : `#${index}`;
    seen.add(renderKey);
    const ghost = key ? ctx.ghosts.get(key) : undefined;
    const blockAt = intoBlock(at, key);
    const blockPath = formatPath(blockAt);
    const ref = mark(ctx, blockPath);
    const attrs: BlockAttrs = ctx.preview
      ? {
          ...(ref ? { [CONTENT_REF_ATTRIBUTE]: ref } : {}),
          ...(ghost ? { [GHOST_ATTRIBUTE]: ghost } : {}),
        }
      : EMPTY;
    const slotNames = [...(def?.slots ?? [])];
    for (const [field, v] of Object.entries(item)) {
      if (!slotNames.includes(field) && isBlockList(v)) slotNames.push(field);
    }
    const slots = new Map<string, ResolvedBlocks>();
    blocks.push({
      type,
      storedType,
      key,
      renderKey,
      index,
      block,
      ghost,
      path: blockPath,
      attrs,
      fieldAttrs(field) {
        const fieldMark = mark(ctx, formatPath(intoField(blockAt, field)));
        return fieldMark ? { [CONTENT_REF_ATTRIBUTE]: fieldMark } : EMPTY;
      },
      slotNames,
      slot(name) {
        let resolved = slots.get(name);
        if (!resolved) {
          resolved = resolveList(
            item[name],
            scope.slotScope(def, name),
            ctx,
            intoField(blockAt, name),
          );
          slots.set(name, resolved);
        }
        return resolved;
      },
    });
  });
  return { path, attrs, blocks };
}

/** A list every element of which is a block: a slot, even one not named by a definition. */
function isBlockList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => isObject(x) && typeof x._type === 'string' && x._type !== '')
  );
}

/**
 * Resolves a blocks field's value (anything: a value that isn't a list renders nothing) to its
 * blocks, each with its current type, key, ghost state and, for a preview, its marks. Slots
 * resolve on demand with {@link ResolvedBlock.slot}.
 *
 * ```ts
 * const { attrs, blocks } = resolveBlocks(entry.fields.body, { catalog, preview: ref });
 * ```
 */
export function resolveBlocks(value: unknown, options: ResolveBlocksOptions = {}): ResolvedBlocks {
  const scope = options.catalog
    ? catalogScope(options.catalog)
    : options.variants
      ? variantsScope(options.variants)
      : UNTYPED;
  const preview = options.preview || undefined;
  const ctx: Context = { ghosts: ghostsByKey(options.ghosts), preview };
  // A ref's field may already be a path (rendering one slot of a block on its own).
  return resolveList(value, scope, ctx, preview ? parseFieldPath(preview.field) : undefined);
}

/** A slot as {@link renderBlocks} hands it to a component: its mark and its rendered blocks. */
export interface RenderedSlot<R> {
  readonly attrs: SlotAttrs;
  readonly items: readonly R[];
}

/** What {@link renderBlocks} calls each block's function with. */
export interface BlockRenderProps<B extends BlockValue, R> {
  readonly block: B;
  readonly index: number;
  readonly ghost: BlockGhost | undefined;
  readonly attrs: BlockAttrs;
  readonly fieldAttrs: (field: string) => FieldAttrs;
  /** One of its slots, rendered with the same functions. */
  readonly slot: (name: string) => RenderedSlot<R>;
}

/** A function per block id; codegen's `BlockTypes` types each one's `block`. */
export type BlockRenderers<M extends BlockTypeMap<M>, R> = {
  readonly [K in keyof M]?: (props: BlockRenderProps<M[K], R>) => R;
};

export interface RenderBlocksOptions<M extends BlockTypeMap<M>, R> extends ResolveBlocksOptions {
  readonly components: BlockRenderers<M, R>;
  /** Renders a block no function is given for; absent, such a block renders nothing. */
  readonly fallback?: (props: BlockRenderProps<UnknownBlock, R>) => R;
}

/**
 * Renders a blocks value with a plain function per block id, for a renderer of your own. Returns
 * the top level's slot marks (spread them onto the element holding the blocks) and the results.
 *
 * ```ts
 * const html = renderBlocks<BlockTypes, string>(page.fields.body, {
 *   components: {
 *     hero: ({ block }) => `<section><h1>${escape(block.heading)}</h1></section>`,
 *     grid: ({ slot }) => `<ul>${slot('cards').items.join('')}</ul>`,
 *   },
 * }).items.join('');
 * ```
 */
export function renderBlocks<M extends BlockTypeMap<M>, R>(
  value: unknown,
  options: RenderBlocksOptions<M, R>,
): RenderedSlot<R> {
  const renderers = options.components as Readonly<
    Record<string, ((props: BlockRenderProps<UnknownBlock, R>) => R) | undefined>
  >;
  const render = (resolved: ResolvedBlocks): RenderedSlot<R> => {
    const items: R[] = [];
    for (const unit of resolved.blocks) {
      const fn = Object.hasOwn(renderers, unit.type) ? renderers[unit.type] : undefined;
      const use = fn ?? options.fallback;
      if (!use) continue;
      items.push(
        use({
          block: unit.block,
          index: unit.index,
          ghost: unit.ghost,
          attrs: unit.attrs,
          fieldAttrs: unit.fieldAttrs,
          slot: (name) => render(unit.slot(name)),
        }),
      );
    }
    return { attrs: resolved.attrs, items };
  };
  return render(resolveBlocks(value, options));
}
