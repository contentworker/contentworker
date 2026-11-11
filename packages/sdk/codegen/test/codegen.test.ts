import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BlockCatalogInput, ContentTypeInput } from '../src/index.js';
import { generateTypes, loadBlockCatalog, loadContentTypes, parseArgs } from '../src/index.js';

// TypeScript 7 ships no compiler JS API, so this runs its own `tsc` on the source in a temp dir and
// returns the diagnostics it prints ('' when it compiles clean).
const tscBin = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
);
// Each call starts a `tsc` process and type-checks a module from cold: about a second alone, several
// on a CI runner shared with the other suites, and a test may compile twice. Vitest's 5 s default
// is a budget for in-process work, not this, so the tests that compile get their own.
const TSC_TIMEOUT = 30_000;
async function tsc(source: string, compilerOptions: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-tsc-'));
  await writeFile(join(dir, 'generated.ts'), source);
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { noEmit: true, ...compilerOptions },
      files: ['generated.ts'],
    }),
  );
  try {
    execFileSync(process.execPath, [tscBin, '-p', dir, '--pretty', 'false'], { encoding: 'utf8' });
    return '';
  } catch (error) {
    return String((error as { stdout?: string }).stdout || error);
  }
}
/** A model exercising every field type, validations, and naming edge cases. */
const MODEL: ContentTypeInput[] = [
  {
    apiId: 'article',
    name: 'Article',
    fields: [
      { apiId: 'title', name: 'Title', type: 'Symbol', required: true, localized: true },
      { apiId: 'body', type: 'RichText' },
      { apiId: 'summary', type: 'Text' },
      { apiId: 'views', type: 'Integer' },
      { apiId: 'rating', type: 'Number', validations: { in: [1, 2, 3] } },
      { apiId: 'featured', type: 'Boolean' },
      { apiId: 'publishedOn', type: 'Date' },
      { apiId: 'venue', type: 'Location' },
      { apiId: 'meta', type: 'JSON' },
      {
        apiId: 'hero',
        type: 'Link',
        linkType: 'Asset',
      },
      {
        apiId: 'author',
        type: 'Link',
        linkType: 'Entry',
        validations: { linkContentTypes: ['author'] },
      },
      { apiId: 'tags', type: 'Array', items: { type: 'Symbol' } },
      {
        apiId: 'status',
        type: 'Symbol',
        required: true,
        validations: { in: ['draft', 'live'] },
      },
      {
        apiId: 'related',
        type: 'Array',
        items: { type: 'Link', linkType: 'Entry' },
      },
      { apiId: 'og:image', type: 'Symbol' },
      { apiId: 'seo', type: 'Seo' },
    ],
  },
  { apiId: 'author', name: 'Author', fields: [{ apiId: 'name', type: 'Symbol', required: true }] },
  // Collides with 'author' after PascalCase normalization.
  { apiId: 'author_', fields: [] },
];

/** Syntactic edge cases: escaping, naming fallbacks, unknown types. */
const EDGE: ContentTypeInput[] = [
  {
    apiId: 'blog-post',
    fields: [
      { apiId: 'sizes', type: 'Array', items: { type: 'Symbol', validations: { in: ['s', 'm'] } } },
      { apiId: 'gallery', type: 'Array', items: { type: 'Link', linkType: 'Asset' } },
      { apiId: 'bare', type: 'Array' },
      { apiId: 'untyped-link', type: 'Link' },
      { apiId: 'future', type: 'FutureThing' },
      {
        apiId: 'callout',
        type: 'Component',
        fields: [
          { apiId: 'heading', type: 'Symbol', required: true },
          { apiId: 'icon', type: 'Link', linkType: 'Asset' },
        ],
      },
      {
        apiId: 'cards',
        type: 'Array',
        items: {
          type: 'Component',
          fields: [
            { apiId: 'label', type: 'Symbol', required: true },
            { apiId: 'variant', type: 'Symbol', validations: { in: ['a', 'b'] } },
          ],
        },
      },
      { apiId: 'shapeless', type: 'Component' },
      {
        apiId: 'blocks',
        type: 'Array',
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              fields: [
                { apiId: 'heading', type: 'Symbol', required: true },
                { apiId: 'image', type: 'Link', linkType: 'Asset' },
              ],
            },
            {
              apiId: 'cta',
              name: 'Call to action',
              fields: [{ apiId: 'target', type: 'Link', linkType: 'Entry', required: true }],
            },
          ],
        },
      },
      { apiId: "author's-note", type: 'Symbol' },
      { apiId: 'tricky', name: 'Bad */ comment', type: 'Symbol', localized: true },
      { apiId: 'mood', type: 'Symbol', validations: { in: ["it's"] } },
    ],
  },
  { apiId: '123', fields: [] },
  { apiId: '!!!', fields: [] },
];

describe('@contentworker/sdk-codegen generator', () => {
  const source = generateTypes(MODEL);
  const edge = generateTypes(EDGE);

  it('maps every field type to the right TypeScript type', () => {
    expect(source).toContain('title: string;');
    expect(source).toContain('body?: RichTextDocument;');
    expect(source).toContain('summary?: string;');
    expect(source).toContain('views?: number;');
    expect(source).toContain('rating?: 1 | 2 | 3;');
    expect(source).toContain('featured?: boolean;');
    expect(source).toContain('publishedOn?: string;');
    expect(source).toContain('venue?: Location;');
    expect(source).toContain('meta?: Record<string, unknown>;');
    expect(source).toContain('hero?: AssetLink | DeliveredAsset;');
    expect(source).toContain('author?: EntryLink;');
    expect(source).toContain('tags?: string[];');
    expect(source).toContain("status: 'draft' | 'live';");
    expect(source).toContain('related?: EntryLink[];');
    expect(source).toContain(
      'seo?: { title?: string; description?: string; canonicalUrl?: string; noindex?: boolean; ogImage?: AssetLink | DeliveredAsset };',
    );
  });

  it('types labelled options by their stored values and documents a field from its guidance', () => {
    const out = generateTypes([
      {
        apiId: 'post',
        fields: [
          {
            apiId: 'status',
            name: 'Status',
            type: 'Symbol',
            required: true,
            description: 'Where the post is in its life.\nNot the */ publish state.',
            validations: { in: [{ value: 'draft', label: 'Draft' }, 'live'] },
          },
          {
            apiId: 'stars',
            type: 'Integer',
            help: 'One to three.',
            validations: { in: [1, { value: 2, label: 'Two' }] },
          },
        ],
      },
    ]);
    expect(out).toContain("status: 'draft' | 'live';");
    expect(out).toContain('stars?: 1 | 2;');
    expect(out).toContain(
      '/** Status — Where the post is in its life. Not the *\\/ publish state. */',
    );
    expect(out).toContain('/** One to three. */');
    expect(out).not.toContain("'Draft'");
  });

  it('types a component as its nested shape, not as unknown', () => {
    expect(edge).toContain('callout?: { heading: string; icon?: AssetLink | DeliveredAsset };');
  });

  it('types a repeater as an array of that shape', () => {
    // The old fallback claimed `string[]` here, which was not vague — it was
    // wrong, and consumers would have written code against it.
    expect(edge).toContain("cards?: { label: string; variant?: 'a' | 'b' }[];");
    expect(edge).not.toContain('cards?: string[];');
  });

  it('keeps nested values bare in the draft shape', () => {
    // A component is localized as a whole, so the locale is resolved one level
    // up; `Localized<>` on a leaf would describe a shape that never arrives.
    expect(edge).toContain('callout?: Localized<{ heading: string; icon?: AssetLink }>;');
  });

  it('types a blocks field as an array of a union discriminated on _type', () => {
    // Golden: the exact text consumers compile against, delivered and draft.
    expect(edge).toContain(
      "blocks?: ({ _type: 'hero'; _key: string; heading: string; image?: AssetLink | DeliveredAsset } | { _type: 'cta'; _key: string; target: EntryLink })[];",
    );
    expect(edge).toContain(
      "blocks?: Localized<({ _type: 'hero'; _key: string; heading: string; image?: AssetLink } | { _type: 'cta'; _key: string; target: EntryLink })[]>;",
    );
  });

  it('falls back to a record for a component with no declared shape', () => {
    expect(edge).toContain('shapeless?: Record<string, unknown>;');
  });

  it('quotes non-identifier property keys', () => {
    expect(source).toContain("'og:image'?: string;");
  });

  it('emits delivery and locale-keyed draft type aliases per content type', () => {
    // Aliases (not interfaces): they satisfy `F extends Record<string, unknown>`.
    expect(source).toContain('export type ArticleFields = {');
    expect(source).toContain('export type ArticleDraftFields = {');
    expect(source).toContain('title: Localized<string>;');
    expect(source).toContain("status: Localized<'draft' | 'live'>;");
  });

  it('deduplicates colliding type names', () => {
    expect(source).toContain('export type AuthorFields = {');
    expect(source).toContain('export type Author2Fields = {');
  });

  it('emits the apiId union and lookup maps', () => {
    expect(source).toContain("export type ContentTypeApiId = 'article' | 'author' | 'author_';");
    expect(source).toContain('export interface FieldsByContentType {');
    expect(source).toContain('article: ArticleFields;');
    expect(source).toContain('export interface DraftFieldsByContentType {');
    expect(source).toContain('article: ArticleDraftFields;');
  });

  it('documents field names, localization, and link restrictions', () => {
    expect(source).toContain('/** Title — localized */');
    expect(source).toContain('/** links: author */');
  });

  it('never narrows where the domain does not enforce `in` (Date, array items)', () => {
    // validate.ts applies checkIn only to Symbol/Text/Integer/Number.
    expect(edge).toContain('sizes?: string[];');
    expect(source).toContain('publishedOn?: string;');
  });

  it('handles asset-link arrays, item-less arrays, and untyped links', () => {
    expect(edge).toContain('gallery?: (AssetLink | DeliveredAsset)[];');
    expect(edge).toContain('gallery?: Localized<AssetLink[]>;');
    expect(edge).toContain('bare?: string[];');
    expect(edge).toContain("'untyped-link'?: EntryLink;");
  });

  it('types a delivered asset link as the link or the embedded asset, a draft one as the link', () => {
    expect(source).toContain('export interface DeliveredAsset {');
    expect(source).toContain('srcset: { width: number; url: string }[];');
    expect(source).toContain('renditions: Record<string, string>;');
    expect(source).toContain('hero?: Localized<AssetLink>;');
  });

  it("types an embed node's data as structured metadata, not markup", () => {
    expect(source).toContain('export interface EmbedData {');
    expect(source).toContain("kind?: 'video' | 'post' | 'audio' | 'other';");
    expect(source).toContain('& Partial<EmbedData> &');
    expect(source).not.toMatch(/html\??:/);
  });

  it('maps unrecognized field types to unknown', () => {
    expect(edge).toContain('future?: unknown;');
  });

  it('escapes quotes and comment terminators in generated source', () => {
    expect(edge).toContain("'author\\'s-note'?: string;");
    expect(edge).toContain('/** Bad *\\/ comment — localized */');
    expect(edge).toContain("mood?: 'it\\'s';");
  });

  it('quotes non-identifier content-type apiIds in lookup maps and the union', () => {
    expect(edge).toContain("export type ContentTypeApiId = 'blog-post' | '123' | '!!!';");
    expect(edge).toContain("'blog-post': BlogPostFields;");
    expect(edge).toContain("'blog-post': BlogPostDraftFields;");
  });

  it('falls back to ContentType for apiIds that normalize to nothing', () => {
    expect(edge).toContain('export type ContentTypeFields = {');
    expect(edge).toContain('export type ContentType2Fields = {');
  });

  it('produces source that compiles clean and satisfies the SDK generics', { timeout: TSC_TIMEOUT }, async () => {
    // The appended usage block proves generated shapes plug into the SDKs'
    // `F extends Record<string, unknown>` constraint (interfaces would not).
    const source = `${generateTypes([...MODEL, ...EDGE])}
declare function acceptsFields<F extends Record<string, unknown>>(f: F): F;
declare const article: ArticleFields;
declare const draft: ArticleDraftFields;
acceptsFields(article);
acceptsFields(draft);
// A blocks element narrows on _type to its variant's fields.
declare const post: BlogPostFields;
for (const block of post.blocks ?? []) {
  if (block._type === 'hero') block.heading.toUpperCase();
  else block.target.id.toUpperCase();
}
// An embed node's data reads as EmbedData.
for (const node of article.body?.content ?? []) {
  if (node.nodeType === 'embed' && node.data?.url) node.data.url.toUpperCase();
}
`;
    // types: [] keeps ambient @types packages (e.g. node) out of the check —
    // the generated module must stand alone.
    expect(await tsc(source, { strict: true, target: 'es2022', types: [] })).toBe('');
  });

  it('handles an empty model without emitting the union block', () => {
    const empty = generateTypes([]);
    expect(empty).toContain('export interface EntryLink');
    expect(empty).not.toContain('ContentTypeApiId');
    expect(empty).not.toContain('BlockTypes');
  });
});

/** A catalog as `contentworker blocks push` sends it: a renamed block, slots, a nested child. */
const CATALOG: BlockCatalogInput = {
  blocks: [
    {
      id: 'banner',
      name: 'Banner',
      description: 'The top of a page.',
      aliases: ['hero'],
      fields: [
        { apiId: 'heading', name: 'Heading', type: 'Symbol', required: true },
        { apiId: 'tone', type: 'Symbol', validations: { in: ['light', 'dark'] } },
        { apiId: 'image', type: 'Link', linkType: 'Asset' },
      ],
    },
    {
      id: 'grid',
      name: 'Card grid',
      fields: [{ apiId: 'title', type: 'Symbol' }],
      slots: [
        { apiId: 'cards', name: 'Cards', allowedChildren: ['card', 'quote'], min: 1 },
        { apiId: 'aside', allowedChildren: ['quote'] },
      ],
    },
    { id: 'card', name: 'Card', fields: [{ apiId: 'title', type: 'Symbol', required: true }] },
    { id: 'quote', fields: [{ apiId: 'text', type: 'Text' }] },
  ],
};

/** The same catalog as the content type's variants once pushed (slots expanded in place). */
const card = { apiId: 'card', name: 'Card', fields: CATALOG.blocks[2]?.fields ?? [] };
const quote = { apiId: 'quote', fields: CATALOG.blocks[3]?.fields ?? [] };
const PAGE: ContentTypeInput = {
  apiId: 'page',
  fields: [
    {
      apiId: 'body',
      type: 'Array',
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'banner',
            name: 'Banner',
            aliases: ['hero'],
            fields: CATALOG.blocks[0]?.fields ?? [],
          },
          {
            apiId: 'grid',
            name: 'Card grid',
            fields: [
              { apiId: 'title', type: 'Symbol' },
              {
                apiId: 'cards',
                name: 'Cards',
                type: 'Array',
                required: true,
                items: { type: 'Component', variants: [card, quote] },
              },
              { apiId: 'aside', type: 'Array', items: { type: 'Component', variants: [quote] } },
            ],
          },
        ],
      },
    },
  ],
};

/** The block types section: from the first block type's doc comment to the end. */
const blockSection = (source: string) =>
  source.slice(source.lastIndexOf('/**', source.search(/export type \w+Block = /)));

describe('@contentworker/sdk-codegen block types', () => {
  it('types each catalog block and the components map (golden)', async () => {
    const source = generateTypes([], { blockCatalog: CATALOG });
    await expect(blockSection(source)).toMatchFileSnapshot('./golden/block-types.txt');
  });

  it("types the same blocks from the content types' variants as from the catalog", () => {
    const fromCatalog = generateTypes([], { blockCatalog: CATALOG });
    const fromVariants = blockSection(generateTypes([PAGE]));
    // The variants carry no description; everything else agrees.
    expect(fromVariants).toBe(blockSection(fromCatalog).replace(' — The top of a page.', ''));
  });

  it('types catalog blocks from the catalog, and blocks of other fields from their variants', () => {
    const article: ContentTypeInput = {
      apiId: 'article',
      fields: [
        {
          apiId: 'sidebar',
          type: 'Array',
          items: {
            type: 'Component',
            variants: [
              // A block the catalog also defines: the catalog's shape wins.
              { apiId: 'card', fields: [] },
              { apiId: 'callout', fields: [{ apiId: 'text', type: 'Text' }] },
            ],
          },
        },
      ],
    };
    const source = generateTypes([PAGE, article], { blockCatalog: CATALOG });
    expect(source).toContain(
      'export type BlockTypes = {\n  banner: BannerBlock;\n  grid: GridBlock;\n  card: CardBlock;\n  quote: QuoteBlock;\n  callout: CalloutBlock;\n};',
    );
    expect(source).toContain(
      "export type CardBlock = {\n  _type: 'card';\n  _key: string;\n  title: string;\n};",
    );
    expect(source).toContain("export type CalloutBlock = {\n  _type: 'callout';");
  });

  it('types an id two fields define apart as either shape', () => {
    const source = generateTypes([
      {
        apiId: 'a',
        fields: [
          {
            apiId: 'x',
            type: 'Array',
            items: { type: 'Component', variants: [{ apiId: 'note', fields: [] }] },
          },
          {
            apiId: 'y',
            type: 'Array',
            items: {
              type: 'Component',
              variants: [{ apiId: 'note', fields: [{ apiId: 'text', type: 'Text' }] }],
            },
          },
        ],
      },
    ]);
    expect(source).toContain(
      "export type NoteBlock = {\n  _type: 'note';\n  _key: string;\n} | {\n  _type: 'note';\n  _key: string;\n  text?: string;\n};",
    );
  });

  it('finds blocks fields inside components, and names ids that would collide apart', () => {
    const source = generateTypes([
      {
        apiId: 'a',
        fields: [
          {
            apiId: 'wrap',
            type: 'Component',
            fields: [
              {
                apiId: 'inner',
                type: 'Array',
                items: {
                  type: 'Component',
                  variants: [
                    { apiId: 'two-col', fields: [] },
                    { apiId: 'two_col', fields: [] },
                    { apiId: '9', fields: [] },
                  ],
                },
              },
            ],
          },
        ],
      },
    ]);
    expect(source).toContain(
      "export type BlockTypes = {\n  'two-col': TwoColBlock;\n  two_col: TwoCol2Block;\n  '9': UnnamedBlock;\n};",
    );
  });

  it('compiles, and types a slot as a list of its blocks', { timeout: TSC_TIMEOUT }, async () => {
    const source = `${generateTypes([PAGE])}
declare const page: PageFields;
declare const types: BlockTypes;
const grid: GridBlock = types.grid;
for (const child of grid.cards) {
  if (child._type === 'card') child.title.toUpperCase();
  else child.text?.toUpperCase();
}
const id: BlockId = 'banner';
// @ts-expect-error a slot holds only the blocks it allows
const wrong: GridBlock['aside'] = [{ _type: 'card', _key: 'k', title: 't' }];
// A blocks field's value is a list of the block types.
const body: BlockTypes[BlockId][] = page.body ?? [];
void [id, wrong, body];
`;
    expect(await tsc(source, { strict: true, target: 'es2022', types: [] })).toBe('');
  });
});

describe('@contentworker/sdk-codegen CLI', () => {
  it('makes a required field a rule can hide optional, and notes its rules', () => {
    const out = generateTypes([
      {
        apiId: 'card',
        fields: [
          { apiId: 'kind', type: 'Symbol', required: true },
          { apiId: 'url', type: 'Symbol', required: true, rules: [{ action: 'hide' }] },
          { apiId: 'ref', type: 'Symbol', required: true, rules: [{ action: 'disable' }] },
        ],
      },
    ]);
    expect(out).toContain('  kind: string;');
    expect(out).toContain('  url?: string;');
    expect(out).toContain('  ref: string;');
    expect(out).toContain('conditional: hide by rules');
  });

  it('types lists of scalars and notes a Date field’s format', () => {
    const out = generateTypes([
      {
        apiId: 'event',
        fields: [
          { apiId: 'day', type: 'Date', format: 'date' },
          { apiId: 'opens', type: 'Date', format: 'time' },
          { apiId: 'sizes', type: 'Array', items: { type: 'Integer' } },
          { apiId: 'weights', type: 'Array', items: { type: 'Number' } },
          { apiId: 'lines', type: 'Array', items: { type: 'Text' } },
          { apiId: 'days', type: 'Array', items: { type: 'Date', format: 'date' } },
        ],
      },
    ]);
    expect(out).toContain('/** date: YYYY-MM-DD */\n  day?: string;');
    expect(out).toContain('/** time: hh:mm */');
    expect(out).toContain('  sizes?: number[];');
    expect(out).toContain('  weights?: number[];');
    expect(out).toContain('  lines?: string[];');
    expect(out).toContain('/** date: YYYY-MM-DD */\n  days?: string[];');
  });

  it('parses flags and rejects unknown ones', () => {
    expect(parseArgs(['--url', 'https://x', '--space', 's1', '--token', 't'])).toEqual({
      url: 'https://x',
      space: 's1',
      token: 't',
    });
    expect(() => parseArgs(['--nope', 'x'])).toThrow('Unknown flag: --nope');
    expect(() => parseArgs(['--url'])).toThrow('Missing value for --url');
    expect(() => parseArgs(['--url', '--space', 's1'])).toThrow('Missing value for --url');
    expect(() => parseArgs(['stray'])).toThrow('Unexpected argument: stray');
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('loads content types from the Management API with a bearer token', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ items: MODEL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const items = await loadContentTypes(
      { url: 'https://cms.test/', space: 's 1', environment: 'main', token: 'tok' },
      fetchImpl,
    );
    expect(items).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s%201/environments/main/content-types');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('surfaces HTTP failures with the status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await expect(
      loadContentTypes(
        { url: 'https://cms.test', space: 's1', environment: 'main', token: 'bad' },
        fetchImpl,
      ),
    ).rejects.toThrow('Fetching content types failed: 401');
  });

  it('requires the full URL flag set when no --input is given', async () => {
    await expect(loadContentTypes({ url: 'https://cms.test' })).rejects.toThrow(
      '--url, --space, --environment, and --token are all required',
    );
  });

  it('loads content types from a JSON file ({ items } or bare array)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contentworker-codegen-'));
    const wrapped = join(dir, 'wrapped.json');
    const bare = join(dir, 'bare.json');
    await writeFile(wrapped, JSON.stringify({ items: MODEL }), 'utf8');
    await writeFile(bare, JSON.stringify(MODEL), 'utf8');

    expect(await loadContentTypes({ input: wrapped })).toHaveLength(3);
    expect(await loadContentTypes({ input: bare })).toHaveLength(3);
  });

  it('returns [] for bodies without items and prefers --input over URL flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contentworker-codegen-'));
    const empty = join(dir, 'empty.json');
    await writeFile(empty, JSON.stringify({}), 'utf8');

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await loadContentTypes({ input: empty, url: 'https://cms.test' }, fetchImpl)).toEqual(
      [],
    );
    expect(fetchImpl).not.toHaveBeenCalled(); // --input wins; no HTTP call

    const viaHttp = await loadContentTypes(
      { url: 'https://cms.test', space: 's1', environment: 'main', token: 't' },
      fetchImpl,
    );
    expect(viaHttp).toEqual([]);
  });

  it('end-to-end: live API in, module to stdout', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: MODEL }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    let printed = '';
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed += String(line);
    });
    try {
      const { main } = await import('../src/cli.js');
      await main([
        '--url',
        'https://cms.test',
        '--space',
        's1',
        '--environment',
        'main',
        '--token',
        't',
      ]);
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
    expect(printed).toContain('Generated by @contentworker/sdk-codegen from s1/main.');
    expect(printed).toContain('export type ArticleFields = {');
  });

  it('end-to-end: file in, generated module out via main()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contentworker-codegen-'));
    const input = join(dir, 'model.json');
    const out = join(dir, 'types.ts');
    await writeFile(input, JSON.stringify({ items: MODEL }), 'utf8');

    const { main } = await import('../src/cli.js');
    await main(['--input', input, '--out', out]);

    const written = await readFile(out, 'utf8');
    expect(written).toContain('Generated by @contentworker/sdk-codegen from');
    expect(written).toContain('export type ArticleFields = {');
  });

  it('loads the block catalog in force, and none before the first push', async () => {
    const live = { url: 'https://cms.test/', space: 's1', environment: 'main', token: 'tok' };
    const urls: string[] = [];
    const answer = (status: number, body: unknown) =>
      (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    expect(await loadBlockCatalog(live, answer(200, CATALOG))).toEqual(CATALOG);
    expect(urls[0]).toBe('https://cms.test/spaces/s1/environments/main/block-catalog');
    expect(await loadBlockCatalog(live, answer(404, { code: 'not_found' }))).toBeUndefined();
    await expect(loadBlockCatalog(live, answer(403, {}))).rejects.toThrow(
      'Fetching the block catalog failed: 403',
    );
    // From an exported model, only --blocks gives a catalog.
    const never = vi.fn() as unknown as typeof fetch;
    expect(await loadBlockCatalog({ ...live, input: 'model.json' }, never)).toBeUndefined();
    expect(never).not.toHaveBeenCalled();
  });

  it('end-to-end: --blocks types the blocks from a blocks file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contentworker-codegen-'));
    const input = join(dir, 'model.json');
    const blocks = join(dir, 'contentworker.blocks.json');
    const out = join(dir, 'types.ts');
    await writeFile(input, JSON.stringify({ items: [PAGE] }), 'utf8');
    await writeFile(blocks, JSON.stringify({ targets: [], blocks: [{ id: 'only', fields: [] }] }));
    expect(parseArgs(['--blocks', blocks])).toEqual({ blocks });

    const { main } = await import('../src/cli.js');
    await main(['--input', input, '--blocks', blocks, '--out', out]);
    const written = await readFile(out, 'utf8');
    expect(written).toContain(
      'export type BlockTypes = {\n  only: OnlyBlock;\n  banner: BannerBlock;',
    );

    await writeFile(blocks, JSON.stringify({ items: [] }));
    await expect(main(['--input', input, '--blocks', blocks])).rejects.toThrow(
      'has no "blocks" list',
    );
    await expect(main(['--input', input, '--blocks', 'contentworker.blocks.ts'])).rejects.toThrow(
      '--blocks takes a JSON file',
    );
  });
});

describe('@contentworker/sdk-codegen per-breakpoint overrides', () => {
  const BREAKPOINTS = [
    { id: 'md', name: 'Tablet', minWidth: 768 },
    { id: 'lg', name: 'Desktop', minWidth: 1280 },
  ];
  const hero = {
    id: 'hero',
    name: 'Hero',
    responsive: ['size', 'hidden'],
    fields: [
      { apiId: 'heading', type: 'Symbol' },
      { apiId: 'size', type: 'Symbol', validations: { in: ['sm', 'md', 'xl'] } },
      { apiId: 'hidden', type: 'Boolean' },
    ],
  };
  const OVERRIDES =
    "_responsive?: { readonly md?: { readonly size?: 'sm' | 'md' | 'xl'; readonly hidden?: boolean }; " +
    "readonly lg?: { readonly size?: 'sm' | 'md' | 'xl'; readonly hidden?: boolean } };";
  const strict = { strict: true, target: 'es2022', module: 'esnext' };

  it('types _responsive on a block with responsive props, and exports breakpoints', { timeout: TSC_TIMEOUT }, async () => {
    const source = generateTypes([], {
      blockCatalog: {
        blocks: [hero, { id: 'quote', fields: [{ apiId: 'text', type: 'Text' }] }],
        breakpoints: BREAKPOINTS,
      },
    });
    expect(source).toContain(OVERRIDES);
    expect(source.match(/_responsive\?/g)).toHaveLength(1);
    expect(source).toContain(
      "export const breakpoints = [\n  { id: 'md', name: 'Tablet', minWidth: 768 },\n  { id: 'lg', name: 'Desktop', minWidth: 1280 },\n] as const;",
    );
    expect(source).toContain("export type BreakpointId = (typeof breakpoints)[number]['id'];");
    const ok = [
      source,
      "const ok: HeroBlock = { _type: 'hero', _key: 'k', _responsive: { lg: { size: 'xl' } } };",
      "const id: BreakpointId = 'md';",
      'void ok; void id;',
    ].join('\n');
    expect(await tsc(ok, strict)).toBe('');
    const wrong = [
      source,
      "const no: HeroBlock = { _type: 'hero', _key: 'k', _responsive: { lg: { size: 'huge' } } };",
      'void no;',
    ].join('\n');
    expect(await tsc(wrong, strict)).toContain('TS2322');
  });

  it('types the same from the target field and its variants, slots included', () => {
    const page: ContentTypeInput = {
      apiId: 'page',
      fields: [
        {
          apiId: 'body',
          type: 'Array',
          items: {
            type: 'Component',
            breakpoints: BREAKPOINTS,
            variants: [
              {
                apiId: 'grid',
                fields: [
                  {
                    apiId: 'items',
                    type: 'Array',
                    items: {
                      type: 'Component',
                      variants: [
                        { apiId: 'hero', responsive: hero.responsive, fields: hero.fields },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const source = generateTypes([page]);
    expect(source).toContain(OVERRIDES);
    expect(source).toContain('export const breakpoints = [');
  });

  it('leaves both out without breakpoints', () => {
    const source = generateTypes([], { blockCatalog: { blocks: [hero] } });
    expect(source).not.toContain('_responsive');
    expect(source).not.toContain('export const breakpoints');
  });
});
