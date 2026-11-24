import { parseHtml } from '../rich-text/from-html';
import { isRichTextDocument, type RichTextNode, richTextToPlainText } from '../rich-text/rich-text';
import { find, findAll, textOf, without } from './html-tree';
import { type ImportScriptOutput, resolveImportScriptOutput } from './import-script';
import type { MigrationScore } from './migration';

/**
 * Scoring a page's structured output against its source: how much of what a reader saw survived.
 *
 * - **Text coverage**: the share of the source's content words (three or more letters or digits,
 *   case- and accent-folded) found anywhere in the output's text: its field values, its blocks'
 *   field values, and the text of every rich-text document in them. Site chrome (header, footer,
 *   navigation, hidden and widget text) is not content and is left out of the source first.
 * - **Merged words**: an output word that is two source words run together ("Surf" + "Camp" →
 *   "surfcamp") means the script joined text across elements.
 * - **Lost links**: a page with four or more content links whose output keeps fewer than half.
 * - **Images**: an output asset with no URL, and content images in the source with no asset (or
 *   embedded asset) in the output.
 *
 * Pure: the domain cannot fetch the assets or resolve the links, only count them.
 */

/**
 * Elements that are site chrome rather than the page's content. A header or footer inside `main`
 * or an `article` is the content's own (its title, its byline), so only those outside go.
 */
const CHROME_TAGS = new Set(['nav', 'template', 'noscript']);
const FRAME_TAGS = new Set(['header', 'footer']);
/**
 * Interface text: form labels, buttons, status panels. Not authored content. Not `form` itself:
 * some sites wrap the whole page in one.
 */
const WIDGET_TAGS = new Set(['button', 'label', 'select', 'textarea', 'input', 'dialog']);
const WIDGET_ROLES = new Set(['navigation', 'status', 'dialog', 'alert', 'search']);
/** Keys whose values are addresses, not text a reader sees. */
const ADDRESS_KEYS = new Set(['url', 'href', 'src', 'uri']);
/** The longest output word checked for being two source words run together. */
const MAX_MERGED_WORD = 64;

export function scoreImportOutput(sourceHtml: string, output: ImportScriptOutput): MigrationScore {
  const parsed = parseHtml(sourceHtml);
  const content = without(find(parsed, 'main') ?? find(parsed, 'body') ?? parsed, isChrome);
  const issues: string[] = [];

  const sourceWords = wordsOf(textOf(content));
  // `$html` fragments are read as the documents they become, so their text counts and no tag does.
  const out = collectOutput(resolveImportScriptOutput(output));
  const outputWords = new Set(wordsOf(out.text.join(' ')));
  const covered = sourceWords.filter((w) => outputWords.has(w)).length;
  const textCoverage = sourceWords.length ? covered / sourceWords.length : 1;
  if (out.text.length === 0) issues.push('the output has no text');
  if (textCoverage < 0.8) issues.push(`text coverage ${(textCoverage * 100).toFixed(0)}%`);

  const sourceSet = new Set(sourceWords);
  const merged = new Set<string>();
  for (const w of outputWords) {
    // Words past MAX_MERGED_WORD aren't two words run together, and the check is quadratic in a
    // word's length, which the page decides.
    if (sourceSet.has(w) || w.length < 6 || w.length > MAX_MERGED_WORD) continue;
    for (let i = 3; i <= w.length - 3; i += 1) {
      if (sourceSet.has(w.slice(0, i)) && sourceSet.has(w.slice(i))) {
        merged.add(w);
        break;
      }
    }
  }
  if (merged.size) {
    issues.push(`text ran together across elements: ${[...merged].slice(0, 5).join(', ')}`);
  }

  const sourceLinks = findAll(
    content,
    (el) => el.tag === 'a' && isContentLink(el.attributes.href),
  ).length;
  const outputLinks = output.links.length + out.links;
  const linksLost = sourceLinks >= 4 && outputLinks < sourceLinks / 2;
  if (linksLost) issues.push(`links lost: ${outputLinks} of ${sourceLinks} kept`);

  const imagesMissing = output.assets.filter((a) => !a.url.trim()).length;
  if (imagesMissing) issues.push(`${imagesMissing} asset(s) without a URL`);
  const sourceImages = new Set(
    findAll(content, (el) => el.tag === 'img')
      .map((img) => (img.attributes.src || img.attributes['data-src'] || '').trim())
      .filter((src) => src && !src.startsWith('data:')),
  ).size;
  const imagesLost = Math.max(
    0,
    sourceImages - (output.assets.length - imagesMissing) - out.images,
  );
  if (imagesLost) issues.push(`${imagesLost} of ${sourceImages} image(s) not in the output`);

  const overall =
    textCoverage -
    0.1 * imagesMissing -
    Math.min(0.2, 0.05 * imagesLost) -
    Math.min(0.25, 0.05 * merged.size) -
    (linksLost ? 0.15 : 0);
  return {
    overall: round(Math.max(0, Math.min(1, overall))),
    textCoverage: round(textCoverage),
    imagesMissing,
    imagesLost,
    sourceLinks,
    outputLinks,
    issues,
  };
}

function isChrome(
  el: { tag: string; attributes: Readonly<Record<string, string>> },
  ancestors: readonly string[],
): boolean {
  if (CHROME_TAGS.has(el.tag) || WIDGET_TAGS.has(el.tag)) return true;
  if (FRAME_TAGS.has(el.tag) && !ancestors.some((t) => t === 'main' || t === 'article')) {
    return true;
  }
  const a = el.attributes;
  return (
    'hidden' in a ||
    a['aria-hidden'] === 'true' ||
    'aria-live' in a ||
    WIDGET_ROLES.has((a.role ?? '').toLowerCase())
  );
}

/** A link a reader follows to content: not an in-page anchor, not script. */
function isContentLink(href: string | undefined): boolean {
  const h = href?.trim() ?? '';
  return /^(https?:|\/|\.\.?\/|[a-z0-9])/i.test(h) && !/^javascript:/i.test(h);
}

function wordsOf(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .match(/[\p{L}\p{N}]{3,}/gu) ?? []
  );
}

/** The output's text, and the links and embedded assets its rich text holds. */
function collectOutput(output: ImportScriptOutput): {
  text: string[];
  links: number;
  images: number;
} {
  const acc = { text: [] as string[], links: 0, images: 0 };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.trim()) acc.text.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (isRichTextDocument(value)) {
      const text = richTextToPlainText(value);
      if (text.trim()) acc.text.push(text);
      countRichText(value.content, acc);
      return;
    }
    for (const [key, v] of Object.entries(value)) {
      if (!ADDRESS_KEYS.has(key)) visit(v, depth + 1);
    }
  };
  visit(output.fields, 0);
  for (const block of output.blocks) visit(block.fields, 0);
  return acc;
}

function countRichText(
  nodes: readonly RichTextNode[],
  acc: { links: number; images: number },
): void {
  for (const node of nodes) {
    if (
      node.nodeType === 'hyperlink' ||
      node.nodeType === 'entry-hyperlink' ||
      node.nodeType === 'asset-hyperlink'
    ) {
      acc.links += 1;
    }
    if (node.nodeType === 'embedded-asset-block') acc.images += 1;
    if (node.content) countRichText(node.content, acc);
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
