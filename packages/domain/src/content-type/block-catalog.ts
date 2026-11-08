import { ConflictError, type FieldIssue, ValidationError } from '../errors';
import { parseAbsoluteUrl } from '../rich-text/embed';
import type { EntryFields } from '../types';
import { removedFields, removedVariants } from './blocks';
import { type ContentType, defineContentType } from './content-type';
import {
  BLOCK_TYPE_KEY,
  blockVariants,
  type ComponentVariant,
  type FieldDefinition,
  isValidApiId,
  MAX_COMPONENT_DEPTH,
  variantOf,
} from './field';

/**
 * Blocks from code: the components a developer's site renders, described as data and pushed to
 * a space as a block catalog, which becomes the variants of the content types' blocks fields.
 *
 * A manifest is JSON, never a function: nothing a developer ships is evaluated by the admin or
 * the api, so a catalog can be validated, diffed, versioned and shown without running anyone's
 * code. Placement is declarative too: a slot lists the blocks it takes (`allowedChildren`), a
 * block may list the parents it fits in (`allowedParents`), and the two must agree.
 *
 * A block's `id` is its stable identity (stored on each block as `_type`), separate from its
 * `name`, so relabelling a component never touches content. Changing the id itself is a rename:
 * the new block lists the old id in `aliases`, and blocks stored under the old one keep reading
 * as it (see `ComponentVariant.aliases`). An id is never reused for a different block.
 *
 * Props are the content model's own field vocabulary (`FieldDefinition`), so a block's values
 * are validated, versioned and delivered like any other field's. Style props are tokens: a
 * Symbol with an `in` list (`size: sm | md | lg`), never free-form CSS, so editors compose from
 * what the design system allows. A JSON field (an untyped escape hatch) is refused, and a field
 * named for styling (`style`, `css`, `className`) must be an enumeration.
 *
 * Not yet: per-breakpoint overrides of token props, and slots deeper than the content model's
 * component depth ({@link MAX_COMPONENT_DEPTH}) allows.
 */

/** A named place inside a block that holds other blocks: a nested blocks field. */
export interface BlockSlot {
  /** The nested field's apiId, unique among the block's fields and slots. */
  readonly apiId: string;
  readonly name: string;
  /** Shown under the slot in the editor. Plain text. */
  readonly help?: string;
  /** The block ids this slot takes; at least one. */
  readonly allowedChildren: readonly string[];
  /** Fewest blocks the slot holds (0 by default); above 0 makes the slot required. */
  readonly min?: number;
  /** Most blocks the slot holds. */
  readonly max?: number;
}

/**
 * A block's picture in the editor's dock: an asset in the space (`{ assetId }`), or an https
 * image the developer hosts (`{ url }`). Never a data URL or an inline SVG: both are markup the
 * admin would have to trust.
 */
export type BlockThumbnail = { readonly assetId: string } | { readonly url: string };

/** One component the developer's site renders, as data. */
export interface BlockManifest {
  /** Stable machine id, stored on each block as `_type`. Never reused for another block. */
  readonly id: string;
  /** What editors see in the dock. */
  readonly name: string;
  /** The dock's heading this block sits under. */
  readonly group?: string;
  readonly description?: string;
  readonly thumbnail?: BlockThumbnail;
  /** Ids this block had before: blocks stored under one read as this block. */
  readonly aliases?: readonly string[];
  /** The block's props, in the content model's field vocabulary. */
  readonly fields: readonly FieldDefinition[];
  readonly slots?: readonly BlockSlot[];
  /**
   * The only blocks whose slots may hold this one. Absent, it goes wherever a slot allows it and
   * at the top level of every target; present, only inside those parents' slots.
   */
  readonly allowedParents?: readonly string[];
}

/** A content type's blocks field the catalog provides the variants of. */
export interface BlockCatalogTarget {
  readonly contentTypeApiId: string;
  /** A top-level blocks field (an Array of Component with `items.variants`). */
  readonly field: string;
  /**
   * The blocks the field takes at its top level. Absent, every block without `allowedParents`.
   * Never a block with `allowedParents`: that one only goes inside its parents.
   */
  readonly blocks?: readonly string[];
}

/** One pushed version of an environment's catalog. */
export interface BlockCatalog {
  /** 1 for the first push, then one more for each push that changed something. */
  readonly version: number;
  /** SHA-256 (hex) of the canonical blocks and targets: equal hashes, equal catalogs. */
  readonly hash: string;
  readonly blocks: readonly BlockManifest[];
  readonly targets: readonly BlockCatalogTarget[];
  /** What this version changed from the one before it. */
  readonly changes: BlockCatalogChanges;
  readonly pushedAt: string;
  /** Who pushed it, as the audit trail names them. */
  readonly pushedBy: string | null;
}

/** A version without its blocks: what the version history lists. */
export type BlockCatalogSummary = Omit<BlockCatalog, 'blocks'> & { readonly blockCount: number };

/** What one catalog changes from another, by block id. */
export interface BlockCatalogChanges {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
}

export const BLOCK_CATALOG_LIMITS = {
  blocks: 200,
  slots: 10,
  aliases: 20,
  targets: 20,
  name: 100,
  group: 100,
  description: 1000,
  help: 500,
  url: 2000,
  /** Variants one target expands to, slots included: bounds the content type's definition. */
  expandedVariants: 1000,
  /** The catalog as JSON, characters: one D1 row, with room to spare. */
  bytes: 1_000_000,
} as const;

/** Fields named for styling: allowed only as an enumeration of tokens. */
const STYLE_FIELD = /^(style|styles|css|class|classname|classes|inlinestyle)$/i;

/** What a push sends, before it is checked. */
export interface BlockCatalogInput {
  readonly blocks: unknown;
  readonly targets: unknown;
}

/**
 * Checks a catalog and returns it normalized: each field filled the way the content model
 * stores it (`localized` and `required` false, `position` its index), unknown keys dropped.
 * Collects every structural problem before refusing, as a `ValidationError` whose issues name
 * the block (`blocks[hero].slots.items`), so a developer fixes the file in one pass.
 */
export function checkBlockCatalog(input: BlockCatalogInput): {
  blocks: BlockManifest[];
  targets: BlockCatalogTarget[];
} {
  const issues: FieldIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ field, message });
  const blocks = checkBlocks(input.blocks, issue);
  const targets = checkTargets(input.targets, blocks, issue);
  if (issues.length === 0) checkPlacement(blocks, issue);
  if (issues.length === 0) {
    for (const b of blocks) checkBlockFields(b, issue);
  }
  if (issues.length === 0 && canonicalJson(blocks).length > BLOCK_CATALOG_LIMITS.bytes) {
    issue('blocks', `The catalog is larger than ${BLOCK_CATALOG_LIMITS.bytes} characters as JSON`);
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return { blocks, targets };
}

type Issue = (field: string, message: string) => void;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(
  value: unknown,
  at: string,
  max: number,
  issue: Issue,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) issue(at, 'is required');
    return undefined;
  }
  if (typeof value !== 'string' || (required && value.trim() === '')) {
    issue(at, required ? 'must be a non-empty string' : 'must be a string');
    return undefined;
  }
  if (value.length > max) issue(at, `must be at most ${max} characters`);
  return value.trim() === '' ? undefined : value;
}

function idList(value: unknown, at: string, issue: Issue, max?: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issue(at, 'must be a list of block ids');
    return undefined;
  }
  if (max !== undefined && value.length > max) issue(at, `lists at most ${max}`);
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !isValidApiId(id)) issue(at, `"${String(id)}" is not a valid id`);
    else if (out.includes(id)) issue(at, `"${id}" is listed twice`);
    else out.push(id);
  }
  return out;
}

function checkBlocks(raw: unknown, issue: Issue): BlockManifest[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issue('blocks', 'must be a non-empty list of block manifests');
    return [];
  }
  if (raw.length > BLOCK_CATALOG_LIMITS.blocks) {
    issue('blocks', `A catalog holds at most ${BLOCK_CATALOG_LIMITS.blocks} blocks`);
  }
  const out: BlockManifest[] = [];
  const ids = new Set<string>();
  raw.forEach((b, i) => {
    if (!isObject(b)) {
      issue(`blocks[${i}]`, 'must be an object');
      return;
    }
    const id = typeof b.id === 'string' ? b.id : '';
    const at = isValidApiId(id) ? `blocks[${id}]` : `blocks[${i}]`;
    if (!isValidApiId(id)) {
      issue(at, `"${String(b.id)}" is not a valid block id (a letter, then letters, digits or _)`);
      return;
    }
    if (ids.has(id)) issue(at, `Block id "${id}" is used twice`);
    ids.add(id);
    const name = text(b.name, `${at}.name`, BLOCK_CATALOG_LIMITS.name, issue, true) ?? id;
    const group = text(b.group, `${at}.group`, BLOCK_CATALOG_LIMITS.group, issue);
    const description = text(
      b.description,
      `${at}.description`,
      BLOCK_CATALOG_LIMITS.description,
      issue,
    );
    const thumbnail = checkThumbnail(b.thumbnail, `${at}.thumbnail`, issue);
    const aliases = idList(b.aliases, `${at}.aliases`, issue, BLOCK_CATALOG_LIMITS.aliases);
    if (aliases?.includes(id)) issue(`${at}.aliases`, 'A block cannot alias its own id');
    const allowedParents = idList(b.allowedParents, `${at}.allowedParents`, issue);
    if (allowedParents?.length === 0) {
      issue(`${at}.allowedParents`, 'names at least one parent, or is left out');
    }
    const fieldsRaw = b.fields ?? [];
    if (!Array.isArray(fieldsRaw)) issue(`${at}.fields`, 'must be a list of field definitions');
    const fields = Array.isArray(fieldsRaw)
      ? normalizeFields(fieldsRaw, `${at}.fields`, issue)
      : [];
    const slots = checkSlots(b.slots, at, issue);
    if (fields.length === 0 && slots.length === 0) {
      issue(at, 'A block needs at least one field or slot');
    }
    for (const s of slots) {
      if (fields.some((f) => f.apiId === s.apiId)) {
        issue(`${at}.slots.${s.apiId}`, `A slot and a field are both named "${s.apiId}"`);
      }
    }
    out.push({
      id,
      name,
      ...(group ? { group } : {}),
      ...(description ? { description } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      ...(aliases?.length ? { aliases } : {}),
      fields,
      ...(slots.length ? { slots } : {}),
      ...(allowedParents?.length ? { allowedParents } : {}),
    });
  });
  // Aliases: each a former id of one block only, and no block's current id.
  const aliasOwner = new Map<string, string>();
  for (const b of out) {
    for (const a of b.aliases ?? []) {
      if (a !== b.id && ids.has(a)) {
        issue(`blocks[${b.id}].aliases`, `"${a}" is the id of another block`);
      }
      const owner = aliasOwner.get(a);
      if (owner) issue(`blocks[${b.id}].aliases`, `"${a}" is already an alias of "${owner}"`);
      aliasOwner.set(a, b.id);
    }
  }
  return out;
}

function checkThumbnail(raw: unknown, at: string, issue: Issue): BlockThumbnail | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isObject(raw) && typeof raw.assetId === 'string' && raw.url === undefined) {
    if (raw.assetId === '' || raw.assetId.length > 64) {
      issue(at, 'assetId must be an asset id');
      return undefined;
    }
    return { assetId: raw.assetId };
  }
  if (isObject(raw) && typeof raw.url === 'string' && raw.assetId === undefined) {
    if (raw.url.length > BLOCK_CATALOG_LIMITS.url) {
      issue(at, `url must be at most ${BLOCK_CATALOG_LIMITS.url} characters`);
      return undefined;
    }
    const url = parseAbsoluteUrl(raw.url);
    if (!url) {
      issue(at, 'url must be an absolute https URL');
      return undefined;
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      issue(at, 'url must be an https URL without credentials');
      return undefined;
    }
    return { url: url.href };
  }
  issue(at, 'must be { "assetId": "…" } or { "url": "https://…" }');
  return undefined;
}

function checkSlots(raw: unknown, at: string, issue: Issue): BlockSlot[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issue(`${at}.slots`, 'must be a list of slots');
    return [];
  }
  if (raw.length > BLOCK_CATALOG_LIMITS.slots) {
    issue(`${at}.slots`, `A block has at most ${BLOCK_CATALOG_LIMITS.slots} slots`);
  }
  const out: BlockSlot[] = [];
  raw.forEach((s, i) => {
    if (!isObject(s)) {
      issue(`${at}.slots[${i}]`, 'must be an object');
      return;
    }
    const apiId = typeof s.apiId === 'string' ? s.apiId : '';
    const where = isValidApiId(apiId) ? `${at}.slots.${apiId}` : `${at}.slots[${i}]`;
    if (!isValidApiId(apiId)) {
      issue(where, `"${String(s.apiId)}" is not a valid slot apiId`);
      return;
    }
    if (out.some((o) => o.apiId === apiId)) issue(where, `Slot "${apiId}" is declared twice`);
    const name = text(s.name, `${where}.name`, BLOCK_CATALOG_LIMITS.name, issue, true) ?? apiId;
    const help = text(s.help, `${where}.help`, BLOCK_CATALOG_LIMITS.help, issue);
    const allowedChildren = idList(s.allowedChildren, `${where}.allowedChildren`, issue) ?? [];
    if (allowedChildren.length === 0) {
      issue(`${where}.allowedChildren`, 'A slot names at least one block it takes');
    }
    const count = (key: 'min' | 'max'): number | undefined => {
      const v = s[key];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        issue(`${where}.${key}`, 'must be a whole number');
        return undefined;
      }
      return v;
    };
    const min = count('min');
    const max = count('max');
    if (max === 0) issue(`${where}.max`, 'must be at least 1');
    if (min !== undefined && max !== undefined && min > max) {
      issue(where, 'min is more than max');
    }
    out.push({
      apiId,
      name,
      ...(help ? { help } : {}),
      allowedChildren,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    });
  });
  return out;
}

function checkTargets(
  raw: unknown,
  blocks: readonly BlockManifest[],
  issue: Issue,
): BlockCatalogTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issue('targets', 'must name at least one { contentTypeApiId, field } the blocks go in');
    return [];
  }
  if (raw.length > BLOCK_CATALOG_LIMITS.targets) {
    issue('targets', `A catalog has at most ${BLOCK_CATALOG_LIMITS.targets} targets`);
  }
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const out: BlockCatalogTarget[] = [];
  raw.forEach((t, i) => {
    const at = `targets[${i}]`;
    if (!isObject(t)) {
      issue(at, 'must be an object');
      return;
    }
    const type = t.contentTypeApiId;
    const field = t.field;
    if (typeof type !== 'string' || !isValidApiId(type)) {
      issue(`${at}.contentTypeApiId`, 'must be a content type apiId');
      return;
    }
    if (typeof field !== 'string' || !isValidApiId(field)) {
      issue(`${at}.field`, 'must be the apiId of a top-level blocks field');
      return;
    }
    if (out.some((o) => o.contentTypeApiId === type && o.field === field)) {
      issue(at, `${type}.${field} is a target twice`);
    }
    const roots = idList(t.blocks, `${at}.blocks`, issue);
    for (const id of roots ?? []) {
      const b = byId.get(id);
      if (blocks.length > 0 && !b) issue(`${at}.blocks`, `No block "${id}" in the catalog`);
      else if (b?.allowedParents) {
        issue(`${at}.blocks`, `"${id}" has allowedParents, so it only goes inside them`);
      }
    }
    if (roots?.length === 0) issue(`${at}.blocks`, 'names at least one block, or is left out');
    out.push({ contentTypeApiId: type, field, ...(roots?.length ? { blocks: roots } : {}) });
  });
  return out;
}

/**
 * Slots and parents name blocks in the catalog and agree with each other, and no block can end
 * up inside itself (a slot cycle would nest without end).
 */
function checkPlacement(blocks: readonly BlockManifest[], issue: Issue): void {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const b of blocks) {
    for (const s of b.slots ?? []) {
      for (const child of s.allowedChildren) {
        const c = byId.get(child);
        if (!c) {
          issue(`blocks[${b.id}].slots.${s.apiId}.allowedChildren`, `No block "${child}"`);
        } else if (c.allowedParents && !c.allowedParents.includes(b.id)) {
          issue(
            `blocks[${b.id}].slots.${s.apiId}.allowedChildren`,
            `"${child}" lists its allowedParents, and "${b.id}" is not one of them`,
          );
        }
      }
    }
    for (const parent of b.allowedParents ?? []) {
      const p = byId.get(parent);
      if (!p) issue(`blocks[${b.id}].allowedParents`, `No block "${parent}"`);
      else if (!(p.slots ?? []).some((s) => s.allowedChildren.includes(b.id))) {
        issue(`blocks[${b.id}].allowedParents`, `"${parent}" has no slot that takes "${b.id}"`);
      }
    }
  }
  // Depth-first, three colours: a block met again while still on the path is a cycle.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string, path: string[]): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') {
      const loop = [...path.slice(path.indexOf(id)), id].join(' → ');
      issue(`blocks[${id}].slots`, `Blocks cannot nest inside themselves: ${loop}`);
      return true;
    }
    state.set(id, 'open');
    for (const s of byId.get(id)?.slots ?? []) {
      for (const child of s.allowedChildren) {
        if (byId.has(child) && visit(child, [...path, id])) return true;
      }
    }
    state.set(id, 'done');
    return false;
  };
  for (const b of blocks) if (visit(b.id, [])) return;
}

/**
 * The guardrails the content model doesn't know: no JSON field (an untyped escape hatch for raw
 * styles), and a field named for styling only as an enumeration of tokens. The rest is the
 * content model's own check: the block, as the variant it becomes (its slots taking a stand-in
 * child each), must be a valid variant of a blocks field.
 */
function checkBlockFields(b: BlockManifest, issue: Issue): void {
  const at = `blocks[${b.id}]`;
  const walk = (fields: readonly FieldDefinition[], prefix: string) => {
    for (const f of fields) {
      const where = `${prefix}.${f.apiId}`;
      if (f.type === 'JSON' || f.items?.type === ('JSON' as never)) {
        issue(
          where,
          'A block prop cannot be JSON: give it a typed field (a token prop is a Symbol with validations.in)',
        );
      }
      if (
        STYLE_FIELD.test(f.apiId) &&
        !(f.validations?.in?.length || f.items?.validations?.in?.length)
      ) {
        issue(
          where,
          `"${f.apiId}" is a style prop, so it must be a token: a Symbol with validations.in`,
        );
      }
      walk(f.fields ?? [], where);
      walk(f.items?.fields ?? [], where);
      for (const v of f.items?.variants ?? []) walk(v.fields, `${where}[${v.apiId}]`);
    }
  };
  walk(b.fields, at);
  const standIn = (id: string): ComponentVariant => ({
    apiId: id,
    name: id,
    fields: [
      {
        apiId: 'value',
        name: 'value',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
  });
  const variant: ComponentVariant = {
    apiId: b.id,
    name: b.name,
    fields: [...b.fields, ...slotFields(b, b.fields.length, (s) => s.allowedChildren.map(standIn))],
  };
  try {
    defineContentType({
      apiId: 'blockCatalog',
      name: 'Block catalog',
      displayField: 'blocks',
      fields: [blocksFieldOf('blocks', [variant])],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      for (const i of err.issues) issue(i.field.replace(/^blocks\[[^\]]+\]/, at), i.message);
    } else if (err instanceof ConflictError) {
      issue(at, err.message);
    } else throw err;
  }
}

const blocksFieldOf = (apiId: string, variants: readonly ComponentVariant[]): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Array',
  localized: false,
  required: false,
  position: 0,
  items: { type: 'Component', variants },
});

/** A block's slots as the nested blocks fields they become, positioned after its fields. */
function slotFields(
  b: BlockManifest,
  from: number,
  children: (s: BlockSlot) => readonly ComponentVariant[],
): FieldDefinition[] {
  return (b.slots ?? []).map((s, i) => {
    const size =
      s.min !== undefined || s.max !== undefined
        ? {
            size: {
              ...(s.min !== undefined ? { min: s.min } : {}),
              ...(s.max !== undefined ? { max: s.max } : {}),
            },
          }
        : {};
    return {
      apiId: s.apiId,
      name: s.name,
      ...(s.help ? { help: s.help } : {}),
      type: 'Array',
      localized: false,
      required: (s.min ?? 0) > 0,
      position: from + i,
      ...(Object.keys(size).length ? { validations: size } : {}),
      items: { type: 'Component', variants: children(s) },
    } satisfies FieldDefinition;
  });
}

/**
 * Fills each field the way the content model stores it, at every depth, so a manifest can leave
 * out `localized`, `required` and `position` and still diff clean against what was pushed.
 */
function normalizeFields(raw: readonly unknown[], at: string, issue: Issue): FieldDefinition[] {
  const out: FieldDefinition[] = [];
  raw.forEach((f, i) => {
    if (!isObject(f) || typeof f.apiId !== 'string' || typeof f.type !== 'string') {
      issue(`${at}[${i}]`, 'A field needs an apiId and a type');
      return;
    }
    const nested = (v: unknown, where: string) =>
      Array.isArray(v) ? normalizeFields(v, where, issue) : v;
    const items = isObject(f.items)
      ? {
          ...f.items,
          ...(Array.isArray(f.items.fields)
            ? { fields: nested(f.items.fields, `${at}.${f.apiId}`) }
            : {}),
          ...(Array.isArray(f.items.variants)
            ? {
                variants: f.items.variants.map((v: unknown) =>
                  isObject(v) ? { ...v, fields: nested(v.fields, `${at}.${f.apiId}`) } : v,
                ),
              }
            : {}),
        }
      : undefined;
    out.push({
      ...(f as unknown as FieldDefinition),
      name: typeof f.name === 'string' ? f.name : f.apiId,
      localized: f.localized === true,
      required: f.required === true,
      position: typeof f.position === 'number' ? f.position : i,
      ...(Array.isArray(f.fields)
        ? { fields: nested(f.fields, `${at}.${f.apiId}`) as FieldDefinition[] }
        : {}),
      ...(items ? { items: items as unknown as FieldDefinition['items'] } : {}),
    });
  });
  return out;
}

// --- mapping a catalog onto content types --------------------------------------------------------

/**
 * The variants a target's blocks field takes from the catalog: its top-level blocks, each with
 * its slots expanded into nested blocks fields of the blocks they allow. Refuses a target whose
 * slots nest deeper than the content model allows, naming the path, and one that would expand
 * past {@link BLOCK_CATALOG_LIMITS}.expandedVariants (a definition no editor could load).
 */
export function catalogVariants(
  blocks: readonly BlockManifest[],
  target: BlockCatalogTarget,
): ComponentVariant[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const roots = target.blocks ?? blocks.filter((b) => !b.allowedParents).map((b) => b.id);
  const where = `${target.contentTypeApiId}.${target.field}`;
  let expanded = 0;
  // `depth` is the component depth of the blocks field holding the variant: the target is 1.
  const toVariant = (b: BlockManifest, depth: number, path: string): ComponentVariant => {
    expanded += 1;
    if (expanded > BLOCK_CATALOG_LIMITS.expandedVariants) {
      throw new ValidationError([
        {
          field: where,
          message: `Its slots expand to more than ${BLOCK_CATALOG_LIMITS.expandedVariants} block variants; allow fewer children per slot`,
        },
      ]);
    }
    const slots = slotFields(b, b.fields.length, (s) => {
      if (depth + 1 > MAX_COMPONENT_DEPTH) {
        throw new ValidationError([
          {
            field: `${path}.${s.apiId}`,
            message: `Slots nest ${MAX_COMPONENT_DEPTH - 1} deep at most below the page; this one is deeper`,
          },
        ]);
      }
      return s.allowedChildren.flatMap((id) => {
        const child = byId.get(id);
        return child ? [toVariant(child, depth + 1, `${path}.${s.apiId}[${id}]`)] : [];
      });
    });
    return {
      apiId: b.id,
      name: b.name,
      fields: [...b.fields, ...slots],
      ...(b.aliases?.length ? { aliases: b.aliases } : {}),
    };
  };
  return roots.flatMap((id) => {
    const b = byId.get(id);
    return b ? [toVariant(b, 1, `${where}[${id}]`)] : [];
  });
}

/** What a push does to one content type's blocks field. */
export interface BlockFieldChange {
  readonly field: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
}

/** One content type a catalog changes: its revised fields and what changed in each target. */
export interface BlockTypePlan {
  readonly contentTypeApiId: string;
  readonly fields: readonly FieldDefinition[];
  readonly changes: readonly BlockFieldChange[];
  /** True when a revision drops a variant or a field some entry might hold. */
  readonly destructive: boolean;
}

/**
 * The content types a catalog changes, each with its fields as they would be: every target
 * field's variants replaced by the catalog's (the catalog owns the whole field: a variant it
 * doesn't provide is removed). Types the catalog leaves as they are aren't listed. Refuses a
 * target type or field that doesn't exist, or a field that isn't a top-level blocks field.
 */
export function planCatalogTypes(
  blocks: readonly BlockManifest[],
  targets: readonly BlockCatalogTarget[],
  types: ReadonlyMap<string, ContentType>,
): BlockTypePlan[] {
  const issues: FieldIssue[] = [];
  const byType = new Map<string, BlockCatalogTarget[]>();
  targets.forEach((t, i) => {
    const type = types.get(t.contentTypeApiId);
    const field = type?.fields.find((f) => f.apiId === t.field);
    if (!type) {
      issues.push({ field: `targets[${i}]`, message: `No content type "${t.contentTypeApiId}"` });
    } else if (!field) {
      issues.push({
        field: `targets[${i}]`,
        message: `${t.contentTypeApiId} has no field "${t.field}"`,
      });
    } else if (!blockVariants(field)) {
      issues.push({
        field: `targets[${i}]`,
        message: `${t.contentTypeApiId}.${t.field} is not a blocks field (an Array of Component with items.variants)`,
      });
    } else {
      byType.set(t.contentTypeApiId, [...(byType.get(t.contentTypeApiId) ?? []), t]);
    }
  });
  if (issues.length > 0) throw new ValidationError(issues);
  const plans: BlockTypePlan[] = [];
  for (const [apiId, list] of byType) {
    const type = types.get(apiId) as ContentType;
    const changes: BlockFieldChange[] = [];
    const fields = type.fields.map((f) => {
      const target = list.find((t) => t.field === f.apiId);
      if (!target || !f.items) return f;
      const before = blockVariants(f) ?? [];
      const after = catalogVariants(blocks, target);
      const change = variantChanges(f.apiId, before, after);
      if (!change) return f;
      changes.push(change);
      return { ...f, items: { ...f.items, variants: after } };
    });
    if (changes.length === 0) continue;
    const destructive =
      removedVariants(type.fields, fields).size > 0 || removedFields(type.fields, fields).size > 0;
    plans.push({ contentTypeApiId: apiId, fields, changes, destructive });
  }
  return plans;
}

/** How `after` differs from `before` at the top of one blocks field, or null when it doesn't. */
function variantChanges(
  field: string,
  before: readonly ComponentVariant[],
  after: readonly ComponentVariant[],
): BlockFieldChange | null {
  const added: string[] = [];
  const changed: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const kept = new Set<string>();
  for (const v of after) {
    const same = before.find((b) => b.apiId === v.apiId);
    const was = same ?? before.find((b) => v.aliases?.includes(b.apiId));
    if (!was) added.push(v.apiId);
    else {
      kept.add(was.apiId);
      if (!same) renamed.push({ from: was.apiId, to: v.apiId });
      else if (canonicalJson(was) !== canonicalJson(v)) changed.push(v.apiId);
    }
  }
  const removed = before.filter((b) => !kept.has(b.apiId)).map((b) => b.apiId);
  const reordered =
    before.length === after.length && before.some((b, i) => b.apiId !== after[i]?.apiId);
  if (!added.length && !changed.length && !removed.length && !renamed.length && !reordered) {
    return null;
  }
  return { field, added, changed, removed, renamed };
}

/**
 * What `next` changes from `previous` (null for the first push), by block id. A block whose
 * `aliases` name a block of `previous` is that block renamed, not a removal and an addition.
 * Refuses an id reused: one `previous` had as a former id (an alias) back as another block's id.
 */
export function diffBlockCatalogs(
  previous: readonly BlockManifest[] | null,
  next: readonly BlockManifest[],
): BlockCatalogChanges {
  const before = new Map((previous ?? []).map((b) => [b.id, b]));
  const retired = new Map<string, string>();
  for (const b of previous ?? []) for (const a of b.aliases ?? []) retired.set(a, b.id);
  const issues: FieldIssue[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const kept = new Set<string>();
  for (const b of next) {
    const owner = retired.get(b.id);
    if (owner !== undefined && !b.aliases?.includes(owner) && owner !== b.id) {
      issues.push({
        field: `blocks[${b.id}]`,
        message: `"${b.id}" was renamed to "${owner}"; a former id is never reused, so pick another`,
      });
    }
    const same = before.get(b.id);
    const was = same ?? (b.aliases ?? []).map((a) => before.get(a)).find(Boolean);
    if (!was) added.push(b.id);
    else {
      kept.add(was.id);
      if (!same) renamed.push({ from: was.id, to: b.id });
      else if (canonicalJson(was) !== canonicalJson(b)) changed.push(b.id);
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
  const removed = [...before.keys()].filter((id) => !kept.has(id));
  return { added, changed, removed, renamed };
}

/**
 * The block ids an entry's values use, at any depth of the type's blocks fields, every locale:
 * what the catalog's usage counts. A block stored under a former id counts as its block.
 */
export function blocksUsed(fields: readonly FieldDefinition[], values: EntryFields): Set<string> {
  const used = new Set<string>();
  const visit = (f: FieldDefinition, value: unknown): void => {
    if (value === undefined || value === null) return;
    const variants = blockVariants(f);
    if (variants) {
      if (!Array.isArray(value)) return;
      for (const item of value) {
        const variant = variantOf(variants, item);
        if (variant) {
          used.add(variant.apiId);
          visitObject(variant.fields, item);
        } else {
          const type = (item as Record<string, unknown> | null)?.[BLOCK_TYPE_KEY];
          if (typeof type === 'string') used.add(type);
        }
      }
    } else if (f.type === 'Component') {
      visitObject(f.fields ?? [], value);
    } else if (f.type === 'Array' && f.items?.type === 'Component' && Array.isArray(value)) {
      for (const item of value) visitObject(f.items.fields ?? [], item);
    }
  };
  const visitObject = (nested: readonly FieldDefinition[], value: unknown): void => {
    if (!isObject(value)) return;
    for (const f of nested) visit(f, value[f.apiId]);
  };
  for (const f of fields) {
    for (const value of Object.values(values[f.apiId] ?? {})) visit(f, value);
  }
  return used;
}

/**
 * The catalog as one canonical JSON string (object keys sorted, list order kept): what its hash
 * is taken over, so the same catalog pushed twice is recognized as unchanged.
 */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v) =>
      isObject(v)
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : v,
    ) ?? 'null'
  );
}
