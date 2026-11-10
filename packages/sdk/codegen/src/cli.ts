/**
 * contentworker-codegen — emit TypeScript field shapes from a content model.
 *
 *   # From a live Management/Preview API (any token with preview read):
 *   contentworker-codegen --url https://cms.example.com --space s1 --environment main \
 *     --token $CMA_TOKEN --out src/generated/content-types.ts
 *
 *   # From an exported JSON file ({ items: [...] } or a bare array):
 *   contentworker-codegen --input content-types.json > content-types.ts
 *
 * The block types come from the space's block catalog when one is pushed (or from `--blocks`, a
 * blocks file or a saved `GET …/block-catalog`), else from the blocks fields' variants.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { BlockCatalogInput, ContentTypeInput } from './generate.js';
import { generateTypes } from './generate.js';

export interface CliArgs {
  readonly url?: string;
  readonly space?: string;
  readonly environment?: string;
  readonly token?: string;
  readonly input?: string;
  readonly blocks?: string;
  readonly out?: string;
  readonly help?: boolean;
}

const FLAGS = new Set(['url', 'space', 'environment', 'token', 'input', 'blocks', 'out']);

/** Parses `--flag value` pairs; throws on unknown flags or missing values. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    if (!raw.startsWith('--')) throw new Error(`Unexpected argument: ${raw}`);
    const flag = raw.slice(2);
    if (!FLAGS.has(flag)) throw new Error(`Unknown flag: ${raw}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${raw}`);
    }
    args[flag] = value;
    i++;
  }
  return args as CliArgs;
}

const USAGE = `Usage:
  contentworker-codegen --url <baseUrl> --space <id> --environment <id> --token <token> [--blocks <file>] [--out <file>]
  contentworker-codegen --input <content-types.json> [--blocks <file>] [--out <file>]

Reads the space's content types (live API or exported JSON) and emits a
TypeScript module of field shapes for the @contentworker SDKs, with a type per
block and BlockTypes for <Blocks components={…}>. The block types come from
--blocks (a blocks file, or a saved block catalog), else the live API's block
catalog, else the blocks fields' variants. Writes to stdout unless --out is given.`;

/** Loads content types from the configured source. */
export async function loadContentTypes(
  args: CliArgs,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ContentTypeInput[]> {
  if (args.input) {
    const parsed = JSON.parse(await readFile(args.input, 'utf8')) as
      | { items?: ContentTypeInput[] }
      | ContentTypeInput[];
    return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  }
  if (!args.url || !args.space || !args.environment || !args.token) {
    throw new Error(`--url, --space, --environment, and --token are all required\n\n${USAGE}`);
  }
  const base = args.url.replace(/\/$/, '');
  const url = `${base}/spaces/${encodeURIComponent(args.space)}/environments/${encodeURIComponent(
    args.environment,
  )}/content-types`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${args.token}` } });
  if (!res.ok) throw new Error(`Fetching content types failed: ${res.status} ${url}`);
  const body = (await res.json()) as { items?: ContentTypeInput[] };
  return body.items ?? [];
}

/**
 * Loads the block catalog: `--blocks` (a blocks file or a saved catalog, `{ blocks }`), else the
 * live API's catalog in force. Undefined when there is none (no push yet answers 404): the block
 * types then come from the variants.
 */
export async function loadBlockCatalog(
  args: CliArgs,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BlockCatalogInput | undefined> {
  if (args.blocks) {
    const parsed = JSON.parse(await readFile(args.blocks, 'utf8')) as { blocks?: unknown };
    if (!Array.isArray(parsed.blocks)) throw new Error(`${args.blocks} has no "blocks" list`);
    return parsed as BlockCatalogInput;
  }
  if (args.input || !args.url || !args.space || !args.environment || !args.token) return undefined;
  const url = `${args.url.replace(/\/$/, '')}/spaces/${encodeURIComponent(args.space)}/environments/${encodeURIComponent(
    args.environment,
  )}/block-catalog`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${args.token}` } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Fetching the block catalog failed: ${res.status} ${url}`);
  return (await res.json()) as BlockCatalogInput;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const contentTypes = await loadContentTypes(args);
  const blockCatalog = await loadBlockCatalog(args);
  const source = generateTypes(contentTypes, {
    blockCatalog,
    banner: args.input
      ? `Generated by @contentworker/sdk-codegen from ${args.input}. Do not edit by hand.`
      : `Generated by @contentworker/sdk-codegen from ${args.space}/${args.environment}. Do not edit by hand.`,
  });
  if (args.out) {
    await writeFile(args.out, source, 'utf8');
    console.error(`Wrote ${contentTypes.length} content type(s) to ${args.out}`);
  } else {
    console.log(source);
  }
}
