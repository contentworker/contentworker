import { parseHTML } from 'linkedom';

/**
 * The element a page's queries return: linkedom's implementation of the DOM `Element`, typed to
 * the part a script needs, so these types do not pull the DOM lib into every package.
 */
export interface PageElement {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly innerHTML: string;
  readonly outerHTML: string;
  readonly children: ArrayLike<PageElement>;
  readonly parentElement: PageElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): PageElement | null;
  querySelectorAll(selector: string): ArrayLike<PageElement>;
  closest(selector: string): PageElement | null;
  matches(selector: string): boolean;
  remove(): void;
}

/** Where a helper reads from: an element, a CSS selector (first match), or nothing (the page). */
export type PageTarget = PageElement | string | null | undefined;

/**
 * One source page as an import script sees it: the parsed document and the reads most scripts
 * need, so a script stays a few lines of selectors and returns structured fields.
 */
export interface ParsedPage {
  /** The page's URL on the source site. */
  readonly url: string;
  /** The document's `<title>`, whitespace collapsed. */
  readonly title: string;
  /** The whole parsed document, for anything the helpers below don't cover. */
  readonly document: {
    readonly documentElement: PageElement;
    readonly head: PageElement;
    readonly body: PageElement;
    querySelector(selector: string): PageElement | null;
    querySelectorAll(selector: string): ArrayLike<PageElement>;
  };
  /** The first element matching `selector`, under `within` (default: the document). */
  query(selector: string, within?: PageElement | null): PageElement | null;
  /** Every element matching `selector`, under `within` (default: the document), as an array. */
  queryAll(selector: string, within?: PageElement | null): PageElement[];
  /** The target's text with whitespace collapsed and trimmed; `''` when nothing matches. */
  text(target?: PageTarget): string;
  /**
   * The target's inner HTML, for a rich-text field: the caller converts it into a rich-text
   * document after the script returns, so markup never leaves the run. `''` when nothing matches.
   */
  html(target?: PageTarget): string;
  /** An attribute of the target, trimmed; `undefined` when absent or nothing matches. */
  attr(target: PageTarget, name: string): string | undefined;
  /**
   * `href` resolved against the page (honouring `<base href>`): an absolute `http(s)` URL, or
   * `undefined` for an empty, `javascript:`, `data:` or otherwise non-web reference.
   */
  absolute(href: string | null | undefined): string | undefined;
  /** A `<meta>` value by `name`, `property` or `itemprop` (`description`, `og:image`). */
  meta(name: string): string | undefined;
  /** Every named `<meta>` value, first one per name. */
  metas(): Record<string, string>;
  /**
   * The page's JSON-LD: every `application/ld+json` block parsed, with `@graph` lists flattened
   * into their items. A block that is not valid JSON is skipped.
   */
  jsonLd(): unknown[];
}

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** Parses `html` (a whole page) into the {@link ParsedPage} a script receives. */
export function createParsedPage(page: {
  readonly url: string;
  readonly html: string;
}): ParsedPage {
  const { document } = parseHTML(page.html) as unknown as {
    document: ParsedPage['document'] & { title?: string };
  };
  const root = document as unknown as Pick<PageElement, 'querySelector' | 'querySelectorAll'>;
  const pick = (target: PageTarget): PageElement | null =>
    target === undefined || target === null
      ? document.body
      : typeof target === 'string'
        ? root.querySelector(target)
        : target;

  const baseHref = root.querySelector('base[href]')?.getAttribute('href') ?? undefined;
  const base = resolve(baseHref, page.url) ?? page.url;

  const metaValues = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const el of Array.from(root.querySelectorAll('meta'))) {
      const key =
        el.getAttribute('name') ?? el.getAttribute('property') ?? el.getAttribute('itemprop');
      const value = el.getAttribute('content');
      if (key && value !== null && !out.has(key.toLowerCase())) out.set(key.toLowerCase(), value);
    }
    return out;
  };

  return {
    url: page.url,
    title: collapse(root.querySelector('title')?.textContent),
    document,
    query: (selector, within) => (within ?? root).querySelector(selector),
    queryAll: (selector, within) => Array.from((within ?? root).querySelectorAll(selector)),
    text: (target) => collapse(pick(target)?.textContent),
    html: (target) => pick(target)?.innerHTML.trim() ?? '',
    attr: (target, name) => {
      const value = pick(target)?.getAttribute(name);
      return value === null || value === undefined ? undefined : value.trim();
    },
    absolute: (href) => resolve(href, base),
    meta: (name) => metaValues().get(name.toLowerCase()),
    metas: () => Object.fromEntries(metaValues()),
    jsonLd: () => {
      const out: unknown[] = [];
      for (const el of Array.from(root.querySelectorAll('script[type="application/ld+json"]'))) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(el.textContent ?? '');
        } catch {
          continue;
        }
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          const graph = (item as { '@graph'?: unknown } | null)?.['@graph'];
          if (Array.isArray(graph)) out.push(...graph);
          else out.push(item);
        }
      }
      return out;
    },
  };
}

// The runtime declares no host libs (it runs in workerd and in node); every JS host has a URL.
const { URL } = globalThis as unknown as {
  URL: new (input: string, base?: string) => { readonly href: string; readonly protocol: string };
};

function resolve(href: string | null | undefined, base: string): string | undefined {
  const value = href?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
