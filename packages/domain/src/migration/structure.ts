import { type HtmlElement, parseHtml } from '../rich-text/from-html';
import { find, findAll } from './html-tree';

/**
 * What a run reads from a fetched page without running any script: its structure fingerprint
 * (for clustering), its title, and its links (for a crawl). One lenient parse, the same reader
 * rich-text imports use; no DOM.
 */

/** Element levels below the content root a fingerprint looks at. */
const FINGERPRINT_DEPTH = 5;
/** Ancestors (with the element) in one shingle. */
const SHINGLE_LENGTH = 3;
/** Most shingles a fingerprint keeps. */
export const MAX_FINGERPRINT_SHINGLES = 256;
/** Most links read from one page. */
const MAX_PAGE_LINKS = 2_000;

export interface PageFacts {
  readonly title: string | null;
  readonly fingerprint: string[];
  /** Every `a[href]` value as written, in document order, unresolved. */
  readonly hrefs: string[];
}

export function readPageFacts(html: string): PageFacts {
  const root = parseHtml(html);
  return { title: pageTitle(html), fingerprint: fingerprintOf(root), hrefs: hrefsOf(root) };
}

/**
 * A page's structure, as a set of short hashes of tag-and-class paths ("shingles") under its
 * `<main>` (or `<body>`). Pages built from one template share most of their shingles whatever
 * their text, so the Jaccard similarity of two fingerprints says whether they are the same kind
 * of page. Classes that differ page to page for the same structure are dropped: generated ones
 * (three or more digits), state (`is-`, `has-`), modifiers (`--`) and script hooks (`js-`).
 *
 * Sorted, and capped at the {@link MAX_FINGERPRINT_SHINGLES} smallest hashes: a bottom-k sample
 * keeps the similarity of two capped fingerprints close to that of the whole sets.
 */
export function structureFingerprint(html: string): string[] {
  return fingerprintOf(parseHtml(html));
}

function fingerprintOf(root: HtmlElement): string[] {
  const start = find(root, 'main') ?? find(root, 'body') ?? root;
  const out = new Set<string>();
  const walk = (el: HtmlElement, path: readonly string[], depth: number) => {
    const next = [...path, signature(el)].slice(-SHINGLE_LENGTH);
    out.add(fnv1a(next.join('>')));
    if (depth >= FINGERPRINT_DEPTH) return;
    for (const child of el.children) if (typeof child !== 'string') walk(child, next, depth + 1);
  };
  walk(start, [], 0);
  return [...out].sort().slice(0, MAX_FINGERPRINT_SHINGLES);
}

function signature(el: HtmlElement): string {
  const classes = (el.attributes.class ?? '')
    .split(/\s+/)
    .filter((c) => c && c.length <= 40 && !/\d{3,}|^js-|^(is|has)-|--/.test(c))
    .slice(0, 2);
  return classes.length ? `${el.tag}.${classes.join('.')}` : el.tag;
}

/** 32-bit FNV-1a, as 8 hex digits: short, stable and good enough to compare sets. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Every `a[href]` value in the page as written, in document order (what a crawl follows). */
export function pageHrefs(html: string): string[] {
  return hrefsOf(parseHtml(html));
}

function hrefsOf(root: HtmlElement): string[] {
  return findAll(root, (el) => el.tag === 'a' && Boolean(el.attributes.href?.trim()))
    .slice(0, MAX_PAGE_LINKS)
    .map((a) => (a.attributes.href as string).trim());
}

/** The document's `<title>` text (the tree reader drops it as unseen text), trimmed. */
export function pageTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const text = match?.[1]
    ?.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 500) : null;
}
