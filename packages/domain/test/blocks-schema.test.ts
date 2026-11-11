import { describe, expect, it } from 'vitest';
import {
  ASSET_REQUEST_KEY,
  acceptsImages,
  assetRequestSites,
  blocksFieldSchema,
  blocksSchemaFor,
  type ComponentVariant,
  catalogVariants,
  checkBlockCatalog,
  defineContentType,
  draftableFieldSchema,
  effectiveBlockRules,
  type FieldDefinition,
  INLINE_SCHEMA_BUDGET,
  MAX_BLOCK_DEPTH,
  resolveAssetRequests,
} from '../src/index';

const symbol = (apiId: string, over: Partial<FieldDefinition> = {}) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  ...over,
});

// A page takes heroes, grids and sections at the top; a section holds heroes and grids; a grid
// holds cards and quotes. So a card sits three deep: section → grid → card.
const { blocks, targets } = checkBlockCatalog({
  blocks: [
    {
      id: 'hero',
      name: 'Hero',
      description: 'The big banner at the top of a page',
      fields: [
        symbol('heading', { validations: { size: { max: 60 } } }),
        { apiId: 'image', name: 'Image', type: 'Link', linkType: 'Asset' },
        { apiId: 'body', name: 'Body', type: 'RichText' },
      ],
    },
    {
      id: 'grid',
      name: 'Grid',
      fields: [],
      slots: [
        { apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'], min: 1, max: 6 },
      ],
    },
    {
      id: 'section',
      name: 'Section',
      fields: [symbol('label')],
      slots: [{ apiId: 'content', name: 'Content', allowedChildren: ['hero', 'grid'] }],
    },
    {
      id: 'card',
      name: 'Card',
      fields: [symbol('title'), { apiId: 'rank', name: 'Rank', type: 'Integer' }],
      allowedParents: ['grid'],
    },
    { id: 'quote', name: 'Quote', fields: [symbol('text')], allowedParents: ['grid'] },
    // Each needs what a model isn't asked for: never offered.
    {
      id: 'article',
      name: 'Article',
      fields: [{ apiId: 'text', name: 'Text', type: 'RichText', required: true }],
    },
    {
      id: 'download',
      name: 'Download',
      fields: [
        {
          apiId: 'file',
          name: 'File',
          type: 'Link',
          linkType: 'Asset',
          required: true,
          validations: { assetMimeTypes: ['application/pdf'] },
        },
      ],
    },
    {
      id: 'banner',
      name: 'Banner',
      fields: [
        {
          apiId: 'photo',
          name: 'Photo',
          type: 'Link',
          linkType: 'Asset',
          required: true,
          validations: { assetMimeTypes: ['image/png'] },
        },
      ],
    },
  ],
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
});
const CATALOG = { version: 1, blocks, targets };

const PAGE = defineContentType({
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: false,
      required: false,
      position: 1,
      validations: { size: { max: 10 } },
      items: { type: 'Component', variants: catalogVariants(blocks, targets[0]!) },
    },
  ],
});

type Schema = Record<string, unknown>;
/** `schema` with every `$ref` to its `$defs` replaced by the shape it names, as a model reads it. */
const inline = (schema: Schema): Schema => {
  const defs = (schema.$defs ?? {}) as Record<string, Schema>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const ref = (node as Schema).$ref;
    if (typeof ref === 'string') return walk(defs[ref.replace('#/$defs/', '')]);
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => k !== '$defs')
        .map(([k, v]) => [k, walk(v)]),
    );
  };
  return walk(schema) as Schema;
};
const props = (s: unknown) => (s as { properties: Record<string, Schema> }).properties;

const title = symbol('title') as FieldDefinition;
/** A slot `inner` holding `children`, or none. */
const slotOf = (children?: ComponentVariant[]): FieldDefinition[] =>
  children
    ? [
        {
          apiId: 'inner',
          name: 'Inner',
          type: 'Array',
          items: { type: 'Component', variants: children },
        } as FieldDefinition,
      ]
    : [];
/**
 * A blocks field six levels deep: `width` blocks at each level, each one's slot taking every block
 * of the next level, plus what `extra` adds at a level (given that level's children).
 */
const layered = (
  width: number,
  id: (level: number, i: number) => string = (l, i) => `l${l}b${i}`,
  extra: (level: number, children?: ComponentVariant[]) => ComponentVariant[] = () => [],
): ComponentVariant[] => {
  let next: ComponentVariant[] | undefined;
  for (let level = MAX_BLOCK_DEPTH; level >= 1; level--) {
    const children = next;
    next = [
      ...Array.from({ length: width }, (_, i) => ({
        apiId: id(level, i),
        name: `Level ${level} block ${i}`,
        fields: [title, ...slotOf(children)],
      })),
      ...extra(level, children),
    ];
  }
  return next as ComponentVariant[];
};
const typeWithBlocks = (fields: Record<string, ComponentVariant[]>) =>
  defineContentType({
    apiId: 'deep',
    name: 'Deep',
    displayField: 'title',
    fields: [
      title,
      ...Object.entries(fields).map(
        ([apiId, variants]) =>
          ({
            apiId,
            name: apiId,
            type: 'Array',
            items: { type: 'Component', variants },
          }) as FieldDefinition,
      ),
    ],
  });
const variantsOf = (array: unknown): Schema[] => {
  const items = (array as { items: Schema }).items;
  return (items.anyOf as Schema[] | undefined) ?? [items];
};
const ids = (array: unknown) => variantsOf(array).map((v) => props(v)._type?.const);
const variant = (array: unknown, id: string) =>
  variantsOf(array).find((v) => props(v)._type?.const === id);
const withImages = { images: true } as const;

describe('the blocks schema a model fills', () => {
  it('offers one variant per block it can fill, its _type a const, and no _key', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, withImages);
    if (!built.ok) throw new Error(built.message);
    const blocksArray = props(inline(built.schema)).blocks;
    // article needs rich text, download a PDF: neither can be generated, so neither is offered.
    expect(ids(blocksArray)).toEqual(['hero', 'grid', 'section', 'banner']);
    expect(built.offered).toEqual(['hero', 'grid', 'section', 'banner']);
    const hero = variant(blocksArray, 'hero')!;
    expect(Object.keys(props(hero))).toEqual(['_type', 'heading', 'image']);
    expect(hero.required).toEqual(['_type', 'heading', 'image']);
    expect(hero.additionalProperties).toBe(false);
    // A field's validations ride along as constraints.
    expect(props(hero).heading).toMatchObject({ type: 'string', maxLength: 60 });
    // The field's own size bounds the place.
    expect(blocksArray).toMatchObject({ type: 'array', maxItems: 10 });
    expect(JSON.stringify(built.schema)).not.toContain('_key');
  });

  it('asks for an image by what it shows, only where an image fits, and leaves rich text out', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, withImages);
    if (!built.ok) throw new Error(built.message);
    const hero = variant(props(inline(built.schema)).blocks, 'hero')!;
    expect(props(hero).image).toMatchObject({
      type: 'object',
      required: [ASSET_REQUEST_KEY],
      properties: { [ASSET_REQUEST_KEY]: { type: 'object', required: ['query'] } },
    });
    expect(props(hero).body).toBeUndefined();
    const field = (rule?: string[]) =>
      ({
        apiId: 'f',
        name: 'f',
        type: 'Link',
        linkType: 'Asset',
        localized: false,
        required: false,
        position: 0,
        ...(rule ? { validations: { assetMimeTypes: rule } } : {}),
      }) as FieldDefinition;
    expect(acceptsImages(field())).toBe(true);
    expect(acceptsImages(field(['image/*']))).toBe(true);
    expect(acceptsImages(field(['application/pdf', 'video/*']))).toBe(false);
  });

  it('asks for no image without a library search, and leaves out a block that needs one', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, {});
    if (!built.ok) throw new Error(built.message);
    expect(ids(props(inline(built.schema)).blocks)).toEqual(['hero', 'grid', 'section']);
    // The hero's image is optional: the hero stays, without it.
    expect(props(variant(props(inline(built.schema)).blocks, 'hero')).image).toBeUndefined();
  });

  it('recurses into slots with their own children and bounds, down to the component depth', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, withImages);
    if (!built.ok) throw new Error(built.message);
    const section = variant(props(inline(built.schema)).blocks, 'section')!;
    const content = props(section).content;
    expect(ids(content)).toEqual(['hero', 'grid']);
    const grid = variant(content, 'grid')!;
    const items = props(grid).items as Schema;
    expect(items).toMatchObject({ minItems: 1, maxItems: 6 });
    const card = variant(items, 'card')!;
    // Depth 3: the card's own fields, and no deeper slot to recurse into.
    expect(Object.keys(props(card))).toEqual(['_type', 'title', 'rank']);
    expect(props(card).rank).toMatchObject({ type: 'integer' });
  });

  it('narrows to the rules in force, and leaves out a block whose required slot is locked', () => {
    const rules = effectiveBlockRules(CATALOG, {
      version: 1,
      targets: [
        { contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'grid', 'section'], max: 4 },
      ],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3, locked: true } } },
        { block: 'section', slots: { content: { locked: true } } },
      ],
    });
    const built = blocksSchemaFor(PAGE, { field: 'body' }, { rules });
    if (!built.ok) throw new Error(built.message);
    expect(built.place).toEqual({ allowed: ['hero', 'grid', 'section'], max: 4, locked: false });
    const top = props(inline(built.schema)).blocks;
    // A grid must hold a card, and its slot is locked: it could never save, so it isn't offered.
    // A section's slot is optional: the section stays, its slot left out.
    expect(ids(top)).toEqual(['hero', 'section']);
    expect(top.maxItems).toBe(4);
    expect(props(variant(top, 'section')).content).toBeUndefined();
  });

  it('fills a slot where its parent sits, its bounds less what it holds', () => {
    const rules = effectiveBlockRules(CATALOG, {
      version: 1,
      targets: [],
      blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3 } } }],
    });
    // A grid at the top level, and one inside a section: the same block at two depths.
    const atTop = blocksSchemaFor(
      PAGE,
      { field: 'body', slot: [{ variant: 'grid', slot: 'items' }], held: 1 },
      { rules },
    );
    if (!atTop.ok) throw new Error(atTop.message);
    const items = props(inline(atTop.schema)).blocks;
    expect(ids(items)).toEqual(['card']);
    expect(items.maxItems).toBe(2);
    expect(items.minItems).toBeUndefined();
    const nested = blocksSchemaFor(
      PAGE,
      {
        field: 'body',
        slot: [
          { variant: 'section', slot: 'content' },
          { variant: 'grid', slot: 'items' },
        ],
      },
      { rules },
    );
    expect(nested).toMatchObject({ ok: true, offered: ['card'] });
    // A step that doesn't lead where it says is refused, not guessed at.
    expect(
      blocksSchemaFor(PAGE, {
        field: 'body',
        slot: [
          { variant: 'hero', slot: 'content' },
          { variant: 'grid', slot: 'items' },
        ],
      }),
    ).toMatchObject({ ok: false, code: 'not_a_slot' });
  });

  it('refuses a locked place, a full one, and one that is not a blocks field or slot', () => {
    const rules = effectiveBlockRules(CATALOG, {
      version: 1,
      targets: [{ contentTypeApiId: 'page', field: 'body', locked: true }],
      blocks: [],
    });
    expect(blocksSchemaFor(PAGE, { field: 'body' }, { rules })).toMatchObject({
      ok: false,
      code: 'locked',
    });
    expect(blocksFieldSchema(PAGE, 'body', { rules })).toBeUndefined();
    expect(
      blocksSchemaFor(PAGE, { field: 'body', slot: [{ variant: 'grid', slot: 'items' }], held: 6 }),
    ).toMatchObject({ ok: false, code: 'full' });
    expect(blocksSchemaFor(PAGE, { field: 'title' })).toMatchObject({
      ok: false,
      code: 'not_a_blocks_field',
    });
    expect(
      blocksSchemaFor(PAGE, { field: 'body', slot: [{ variant: 'hero', slot: 'items' }] }),
    ).toMatchObject({ ok: false, code: 'not_a_slot' });
  });

  it('describes blocks and fields through the caller’s describers', () => {
    const built = blocksSchemaFor(
      PAGE,
      { field: 'body' },
      {
        catalog: blocks,
        describe: (f) => `field ${f.name}`,
        describeBlock: (b) => `${b.name}: ${b.description ?? '-'}`,
      },
    );
    if (!built.ok) throw new Error(built.message);
    const hero = variant(props(inline(built.schema)).blocks, 'hero')!;
    expect(hero.description).toBe('Hero: The big banner at the top of a page');
    expect(props(hero).heading?.description).toBe('field heading');
  });

  it('writes today’s catalogs fully inline, a shape that repeats included', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, withImages);
    if (!built.ok) throw new Error(built.message);
    // The hero and the grid sit at the top and inside a section: written out in both places.
    expect(built.schema.$defs).toBeUndefined();
    expect(JSON.stringify(built.schema)).not.toContain('$ref');
    expect(JSON.stringify(built.schema).match(/"const":"hero"/g)).toHaveLength(2);
    expect(JSON.stringify(built.schema).length).toBeLessThanOrEqual(INLINE_SCHEMA_BUDGET);
  });

  it('grows with the blocks of a wide six-deep catalog, not with the paths through it', () => {
    const measure = (width: number) => {
      const built = blocksSchemaFor(typeWithBlocks({ body: layered(width) }), { field: 'body' });
      if (!built.ok) throw new Error(built.message);
      return { schema: built.schema, bytes: JSON.stringify(built.schema).length };
    };
    // width^6 paths reach the deepest level: 729 at width 3, already past the inline budget.
    const three = measure(3);
    const six = measure(6);
    // Each block below the top is written once; the top level's blocks occur once, inline.
    expect(Object.keys(three.schema.$defs as Schema)).toHaveLength(3 * (MAX_BLOCK_DEPTH - 1));
    expect(Object.keys(six.schema.$defs as Schema)).toHaveLength(6 * (MAX_BLOCK_DEPTH - 1));
    // Twice the blocks per level: twice the shapes, each slot listing twice the children. The
    // paths grow 64-fold (2^6).
    expect(six.bytes / three.bytes).toBeLessThan(4);
    expect(six.bytes).toBeLessThan(INLINE_SCHEMA_BUDGET);
    // The deepest blocks hold no slot, and the tree still reads to the bottom.
    let level = props(inline(six.schema)).blocks as Schema;
    for (let d = 1; d < MAX_BLOCK_DEPTH; d++) {
      level = props(variantsOf(level)[0]).inner as Schema;
    }
    expect(Object.keys(props(variantsOf(level)[0]))).toEqual(['_type', 'title']);
  });

  it('names a block’s second shape apart, and each resolves where it sits', () => {
    // A tile with a slot at the second level, and without one at the sixth: two shapes.
    const tile = (level: number, children?: ComponentVariant[]) =>
      level === 2 || level === MAX_BLOCK_DEPTH
        ? [{ apiId: 'tile', name: 'Tile', fields: [title, ...slotOf(children)] }]
        : [];
    const built = blocksSchemaFor(typeWithBlocks({ body: layered(3, undefined, tile) }), {
      field: 'body',
    });
    if (!built.ok) throw new Error(built.message);
    const defs = Object.keys(built.schema.$defs as Schema);
    expect(defs).toEqual(expect.arrayContaining(['f4_body__tile', 'f4_body__tile__2']));
    const tree = inline(built.schema);
    const second = variant(props(variantsOf(props(tree).blocks)[0]).inner, 'tile');
    expect(Object.keys(props(second))).toEqual(['_type', 'title', 'inner']);
    let fifth = variantsOf(props(tree).blocks)[0] as Schema;
    for (let d = 1; d < MAX_BLOCK_DEPTH - 1; d++)
      fifth = variantsOf(props(fifth).inner)[0] as Schema;
    expect(Object.keys(props(variant(props(fifth).inner, 'tile')))).toEqual(['_type', 'title']);
  });

  it('names shapes with letters, digits and _ only, two fields’ apart even when apiIds hold __', () => {
    // Joined by __ alone, `a__b` with `c…` and `a` with `b__c…` would name the same shapes.
    const type = typeWithBlocks({
      a__b: layered(3, (l, i) => `cL${l}B${i}`),
      a: layered(3, (l, i) => `b__cL${l}B${i}`),
    });
    const first = blocksFieldSchema(type, 'a__b');
    const second = blocksFieldSchema(type, 'a');
    const names = [...Object.keys(first?.defs ?? {}), ...Object.keys(second?.defs ?? {})];
    expect(names).toHaveLength(2 * 3 * (MAX_BLOCK_DEPTH - 1));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_]+$/);
    expect(names).toContain('f4_a__b__cL2B0');
    expect(names).toContain('f1_a__b__cL2B0');
  });

  it('builds a draftable scalar’s schema, and nothing for a field a model doesn’t fill', () => {
    expect(
      draftableFieldSchema({
        apiId: 'size',
        name: 'Size',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
        validations: { in: ['sm', 'lg'] },
      }),
    ).toEqual({ description: 'Size', type: 'string', enum: ['sm', 'lg'] });
    expect(
      draftableFieldSchema({
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 0,
      }),
    ).toBeUndefined();
  });
});

describe('image requests', () => {
  const body = PAGE.fields[1] as FieldDefinition;
  const tree = [
    { _type: 'hero', heading: 'Hi', image: { $asset: { query: ' a lighthouse at dusk ' } } },
    {
      _type: 'section',
      content: [{ _type: 'hero', heading: 'Two', image: { $asset: { query: 'a red door' } } }],
    },
    { _type: 'banner', photo: { $asset: { query: 'a red door' } } },
    // Not where the schema asks for an image: not a request.
    { _type: 'card', title: { $asset: { query: 'stray' } } },
  ];

  it('finds each request where the content model puts an image, with its rule and need', () => {
    expect(assetRequestSites(body, tree, 'body', 2)).toEqual([
      { path: 'body[2].image', query: 'a lighthouse at dusk', required: false },
      { path: 'body[3].content[0].image', query: 'a red door', required: false },
      {
        path: 'body[4].photo',
        query: 'a red door',
        required: true,
        accepts: ['image/png'],
      },
    ]);
  });

  it('links what the library found by path and leaves the rest out, naming where', () => {
    const { value, unresolved } = resolveAssetRequests(
      tree.slice(0, 2),
      new Map([['body[2].image', 'asset-1']]),
      'body',
      2,
    );
    expect(value[0]).toEqual({
      _type: 'hero',
      heading: 'Hi',
      image: { id: 'asset-1', linkType: 'Asset' },
    });
    expect((value[1] as { content: unknown[] }).content[0]).toEqual({
      _type: 'hero',
      heading: 'Two',
    });
    // Numbered after the two blocks the place held already.
    expect(unresolved).toEqual([{ path: 'body[3].content[0].image', query: 'a red door' }]);
  });
});
