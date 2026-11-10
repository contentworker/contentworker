import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateTypes } from '../src/codegen';

// TypeScript 7 ships no compiler JS API, so this runs its own `tsc` over a file that imports the
// generated module and the published subpaths' sources, and returns what it prints.
const tscBin = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
);
const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

async function tsc(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-blocks-types-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        lib: ['es2023', 'dom'],
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: [],
      },
      files: Object.keys(files),
    }),
  );
  try {
    execFileSync(process.execPath, [tscBin, '-p', dir, '--pretty', 'false'], { encoding: 'utf8' });
    return '';
  } catch (error) {
    return String((error as { stdout?: string }).stdout || error);
  }
}

const catalog = {
  blocks: [
    {
      id: 'banner',
      name: 'Banner',
      aliases: ['hero'],
      fields: [{ apiId: 'heading', type: 'Symbol', required: true }],
    },
    {
      id: 'grid',
      name: 'Grid',
      fields: [{ apiId: 'title', type: 'Symbol' }],
      slots: [{ apiId: 'cards', allowedChildren: ['card'] }],
    },
    { id: 'card', name: 'Card', fields: [{ apiId: 'label', type: 'Symbol', required: true }] },
  ],
};

describe('block types from codegen', () => {
  it("type each component's block, field marks and slots, and refuse what the catalog lacks", async () => {
    const usage = `
import type { BlockComponents as ReactComponents } from '${join(src, 'react.ts')}';
import type { BlockComponents as VueComponents } from '${join(src, 'vue.ts')}';
import { type BlockRenderers, renderBlocks } from '${join(src, 'blocks.ts')}';
import type { BlockTypes } from './generated.ts';

const react: ReactComponents<BlockTypes> = {
  banner: ({ block, fieldAttrs }) => {
    block.heading.toUpperCase();
    fieldAttrs('heading');
    // @ts-expect-error a mark names one of the block's own fields
    fieldAttrs('nope');
    return null;
  },
  grid: ({ block, slots }) => {
    for (const card of block.cards ?? []) card.label.toUpperCase();
    // @ts-expect-error a block has only the slots its catalog gives it
    slots.items;
    return slots.cards({ as: 'ul' });
  },
};
const notInCatalog: ReactComponents<BlockTypes> = {
  // @ts-expect-error no block has this id
  footer: () => null,
};
const vue: VueComponents<BlockTypes> = {};
const strings: BlockRenderers<BlockTypes, string> = {
  card: ({ block }) => block.label,
  grid: ({ slot }) => slot('cards').items.join(''),
};
renderBlocks<BlockTypes, string>([], { components: strings });
void [react, notInCatalog, vue];
`;
    const out = await tsc({
      'generated.ts': generateTypes([], { blockCatalog: catalog }),
      'usage.ts': usage,
    });
    expect(out).toBe('');
  });
});
