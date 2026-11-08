/**
 * Content refs: the identity of one editable value on a rendered page.
 *
 * A ref names a single field of a single entry in a single locale, which is
 * everything an editor needs to open the right screen with the right thing
 * focused. It is stamped onto rendered markup as `data-cw-ref` so an overlay
 * can map a click on a heading back to the field the heading came from.
 *
 * Refs are derived on the client rather than served in delivery payloads. The
 * space, environment and locale are already known to whoever configured the
 * client, and the entry id and content type are already in the response — so
 * asking the API to repeat all five on every field of every entry would add
 * weight to the hottest read path in the product to carry nothing new.
 */

/** The identity of one editable value. */
export interface ContentRef {
  readonly space: string;
  readonly environment: string;
  readonly entryId: string;
  readonly contentType: string;
  /** apiId of the field, e.g. `title`. */
  readonly field: string;
  readonly locale: string;
}

/** The attribute name carrying a serialized ref. */
export const CONTENT_REF_ATTRIBUTE = 'data-cw-ref';

// `|` and not, say, `~` or `.`: encodeURIComponent leaves the unreserved
// characters untouched, so only a separator it does escape can be relied on to
// survive inside a part.
const SEPARATOR = '|';

/**
 * Serializes a ref for the DOM.
 *
 * Each part is URI-encoded, so a locale or apiId containing the separator
 * cannot forge a boundary and shift every following part by one — which would
 * silently address a different field rather than fail.
 */
export function formatContentRef(ref: ContentRef): string {
  return [ref.space, ref.environment, ref.entryId, ref.contentType, ref.field, ref.locale]
    .map(encodeURIComponent)
    .join(SEPARATOR);
}

/** Parses a serialized ref, or returns undefined if it is not one. */
export function parseContentRef(value: string | null | undefined): ContentRef | undefined {
  if (!value) return undefined;
  const parts = value.split(SEPARATOR).map(decodeURIComponent);
  if (parts.length !== 6 || parts.some((p) => p === '')) return undefined;
  const [space, environment, entryId, contentType, field, locale] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return { space, environment, entryId, contentType, field, locale };
}

/**
 * One step of a field path: a field's apiId, and, when the field holds blocks,
 * the `_key` of the block the path continues into.
 */
export interface FieldPathStep {
  readonly field: string;
  readonly key?: string;
}

const API_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCK_KEY = /^[A-Za-z0-9_-]+$/;
const STEP = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([A-Za-z0-9_-]+)\])?$/;

/**
 * Formats a path to a value inside blocks, for a ref's `field`:
 * `body[<key>].heading`. A block is named by its `_key`, never its index, so
 * the path still points at the same block after a reorder.
 *
 * A ref keeps its six parts, so a parser that predates paths reads the whole
 * path as a field name, and `adminEditUrl` passes it through unchanged.
 */
export function formatFieldPath(steps: readonly FieldPathStep[]): string {
  if (steps.length === 0) throw new Error('A field path needs at least one step.');
  return steps
    .map((s, i) => {
      if (!API_ID.test(s.field)) throw new Error(`Not a field apiId: ${s.field}`);
      if (s.key !== undefined && !BLOCK_KEY.test(s.key)) {
        throw new Error(`Not a block key: ${s.key}`);
      }
      if (s.key === undefined && i < steps.length - 1) {
        throw new Error(`${s.field} needs a block key to continue the path.`);
      }
      return s.key === undefined ? s.field : `${s.field}[${s.key}]`;
    })
    .join('.');
}

/** Parses a ref's `field` into path steps, or returns undefined if it isn't a path. */
export function parseFieldPath(field: string): FieldPathStep[] | undefined {
  const parts = field.split('.');
  const steps: FieldPathStep[] = [];
  for (const [i, part] of parts.entries()) {
    const m = STEP.exec(part);
    if (!m) return undefined;
    const [, name, key] = m as unknown as [string, string, string | undefined];
    if (key === undefined && i < parts.length - 1) return undefined;
    steps.push(key === undefined ? { field: name } : { field: name, key });
  }
  return steps;
}

/** The top-level field a ref's `field` path starts at: `body[k].heading` → `body`. */
export function topLevelField(field: string): string {
  const end = field.search(/[[.]/);
  return end === -1 ? field : field.slice(0, end);
}

/** The admin URL that opens a ref for editing. */
export function adminEditUrl(adminUrl: string, ref: ContentRef): string {
  const base = adminUrl.replace(/\/$/, '');
  const params = new URLSearchParams({
    field: ref.field,
    locale: ref.locale,
    space: ref.space,
    env: ref.environment,
  });
  return `${base}/content/${encodeURIComponent(ref.contentType)}/${encodeURIComponent(ref.entryId)}?${params}`;
}
