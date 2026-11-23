/**
 * What a template's import script returns for one page: the template content type's top-level
 * fields, its body as blocks (component variants and their fields), and the assets and links the
 * page holds. Structured, never markup: a rich-text field the script hands back as an HTML
 * fragment is converted with `richTextFromHtml` before the output is scored or stored, so no
 * stored output, score or entry carries HTML.
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
