/**
 * Structured rich text — a document tree. A value is a `document` node whose `content` is a tree
 * of block and inline nodes. Text lives in `text` nodes carrying `marks`
 * (bold/italic/…); entries and assets are embedded or linked through nodes that
 * carry a `data.target` link, so the reference graph can be extracted from rich
 * text exactly as it is from `Link` fields.
 */

import type { LinkType } from '../content-type/field';

/** Node types that embed or link another entry/asset (carry `data.target`). */
export const REFERENCE_NODE_TYPES = [
  'embedded-entry-block',
  'embedded-asset-block',
  'embedded-entry-inline',
  'entry-hyperlink',
  'asset-hyperlink',
] as const;
export type ReferenceNodeType = (typeof REFERENCE_NODE_TYPES)[number];

/** A mark applied to a text node (e.g. `{ type: 'bold' }`). */
export interface RichTextMark {
  readonly type: string;
}

/** A link target embedded in a reference node. */
export interface RichTextTarget {
  readonly id: string;
  readonly linkType: LinkType;
}

export interface RichTextNode {
  readonly nodeType: string;
  /** Block/inline children. */
  readonly content?: readonly RichTextNode[];
  /** Literal text (present on `text` nodes). */
  readonly value?: string;
  readonly marks?: readonly RichTextMark[];
  /** Arbitrary node data; reference nodes put their link under `target`. */
  readonly data?: { readonly target?: RichTextTarget } & Record<string, unknown>;
}

/** The root of a rich-text value. */
export interface RichTextDocument {
  readonly nodeType: 'document';
  readonly content: readonly RichTextNode[];
  readonly data?: Record<string, unknown>;
}

/** Type guard: is `value` a well-formed rich-text document root? */
export function isRichTextDocument(value: unknown): value is RichTextDocument {
  const d = value as { nodeType?: unknown; content?: unknown };
  return (
    typeof d === 'object' && d !== null && d.nodeType === 'document' && Array.isArray(d.content)
  );
}

function isReferenceNodeType(nodeType: string): nodeType is ReferenceNodeType {
  return (REFERENCE_NODE_TYPES as readonly string[]).includes(nodeType);
}

/**
 * Block node types: what a `document` and the block containers (lists, list
 * items, quotes, tables) hold. The table nodes are accepted here so documents
 * carrying them validate; their structure is not yet constrained.
 */
export const RICH_TEXT_BLOCK_NODE_TYPES = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
  'blockquote',
  'code-block',
  'hr',
  'unordered-list',
  'ordered-list',
  'list-item',
  'embedded-entry-block',
  'embedded-asset-block',
  'table',
  'table-row',
  'table-header-cell',
  'table-cell',
] as const;

/** Inline node types: what a block's text runs are made of. */
export const RICH_TEXT_INLINE_NODE_TYPES = [
  'text',
  'hard-break',
  'hyperlink',
  'entry-hyperlink',
  'asset-hyperlink',
  'embedded-entry-inline',
] as const;

/**
 * Every node type a stored document may contain below its root. Delivery
 * clients render rich text by switching on `nodeType`, so a type outside this
 * vocabulary is refused on write rather than handed to a renderer that cannot
 * know what it means.
 */
export const RICH_TEXT_NODE_TYPES: ReadonlySet<string> = new Set([
  ...RICH_TEXT_BLOCK_NODE_TYPES,
  ...RICH_TEXT_INLINE_NODE_TYPES,
]);

/**
 * Max serialized size of one rich-text value (per locale), measured as the
 * JSON field cap is (serialized length). Twice that cap: a document spends most of its bytes on node
 * structure, so the same prose takes several times its plain length. A long
 * article with its markup is well under this.
 */
export const MAX_RICH_TEXT_BYTES = 512 * 1024;

/**
 * Max nesting of nodes below the root. Every reader (validation, plain text,
 * reference extraction, delivery's link resolution, the editor) walks the tree
 * recursively, so a pathological depth must stop at the door. Deeply nested
 * lists use two levels each (list, item); real content stays far inside this.
 */
export const MAX_RICH_TEXT_DEPTH = 64;

/** Schemes a hyperlink may carry. Anything else — `javascript:`, `data:`, `vbscript:` — is not a link. */
const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * The URI, if it is safe to store as a link; otherwise `undefined`.
 *
 * Delivered rich text is rendered by clients that trust a hyperlink's `uri`,
 * so no write — an HTML import, the editor, an API client or an agent — may
 * store a script link. Relative and fragment URIs have no scheme and are kept.
 */
export function safeLinkUri(raw: string | undefined): string | undefined {
  // Browsers ignore whitespace and control characters inside a scheme
  // (`java\tscript:`), so the check reads the URI the way they do.
  const uri = raw?.trim();
  if (!uri) return undefined;
  const scheme = /^([^/?#]*?):/.exec(
    [...uri].filter((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f).join(''),
  )?.[1];
  // An entity left undecoded can hide a scheme's colon (`javascript&colon;`)
  // from the check while a careless renderer decodes it, so a `&` before the
  // path starts makes the URI unusable rather than relative.
  if (/^[^/?#]*&/.test(uri)) return undefined;
  if (scheme === undefined) return uri;
  return SAFE_LINK_SCHEMES.has(scheme.toLowerCase()) ? uri : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a node tree, collecting issue messages (empty when valid). */
export function validateRichText(value: unknown): string[] {
  if (!isRichTextDocument(value))
    return ['Expected a rich-text document { nodeType: "document", content: [] }'];
  // Size first: it bounds the walk below, and a structure too deep to
  // serialize is refused here rather than overflowing a reader later.
  try {
    if (JSON.stringify(value).length > MAX_RICH_TEXT_BYTES)
      return [`Rich text exceeds ${MAX_RICH_TEXT_BYTES} bytes`];
  } catch {
    return ['Rich text is not serializable'];
  }
  const issues: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_RICH_TEXT_DEPTH) {
      issues.push(`${path}: nodes nest more than ${MAX_RICH_TEXT_DEPTH} deep`);
      return;
    }
    if (!isObject(node) || typeof node.nodeType !== 'string') {
      issues.push(`${path}: node is missing a nodeType`);
      return;
    }
    const { nodeType, data, content } = node;
    if (!RICH_TEXT_NODE_TYPES.has(nodeType)) {
      issues.push(`${path}: unknown nodeType "${nodeType}"`);
      return;
    }
    if (data !== undefined && !isObject(data)) {
      issues.push(`${path}: data must be an object`);
      return;
    }
    if (content !== undefined && !Array.isArray(content)) {
      issues.push(`${path}: content must be an array`);
      return;
    }
    if (nodeType === 'text' && typeof node.value !== 'string') {
      issues.push(`${path}: text node must have a string value`);
    }
    if (nodeType === 'hyperlink') {
      const uri = data?.uri;
      if (typeof uri !== 'string' || safeLinkUri(uri) === undefined) {
        issues.push(`${path}: hyperlink requires data.uri with an http, https, mailto or tel URI`);
      }
    }
    if (isReferenceNodeType(nodeType)) {
      const target = data?.target as Partial<RichTextTarget> | undefined;
      if (
        !isObject(target) ||
        typeof target.id !== 'string' ||
        (target.linkType !== 'Entry' && target.linkType !== 'Asset')
      ) {
        issues.push(`${path}: ${nodeType} requires data.target { id, linkType }`);
      }
    }
    content?.forEach((child, i) => {
      walk(child, `${path}.content[${i}]`, depth + 1);
    });
  };
  value.content.forEach((node, i) => {
    walk(node, `content[${i}]`, 1);
  });
  return issues;
}

/**
 * Flattens a rich-text value to plain text. Text within a block is concatenated;
 * blocks are joined with blank lines. Reference nodes contribute nothing (the
 * domain has no access to their display names). Non-documents yield `''`.
 */
const INLINE_NODE_TYPES: ReadonlySet<string> = new Set(RICH_TEXT_INLINE_NODE_TYPES);

export function richTextToPlainText(value: unknown): string {
  if (!isRichTextDocument(value)) return '';
  const inlineText = (node: RichTextNode): string => {
    if (node.nodeType === 'text') return node.value ?? '';
    if (node.nodeType === 'hard-break') return '\n';
    return (node.content ?? []).map(inlineText).join('');
  };
  // A node is a leaf block when any direct child is inline — its whole
  // subtree (including inline nodes such as hyperlinks) reads as one block.
  const isLeafBlock = (node: RichTextNode): boolean =>
    (node.content ?? []).some((c) => INLINE_NODE_TYPES.has(c.nodeType));
  const blocks: string[] = [];
  const walk = (node: RichTextNode): void => {
    if (node.nodeType === 'text' || isLeafBlock(node)) {
      const text = inlineText(node).trim();
      if (text) blocks.push(text);
      return;
    }
    node.content?.forEach(walk);
  };
  value.content.forEach(walk);
  return blocks.join('\n\n');
}

/** Extracts every embedded entry/asset target in a rich-text value. */
export function extractRichTextTargets(value: unknown): RichTextTarget[] {
  if (!isRichTextDocument(value)) return [];
  const out: RichTextTarget[] = [];
  const walk = (node: RichTextNode): void => {
    if (isReferenceNodeType(node.nodeType)) {
      const t = node.data?.target;
      if (t && typeof t.id === 'string' && (t.linkType === 'Entry' || t.linkType === 'Asset')) {
        out.push({ id: t.id, linkType: t.linkType });
      }
    }
    node.content?.forEach(walk);
  };
  value.content.forEach(walk);
  return out;
}
