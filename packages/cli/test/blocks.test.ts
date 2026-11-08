import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockCatalogPush, ContentType } from '@contentworker/sdk-management';
import { describe, expect, it } from 'vitest';
import { loadBlocks, renderPush } from '../src/blocks.js';
import { planModel } from '../src/model.js';
import { EXIT } from '../src/output.js';
import { type Call, harness, status } from './harness.js';

const FILE = {
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  blocks: [
    { id: 'hero', name: 'Hero', fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }] },
    { id: 'quote', name: 'Quote', fields: [{ apiId: 'text', name: 'Text', type: 'Text' }] },
  ],
};

const plan = (over: Partial<BlockCatalogPush> = {}): BlockCatalogPush => ({
  dryRun: true,
  applied: false,
  unchanged: false,
  previousVersion: 2,
  version: 3,
  hash: 'h',
  changes: { added: ['quote'], changed: ['hero'], removed: [], renamed: [] },
  contentTypes: [
    {
      contentTypeApiId: 'page',
      fields: [{ field: 'body', added: ['quote'], changed: ['hero'], removed: [], renamed: [] }],
      destructive: false,
      version: 7,
      published: true,
    },
  ],
  destructive: false,
  inUse: [],
  warnings: [],
  ...over,
});

const PUSH = 'POST /spaces/s1/environments/main/block-catalog';

async function setup(
  answer: (body: Record<string, unknown>) => unknown,
  opts: { interactive?: boolean; answers?: string[] } = {},
) {
  const pushes: Record<string, unknown>[] = [];
  const h = await harness(
    {
      [PUSH]: (call: Call) => {
        const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
        pushes.push(body);
        return answer(body);
      },
    },
    {
      env: {
        CONTENTWORKER_TOKEN: 't',
        CONTENTWORKER_URL: 'https://api.cms.test',
        CONTENTWORKER_SPACE: 's1',
      },
      ...opts,
    },
  );
  const dir = await mkdtemp(join(tmpdir(), 'cw-blocks-'));
  const file = join(dir, 'contentworker.blocks.json');
  await writeFile(file, JSON.stringify(FILE));
  return { h, pushes, file, dir };
}

describe('blocks push', () => {
  it('--dry-run asks the server for the change, prints it, and pushes nothing', async () => {
    const { h, pushes, file } = await setup(() => plan());
    const out = await h.run('blocks', 'push', file, '--dry-run');
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).toContain('Block catalog: version 2 → 3');
    expect(out.stdout).toContain('    + quote');
    expect(out.stdout).toContain('    body: +quote ~hero');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      dryRun: true,
      publish: true,
      blocks: FILE.blocks,
      targets: FILE.targets,
    });
  });

  it('pushes with --yes against the version it showed', async () => {
    const { h, pushes, file } = await setup((body) =>
      body.dryRun ? plan() : plan({ dryRun: false, applied: true }),
    );
    const out = await h.run('blocks', 'push', file, '--yes', '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ applied: true, version: 3 });
    expect(pushes[1]).toMatchObject({ expectedVersion: 2, allowDestructive: false, publish: true });
    expect(pushes[1]).not.toHaveProperty('dryRun');
  });

  it('reads contentworker.blocks.json from the working directory when no file is named', async () => {
    const { h, pushes, dir } = await setup(() => plan({ unchanged: true, version: 2 }));
    h.io.cwd = dir;
    const out = await h.run('blocks', 'push');
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).toBe('No changes: the block catalog is at version 2.');
    expect(pushes).toHaveLength(1);
  });

  it('refuses a removal without --allow-destructive (exit 4), even with --yes', async () => {
    const removing = plan({
      destructive: true,
      changes: { added: [], changed: [], removed: ['quote'], renamed: [] },
    });
    const { h, pushes, file } = await setup(() => removing);
    const out = await h.run('blocks', 'push', file, '--yes', '--json');
    expect(out.code).toBe(EXIT.refused);
    expect(JSON.parse(out.stderr).error.code).toBe('destructive_change');
    expect(pushes).toHaveLength(1);
  });

  it('refuses outright when entries still hold what it removes, naming them', async () => {
    const held = plan({
      destructive: true,
      inUse: [{ contentTypeApiId: 'page', at: 'body: quote', kind: 'variant', entries: ['e1'] }],
    });
    const { h, pushes, file } = await setup(() => held);
    const out = await h.run('blocks', 'push', file, '--yes', '--allow-destructive');
    expect(out.code).toBe(EXIT.refused);
    expect(out.stderr).toContain('page.body: quote is still used by e1');
    expect(pushes).toHaveLength(1);
  });

  it('never prompts off a terminal: a push needs --yes there (exit 2)', async () => {
    const { h, pushes, file } = await setup(() => plan());
    expect((await h.run('blocks', 'push', file)).code).toBe(EXIT.usage);
    expect(pushes).toHaveLength(1);
  });

  it('asks on a terminal, and --no-publish leaves drafts', async () => {
    const { h, pushes, file } = await setup((b) => (b.dryRun ? plan() : plan({ applied: true })), {
      interactive: true,
      answers: ['y'],
    });
    expect((await h.run('blocks', 'push', file, '--no-publish')).code).toBe(EXIT.ok);
    expect(pushes[1]).toMatchObject({ publish: false, expectedVersion: 2 });
  });

  it('prints each field the server refused (422), and exits 1', async () => {
    const refused = () =>
      status(422, {
        error: {
          code: 'validation_failed',
          message: 'One or more fields are invalid',
          details: [
            { field: 'targets[0]', message: 'page has no field "blocks"' },
            { field: 'blocks[box].css', message: '"css" is a style prop, so it must be a token' },
          ],
        },
      });
    const { h, file } = await setup(refused);
    const out = await h.run('blocks', 'push', file, '--dry-run');
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toBe(
      [
        'contentworker: One or more fields are invalid:',
        '  targets[0]: page has no field "blocks"',
        '  blocks[box].css: "css" is a style prop, so it must be a token',
      ].join('\n'),
    );
    const json = await h.run('blocks', 'push', file, '--dry-run', '--json');
    expect(json.code).toBe(EXIT.failure);
    const error = JSON.parse(json.stderr).error;
    expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
    expect(error.message).toContain('targets[0]: page has no field "blocks"');
  });

  it('prints the server’s own message for a refusal without issues (409)', async () => {
    const { h, file } = await setup(() =>
      status(409, {
        error: { code: 'conflict', message: 'The block catalog is at version 3, not 2' },
      }),
    );
    const out = await h.run('blocks', 'push', file, '--dry-run');
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toBe('contentworker: The block catalog is at version 3, not 2');
  });
});

describe('a blocks file', () => {
  it('is JSON or a module whose default export is { targets, blocks }', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-blocks-file-'));
    await writeFile(join(dir, 'blocks.mjs'), `export default ${JSON.stringify(FILE)};`);
    expect((await loadBlocks('blocks.mjs', dir)).blocks).toHaveLength(2);
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ blocks: [] }));
    await expect(loadBlocks('bad.json', dir)).rejects.toThrow(/expected \{ "targets"/);
    await expect(loadBlocks('missing.json', dir)).rejects.toThrow(/no such file/);
  });

  it('renders renames and what entries still hold', () => {
    const text = renderPush(
      plan({
        changes: { added: [], changed: [], removed: [], renamed: [{ from: 'hero', to: 'banner' }] },
      }),
    );
    expect(text).toContain('~ hero → banner (renamed)');
  });
});

describe('model apply and renamed block types', () => {
  it('reads a variant renamed through aliases as a rename, not a removal', () => {
    const variant = (apiId: string, aliases?: string[]) => ({
      apiId,
      name: apiId,
      fields: [
        { apiId: 'x', name: 'x', type: 'Symbol', localized: false, required: false, position: 0 },
      ],
      ...(aliases ? { aliases } : {}),
    });
    const type = (v: ReturnType<typeof variant>) => ({
      apiId: 'page',
      name: 'Page',
      displayField: 'body',
      fields: [
        {
          apiId: 'body',
          name: 'body',
          type: 'Array',
          localized: false,
          required: false,
          position: 0,
          items: { type: 'Component', variants: [v] },
        },
      ],
    });
    const live = { ...type(variant('hero')), version: 1, status: 'published' } as ContentType;
    const result = planModel([type(variant('banner', ['hero']))], [live]);
    expect(result.destructive).toBe(0);
    expect(result.types[0]?.changes).toEqual([
      {
        path: 'page.body[hero]',
        kind: 'change-field',
        destructive: false,
        detail: 'renamed to banner (blocks stored as hero keep reading)',
      },
    ]);
  });
});
