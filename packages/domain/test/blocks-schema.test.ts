import { describe, expect, it } from 'vitest';
import {
  ASSET_REQUEST_KEY,
  assetRequestsIn,
  blocksFieldSchema,
  blocksSchemaFor,
  catalogVariants,
  checkBlockCatalog,
  defineContentType,
  draftableFieldSchema,
  effectiveBlockRules,
  type FieldDefinition,
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
const props = (s: unknown) => (s as { properties: Record<string, Schema> }).properties;
const variantsOf = (array: unknown): Schema[] => {
  const items = (array as { items: Schema }).items;
  return (items.anyOf as Schema[] | undefined) ?? [items];
};
const variant = (array: unknown, id: string) =>
  variantsOf(array).find((v) => props(v)._type?.const === id);

describe('the blocks schema a model fills', () => {
  it('offers one variant per block the place takes, its _type a const, and no _key', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, { rules: null });
    if (!built.ok) throw new Error(built.message);
    const blocksArray = props(built.schema).blocks;
    expect(variantsOf(blocksArray).map((v) => props(v)._type?.const)).toEqual([
      'hero',
      'grid',
      'section',
    ]);
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

  it('asks for an image by what it shows, and leaves rich text out', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, {});
    if (!built.ok) throw new Error(built.message);
    const hero = variant(props(built.schema).blocks, 'hero')!;
    expect(props(hero).image).toMatchObject({
      type: 'object',
      required: [ASSET_REQUEST_KEY],
      properties: {
        [ASSET_REQUEST_KEY]: { type: 'object', required: ['query'] },
      },
    });
    expect(props(hero).body).toBeUndefined();
  });

  it('recurses into slots with their own children and bounds, down to the component depth', () => {
    const built = blocksSchemaFor(PAGE, { field: 'body' }, {});
    if (!built.ok) throw new Error(built.message);
    const section = variant(props(built.schema).blocks, 'section')!;
    const content = props(section).content;
    expect(variantsOf(content).map((v) => props(v)._type?.const)).toEqual(['hero', 'grid']);
    const grid = variant(content, 'grid')!;
    const items = props(grid).items as Schema;
    expect(items).toMatchObject({ minItems: 1, maxItems: 6 });
    const card = variant(items, 'card')!;
    // Depth 3: the card's own fields, and no deeper slot to recurse into.
    expect(Object.keys(props(card))).toEqual(['_type', 'title', 'rank']);
    expect(props(card).rank).toMatchObject({ type: 'integer' });
  });

  it('narrows to the rules in force, and leaves a locked slot out of a new block', () => {
    const rules = effectiveBlockRules(CATALOG, {
      version: 1,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'section'], max: 4 }],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3 } } },
        { block: 'section', slots: { content: { locked: true } } },
      ],
    });
    const built = blocksSchemaFor(PAGE, { field: 'body' }, { rules });
    if (!built.ok) throw new Error(built.message);
    expect(built.place).toEqual({ allowed: ['hero', 'section'], max: 4, locked: false });
    const top = props(built.schema).blocks;
    expect(variantsOf(top).map((v) => props(v)._type?.const)).toEqual(['hero', 'section']);
    expect(top.maxItems).toBe(4);
    expect(props(variant(top, 'section')).content).toBeUndefined();

    // The grid's own slot, generated into directly, takes cards only, three at most.
    const slot = blocksSchemaFor(
      PAGE,
      { field: 'body', parent: { variant: 'grid', slot: 'items' }, held: 1 },
      { rules },
    );
    if (!slot.ok) throw new Error(slot.message);
    const items = props(slot.schema).blocks;
    expect(variantsOf(items).map((v) => props(v)._type?.const)).toEqual(['card']);
    // One block is there already: one more needed for min 1 is met, two more fit.
    expect(items.maxItems).toBe(2);
    expect(items.minItems).toBeUndefined();
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
      blocksSchemaFor(PAGE, { field: 'body', parent: { variant: 'grid', slot: 'items' }, held: 6 }),
    ).toMatchObject({ ok: false, code: 'full' });
    expect(blocksSchemaFor(PAGE, { field: 'title' })).toMatchObject({
      ok: false,
      code: 'not_a_blocks_field',
    });
    expect(
      blocksSchemaFor(PAGE, { field: 'body', parent: { variant: 'hero', slot: 'items' } }),
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
    const hero = variant(props(built.schema).blocks, 'hero')!;
    expect(hero.description).toBe('Hero: The big banner at the top of a page');
    expect(props(hero).heading?.description).toBe('field heading');
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
  const tree = [
    { _type: 'hero', heading: 'Hi', image: { $asset: { query: 'a lighthouse at dusk' } } },
    {
      _type: 'section',
      content: [{ _type: 'hero', heading: 'Two', image: { $asset: { query: 'a red door' } } }],
    },
  ];

  it('lists each query once, in order', () => {
    expect(assetRequestsIn([...tree, tree[0]])).toEqual(['a lighthouse at dusk', 'a red door']);
  });

  it('links what the library found and leaves the rest out, naming where', () => {
    const { value, unresolved } = resolveAssetRequests(
      tree,
      new Map([['a lighthouse at dusk', 'asset-1']]),
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
