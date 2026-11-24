import type { ContentType } from '../content-type/content-type';
import { blockVariants, type FieldDefinition } from '../content-type/field';
import { type RichTextFromHtmlOptions, richTextFromHtml } from '../rich-text/from-html';

/**
 * What a template's import script returns for one page: the template content type's top-level
 * fields, its body as blocks (component variants and their fields), and the assets and links the
 * page holds.
 *
 * Field values are the field types' own values, with two markers for what a script can't know
 * from inside the sandbox:
 *
 * - `{ $html: "<p>…</p>" }` ({@link ImportScriptHtml}) for a rich-text value, as the fragment the
 *   page holds. It is converted with `richTextFromHtml` ({@link resolveImportScriptOutput})
 *   whenever the output is read: without resolvers to score or preview it, and at load with the
 *   run's assets and entries, so an image becomes an `embedded-asset-block` and a link to a
 *   migrated page an `entry-hyperlink`. A `RichTextDocument` is taken as it is.
 * - `{ $asset: "https://…/a.png" }` ({@link ImportScriptAssetRef}) for an asset link field (or an
 *   element of a list of them): the file's URL, which the load turns into the asset created from
 *   it.
 *
 * The fragments stay in the stored output artifact, the script's return value in object storage,
 * because only the load knows the ids they resolve to. Nothing read out of it carries markup: a
 * score, a preview and an entry each hold the converted documents.
 */
export interface ImportScriptOutput {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly blocks: readonly ImportScriptBlock[];
  readonly assets: readonly ImportScriptAsset[];
  readonly links: readonly ImportScriptLink[];
}

export interface ImportScriptBlock {
  /** The component variant's name in the content type's blocks field. */
  readonly variant: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ImportScriptAsset {
  /** Absolute URL of the file on the source site. */
  readonly url: string;
  readonly alt?: string;
}

export interface ImportScriptLink {
  readonly href: string;
}

export const IMPORT_SCRIPT_MAX_BLOCKS = 500;
export const IMPORT_SCRIPT_MAX_ASSETS = 1_000;
export const IMPORT_SCRIPT_MAX_LINKS = 5_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What is wrong with a script's return value as an {@link ImportScriptOutput}, as messages naming
 * the path; empty when it has the shape. The content type's own field rules are checked after.
 */
export function importScriptOutputIssues(value: unknown): string[] {
  if (!isRecord(value))
    return ['the script must return an object { fields, blocks, assets, links }'];
  const issues: string[] = [];
  if (!isRecord(value.fields)) issues.push('fields: must be an object of field values');
  const list = (name: 'blocks' | 'assets' | 'links', max: number): unknown[] => {
    const v = value[name];
    if (!Array.isArray(v)) {
      issues.push(`${name}: must be a list`);
      return [];
    }
    if (v.length > max) issues.push(`${name}: at most ${max} items, got ${v.length}`);
    return v.slice(0, max);
  };
  list('blocks', IMPORT_SCRIPT_MAX_BLOCKS).forEach((b, i) => {
    if (!isRecord(b) || typeof b.variant !== 'string' || !b.variant.trim()) {
      issues.push(`blocks[${i}].variant: must name a component variant`);
    } else if (!isRecord(b.fields)) {
      issues.push(`blocks[${i}].fields: must be an object of field values`);
    }
  });
  list('assets', IMPORT_SCRIPT_MAX_ASSETS).forEach((a, i) => {
    if (!isRecord(a) || typeof a.url !== 'string') issues.push(`assets[${i}].url: must be a URL`);
    else if (a.alt !== undefined && typeof a.alt !== 'string') {
      issues.push(`assets[${i}].alt: must be text`);
    }
  });
  list('links', IMPORT_SCRIPT_MAX_LINKS).forEach((l, i) => {
    if (!isRecord(l) || typeof l.href !== 'string') issues.push(`links[${i}].href: must be a URL`);
  });
  return issues;
}

/** A rich-text value as an import script hands it back: the page's HTML fragment. */
export interface ImportScriptHtml {
  readonly $html: string;
}

/** An asset link as an import script hands it back: the file's URL on the source site. */
export interface ImportScriptAssetRef {
  readonly $asset: string;
}

const isMarker = <K extends string>(v: unknown, key: K): v is Record<K, string> =>
  isRecord(v) && typeof v[key] === 'string' && Object.keys(v).length === 1;

export const isImportScriptHtml = (v: unknown): v is ImportScriptHtml => isMarker(v, '$html');
export const isImportScriptAssetRef = (v: unknown): v is ImportScriptAssetRef =>
  isMarker(v, '$asset');

/** What a load resolves an output against: the rich-text resolvers, and the `$asset` URLs. */
export interface ImportScriptResolvers extends RichTextFromHtmlOptions {
  /** The asset created from a `$asset` URL (as written); `undefined` leaves the value out. */
  readonly resolveAssetRef?: (url: string) => { readonly id: string } | undefined;
}

/**
 * The output with its markers resolved, however deep they sit (a component's fields, a list's
 * elements): every `$html` becomes a `RichTextDocument` (`richTextFromHtml` with the resolvers),
 * and every `$asset` an asset link, or nothing when it doesn't resolve (a list drops it; a field
 * is left unset, so a required one is reported). Without resolvers, images and links stay as
 * `richTextFromHtml` leaves them, which is what a score or a preview reads.
 */
export function resolveImportScriptOutput(
  output: ImportScriptOutput,
  r: ImportScriptResolvers = {},
): ImportScriptOutput {
  return {
    ...output,
    fields: resolveRecord(output.fields, r),
    blocks: output.blocks.map((b) => ({ ...b, fields: resolveRecord(b.fields, r) })),
  };
}

function resolveRecord(
  fields: Readonly<Record<string, unknown>>,
  r: ImportScriptResolvers,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const resolved = resolveValue(value, r);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

function resolveValue(value: unknown, r: ImportScriptResolvers): unknown {
  if (isImportScriptHtml(value)) return richTextFromHtml(value.$html, r);
  if (isImportScriptAssetRef(value)) {
    const asset = r.resolveAssetRef?.(value.$asset);
    return asset ? { id: asset.id, linkType: 'Asset' } : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, r)).filter((v) => v !== undefined);
  }
  return isRecord(value) ? resolveRecord(value, r) : value;
}

/**
 * Every asset URL the output names, as written: its `assets` list and its `$asset` values. These
 * are what a load creates assets from; an image in a fragment resolves only when its URL is one.
 */
export function importScriptAssetUrls(output: ImportScriptOutput): string[] {
  const urls = new Set(output.assets.map((a) => a.url));
  const visit = (value: unknown): void => {
    if (isImportScriptAssetRef(value)) urls.add(value.$asset);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value) && !isImportScriptHtml(value)) Object.values(value).forEach(visit);
  };
  visit(output.fields);
  for (const b of output.blocks) visit(b.fields);
  return [...urls];
}

/** The parts of a field definition a value is checked against: a field, or a list's element. */
interface ValueShape {
  readonly type: string;
  readonly linkType?: string;
  readonly fields?: readonly FieldDefinition[];
  readonly items?: FieldDefinition['items'];
}

/** An element tag (`<p>`, `</div>`, `<br/>`): text that holds one is markup, not prose. */
const ELEMENT_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;

/**
 * What is wrong with the output's values for the content type it is loaded into, as messages
 * naming the path; empty when nothing is. The markers go only where they become what the field
 * holds: `$html` in a `RichText` field, `$asset` in an asset link (or a list of them). A marker
 * with other keys beside it is refused rather than read as an object, and so is a `Symbol` or
 * `Text` value that holds an element tag: markup handed back as plain text would be stored as
 * markup. (Prose with a bare `<`, as in `a < b`, is no tag and passes.) Fields and variants the
 * type doesn't define aren't judged here, only the markers in them: the planner refuses those.
 */
export function importScriptValueIssues(
  output: ImportScriptOutput,
  contentType: Pick<ContentType, 'fields'>,
): string[] {
  const issues: string[] = [];
  const byId = (defs: readonly FieldDefinition[] | undefined, apiId: string) =>
    defs?.find((f) => f.apiId === apiId);
  for (const [apiId, value] of Object.entries(output.fields)) {
    checkValue(value, byId(contentType.fields, apiId), `fields.${apiId}`, issues);
  }
  const blocks = contentType.fields.map(blockVariants).find((v) => v !== undefined);
  output.blocks.forEach((block, i) => {
    const variant = blocks?.find((v) => v.apiId === block.variant);
    for (const [apiId, value] of Object.entries(block.fields)) {
      checkValue(value, byId(variant?.fields, apiId), `blocks[${i}].${apiId}`, issues);
    }
  });
  return issues;
}

function checkValue(
  value: unknown,
  shape: ValueShape | undefined,
  path: string,
  issues: string[],
): void {
  if (isRecord(value) && (Object.hasOwn(value, '$html') || Object.hasOwn(value, '$asset'))) {
    if (isImportScriptHtml(value)) {
      if (shape?.type !== 'RichText') issues.push(`${path}: $html goes only in a RichText field`);
    } else if (isImportScriptAssetRef(value)) {
      if (shape?.type !== 'Link' || shape.linkType !== 'Asset') {
        issues.push(`${path}: $asset goes only in an asset link field`);
      }
    } else {
      issues.push(`${path}: a $html or $asset marker is an object with that one key, as text`);
    }
    return;
  }
  if (typeof value === 'string') {
    if ((shape?.type === 'Symbol' || shape?.type === 'Text') && ELEMENT_TAG.test(value)) {
      issues.push(`${path}: holds markup; hand rich text back as { $html } in a RichText field`);
    }
    return;
  }
  if (Array.isArray(value)) {
    const items = shape?.type === 'Array' ? shape.items : undefined;
    value.forEach((element, i) => {
      let each: ValueShape | undefined = items;
      if (items?.variants) {
        const type = isRecord(element) ? element._type : undefined;
        const variant = items.variants.find((v) => v.apiId === type);
        each = variant ? { type: 'Component', fields: variant.fields } : undefined;
      }
      checkValue(element, each, `${path}[${i}]`, issues);
    });
    return;
  }
  if (!isRecord(value)) return;
  const fields = shape?.type === 'Component' ? shape.fields : undefined;
  for (const [key, inner] of Object.entries(value)) {
    checkValue(
      inner,
      fields?.find((f) => f.apiId === key),
      `${path}.${key}`,
      issues,
    );
  }
}
