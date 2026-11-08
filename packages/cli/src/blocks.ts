import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BlockCatalogPush,
  BlockCatalogPushInput,
  BlockCatalogTarget,
  BlockManifest,
} from '@contentworker/sdk-management';
import { usageError } from './output.js';

/**
 * The block catalog as a file: the manifests of the components a site renders, and the blocks
 * fields they go in. JSON (`{ "targets": [...], "blocks": [...] }`) or a TypeScript or JavaScript
 * module whose default export is that object, so the manifests can sit beside the components
 * they describe. The file is data: the CLI sends what it holds, and nothing in it runs on the
 * server or in the admin.
 */

/** Where `blocks push` looks when no file is named. */
export const DEFAULT_BLOCKS_FILE = 'contentworker.blocks.json';

export interface BlocksFile {
  readonly targets: readonly BlockCatalogTarget[];
  readonly blocks: readonly BlockManifest[];
}

/** Reads a blocks file. Shapes beyond the outline are checked by the server, which names each. */
export async function loadBlocks(path: string, cwd: string): Promise<BlocksFile> {
  const full = resolve(cwd, path);
  let raw: unknown;
  try {
    if (['.ts', '.mts', '.js', '.mjs'].includes(extname(full))) {
      // The mtime makes an edited module a new URL, so a long-lived process reads the edit.
      const href = `${pathToFileURL(full).href}?v=${(await stat(full)).mtimeMs}`;
      raw = ((await import(href)) as { default?: unknown }).default;
    } else {
      raw = JSON.parse(await readFile(full, 'utf8'));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw usageError(
        `${path}: no such file. Name one, or write ${DEFAULT_BLOCKS_FILE} as ` +
          '{ "targets": [{ "contentTypeApiId": "page", "field": "body" }], "blocks": [...] }.',
      );
    }
    if (err instanceof SyntaxError) throw usageError(`${path}: ${err.message}`);
    throw err;
  }
  const file = raw as Partial<BlocksFile> | undefined;
  if (!Array.isArray(file?.blocks) || !Array.isArray(file?.targets)) {
    throw usageError(`${path}: expected { "targets": [...], "blocks": [...] }`);
  }
  return { targets: file.targets, blocks: file.blocks };
}

/** The push as the file asks for it, before any flag. */
export const pushInput = (file: BlocksFile): BlockCatalogPushInput => ({
  targets: file.targets,
  blocks: file.blocks,
});

/** What a push did or would do, in the lines `model apply` uses: + added, ~ changed, - removed. */
export function renderPush(push: BlockCatalogPush): string {
  if (push.unchanged) return `No changes: the block catalog is at version ${push.version}.`;
  const lines = [`Block catalog: version ${push.previousVersion} → ${push.version}`];
  const { added, changed, removed, renamed } = push.changes;
  for (const id of added) lines.push(`    + ${id}`);
  for (const r of renamed) lines.push(`    ~ ${r.from} → ${r.to} (renamed)`);
  for (const id of changed) lines.push(`    ~ ${id}`);
  for (const id of removed) lines.push(`    ! ${id} (removed)`);
  for (const t of push.contentTypes) {
    lines.push(`${t.destructive ? '!' : '~'} ${t.contentTypeApiId} (version ${t.version})`);
    for (const f of t.fields) {
      const parts = [
        ...f.added.map((id) => `+${id}`),
        ...f.renamed.map((r) => `~${r.from}→${r.to}`),
        ...f.changed.map((id) => `~${id}`),
        ...f.removed.map((id) => `-${id}`),
      ];
      lines.push(`    ${f.field}: ${parts.length ? parts.join(' ') : 'reordered'}`);
    }
  }
  for (const u of push.inUse) {
    const named = u.entries.slice(0, 5).join(', ');
    const more = u.entries.length > 5 ? ` and ${u.entries.length - 5} more` : '';
    lines.push(`  ✗ ${u.contentTypeApiId}.${u.at} is still used by ${named}${more}`);
  }
  for (const w of push.warnings) lines.push(`  warning: ${w.message}`);
  lines.push(
    '',
    `${push.contentTypes.length} content type(s) change` +
      (push.destructive ? '; it removes blocks or block props (!).' : '.'),
  );
  return lines.join('\n');
}
