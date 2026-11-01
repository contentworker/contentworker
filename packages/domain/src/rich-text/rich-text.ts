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

/** Validates a node tree, collecting issue messages (empty when valid). */
export function validateRichText(value: unknown): string[] {
  if (!isRichTextDocument(value))
    return ['Expected a rich-text document { nodeType: "document", content: [] }'];
  const issues: string[] = [];
  const walk = (node: RichTextNode, path: string): void => {
    if (typeof node?.nodeType !== 'string') {
      issues.push(`${path}: node is missing a nodeType`);
      return;
    }
    if (node.nodeType === 'text' && typeof node.value !== 'string') {
      issues.push(`${path}: text node must have a string value`);
    }
    if (isReferenceNodeType(node.nodeType)) {
      const target = node.data?.target;
      if (
        !target ||
        typeof target.id !== 'string' ||
        (target.linkType !== 'Entry' && target.linkType !== 'Asset')
      ) {
        issues.push(`${path}: ${node.nodeType} requires data.target { id, linkType }`);
      }
    }
    node.content?.forEach((child, i) => {
      walk(child, `${path}.content[${i}]`);
    });
  };
  value.content.forEach((node, i) => {
    walk(node, `content[${i}]`);
  });
  return issues;
}

/**
 * Flattens a rich-text value to plain text. Text within a block is concatenated;
 * blocks are joined with blank lines. Reference nodes contribute nothing (the
 * domain has no access to their display names). Non-documents yield `''`.
 */
const INLINE_NODE_TYPES = new Set([
  'text',
  'hard-break',
  'hyperlink',
  'entry-hyperlink',
  'asset-hyperlink',
  'embedded-entry-inline',
]);

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
