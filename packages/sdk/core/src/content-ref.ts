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
  /**
   * The field's path: its apiId (`title`), or inside blocks, the blocks field with each block's
   * `_key` in brackets (`body[0192f…].heading`, `body[0192f…]` for the block itself). See
   * {@link formatFieldPath}. A key, not an index, names each block, so a path still points at the
   * same block after a reorder.
   */
  readonly field: string;
  readonly locale: string;
}

/** One step of a field path below its top-level field: into a block by key, or a field by name. */
export type FieldPathStep = { readonly key: string } | { readonly field: string };

/** A field path, parsed: the entry's top-level field, then each step down. */
export interface FieldPath {
  readonly field: string;
  readonly steps: readonly FieldPathStep[];
}

const NAME = /^[^.[\]]+$/;
const KEY = /^[^[\]]+$/;

/**
 * A field path as a ref carries it, in the notation of `patchBlocks`'s paths with keys in place of
 * indexes: `body`, `body[k1]`, `body[k1].heading`, `body[k1].items[k2].label`. Throws on a name
 * holding `.`, `[` or `]`, or a key holding a bracket: those would make a path that parses as a
 * different one.
 */
export function formatFieldPath(path: FieldPath): string {
  if (!NAME.test(path.field)) throw new Error(`Not a field name: ${path.field}`);
  let out = path.field;
  for (const step of path.steps) {
    if ('key' in step) {
      if (!KEY.test(step.key)) throw new Error(`Not a block key: ${step.key}`);
      out += `[${step.key}]`;
    } else {
      if (!NAME.test(step.field)) throw new Error(`Not a field name: ${step.field}`);
      out += `.${step.field}`;
    }
  }
  return out;
}

/**
 * Parses a ref's field part. A plain apiId (every ref written before paths) parses as a path with
 * no steps. Undefined when it isn't a path: a field step must follow a block, and a block a field.
 */
export function parseFieldPath(value: string): FieldPath | undefined {
  const head = /^[^.[\]]+/.exec(value);
  if (!head) return undefined;
  const steps: FieldPathStep[] = [];
  let rest = value.slice(head[0].length);
  let last: 'field' | 'key' = 'field';
  while (rest !== '') {
    const block = /^\[([^[\]]+)\]/.exec(rest);
    const field = /^\.([^.[\]]+)/.exec(rest);
    if (block && last === 'field') {
      steps.push({ key: block[1] as string });
      last = 'key';
      rest = rest.slice(block[0].length);
    } else if (field && last === 'key') {
      steps.push({ field: field[1] as string });
      last = 'field';
      rest = rest.slice(field[0].length);
    } else {
      return undefined;
    }
  }
  return { field: head[0], steps };
}

/**
 * The top-level field a path is in: everything before the first `[`. What the entry form opens
 * when it is given a path it can't follow further.
 */
export function topLevelField(path: string): string {
  const bracket = path.indexOf('[');
  return bracket < 0 ? path : path.slice(0, bracket);
}

/** The `_key` of the block a path names, when it names a block itself (`body[k1]`). */
export function blockKeyOf(path: string): string | undefined {
  const parsed = parseFieldPath(path);
  const last = parsed?.steps.at(-1);
  return last && 'key' in last ? last.key : undefined;
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
 * The admin URL that opens a ref for editing. A path passes through whole as `?field=`; the entry
 * form opens the top-level field before its first `[` when it can't follow the path further.
 */
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
