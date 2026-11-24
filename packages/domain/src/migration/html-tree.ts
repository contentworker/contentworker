import type { HtmlElement, HtmlNode } from '../rich-text/from-html';

// Small reads over the lenient reader's element tree, for the migration module only (not part of
// the domain's exports).

/** The first element named `tag` under `node`, depth first. */
export function find(node: HtmlElement, tag: string): HtmlElement | undefined {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.tag === tag) return child;
    const inner = find(child, tag);
    if (inner) return inner;
  }
  return undefined;
}

/** Every element under `node` (not `node` itself) for which `test` holds, depth first. */
export function findAll(node: HtmlElement, test: (el: HtmlElement) => boolean): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (n: HtmlNode) => {
    if (typeof n === 'string') return;
    for (const child of n.children) {
      if (typeof child === 'string') continue;
      if (test(child)) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/**
 * `node` without the elements `drop` names (and everything in them): a copy, the tree is shared.
 * `drop` sees the tags of the element's ancestors from `node` down, `node`'s own first.
 */
export function without(
  node: HtmlElement,
  drop: (el: HtmlElement, ancestors: readonly string[]) => boolean,
  ancestors: readonly string[] = [node.tag],
): HtmlElement {
  return {
    ...node,
    children: node.children
      .filter((c) => typeof c === 'string' || !drop(c, ancestors))
      .map((c) => (typeof c === 'string' ? c : without(c, drop, [...ancestors, c.tag]))),
  };
}

/** The text under `node`, with a space between text runs so adjacent blocks keep their words apart. */
export function textOf(node: HtmlNode): string {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join(' ');
}
