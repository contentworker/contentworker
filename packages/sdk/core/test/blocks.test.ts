import { describe, expect, it } from 'vitest';
import {
  BLOCKS_SLOT_ATTRIBUTE,
  type BlockCatalogLike,
  type BlockVariantLike,
  renderBlocks,
  resolveBlocks,
} from '../src/blocks.js';
import {
  blockKeyOf,
  CONTENT_REF_ATTRIBUTE,
  type ContentRef,
  formatFieldPath,
  parseContentRef,
  parseFieldPath,
} from '../src/index.js';
import { refAttrs, SLOT_ATTRIBUTE, slotAttrs } from '../src/live-preview.js';

const catalog: BlockCatalogLike = {
  blocks: [
    { id: 'banner', aliases: ['hero'] },
    { id: 'grid', slots: [{ apiId: 'cards' }] },
    { id: 'card', aliases: ['tile'] },
  ],
};

const body = [
  { _type: 'hero', _key: 'k1', heading: 'Hello' },
  {
    _type: 'grid',
    _key: 'k2',
    title: 'Cards',
    cards: [
      { _type: 'tile', _key: 'k3', title: 'One' },
      { _type: 'card', _key: 'k4', title: 'Two' },
    ],
  },
];

const ref: ContentRef = {
  space: 's1',
  environment: 'main',
  entryId: 'e1',
  contentType: 'page',
  field: 'body',
  locale: 'en-US',
};

describe('resolveBlocks', () => {
  it('reads a block stored under a former id as its block, from the catalog', () => {
    const { blocks } = resolveBlocks(body, { catalog });
    expect(blocks.map((b) => [b.type, b.storedType, b.key])).toEqual([
      ['banner', 'hero', 'k1'],
      ['grid', 'grid', 'k2'],
    ]);
    expect(blocks[0]?.block).toEqual({ _type: 'banner', _key: 'k1', heading: 'Hello' });
    // The stored value isn't changed in place.
    expect(body[0]?._type).toBe('hero');
    // A catalog names its blocks once, so aliases resolve in slots too.
    expect(blocks[1]?.slot('cards').blocks.map((b) => b.type)).toEqual(['card', 'card']);
  });

  it("reads aliases only in a catalog block's own slots, not in a blocks prop of its own", () => {
    const [grid] = resolveBlocks(
      [
        {
          _type: 'grid',
          _key: 'g',
          cards: [{ _type: 'tile', _key: 't1' }],
          // Not a slot the catalog gives grid: its variants are the content model's own.
          extras: [{ _type: 'tile', _key: 't2' }],
        },
      ],
      { catalog },
    ).blocks;
    expect(grid?.slot('cards').blocks[0]?.type).toBe('card');
    expect(grid?.slot('extras').blocks[0]?.type).toBe('tile');
  });

  it('refuses a preview ref whose field is not a path, rather than marking nothing', () => {
    expect(() => resolveBlocks(body, { preview: { ...ref, field: 'body]' } })).toThrow(
      'preview.field is not a field path: body]',
    );
  });

  it('prefers a block with the id over one that lists it as an alias', () => {
    const { blocks } = resolveBlocks([{ _type: 'hero', _key: 'a' }], {
      catalog: { blocks: [{ id: 'banner', aliases: ['hero'] }, { id: 'hero' }] },
    });
    expect(blocks[0]?.type).toBe('hero');
  });

  it("resolves aliases from a field's variants, each slot by its own variants", () => {
    const variants: BlockVariantLike[] = [
      { apiId: 'banner', aliases: ['hero'], fields: [{ apiId: 'heading', type: 'Symbol' }] },
      {
        apiId: 'grid',
        fields: [
          { apiId: 'title', type: 'Symbol' },
          {
            apiId: 'cards',
            type: 'Array',
            items: {
              type: 'Component',
              variants: [{ apiId: 'card', aliases: ['tile'], fields: [] }],
            },
          },
          { apiId: 'empty', type: 'Array', items: { type: 'Component', variants: [] } },
        ],
      },
    ];
    const { blocks } = resolveBlocks(body, { variants });
    expect(blocks.map((b) => b.type)).toEqual(['banner', 'grid']);
    expect(blocks[1]?.slotNames).toEqual(['cards', 'empty']);
    expect(blocks[1]?.slot('cards').blocks.map((b) => b.type)).toEqual(['card', 'card']);
    // An alias at the top level isn't one inside a slot that doesn't list it.
    const top = resolveBlocks([{ _type: 'tile', _key: 'x' }], { variants }).blocks;
    expect(top[0]?.type).toBe('tile');
  });

  it('keeps an unknown type as stored, and skips what is not a block', () => {
    const { blocks } = resolveBlocks(
      [
        { _type: 'newer', _key: 'n' },
        null,
        'text',
        { _key: 'no-type' },
        { _type: '', _key: 'empty' },
        ['nested'],
      ],
      { catalog },
    );
    expect(blocks.map((b) => [b.type, b.index])).toEqual([['newer', 0]]);
    expect(resolveBlocks('not a list').blocks).toEqual([]);
    expect(resolveBlocks(undefined).blocks).toEqual([]);
  });

  it('finds slots by definition and by holding blocks, and resolves an empty one', () => {
    const [grid] = resolveBlocks(
      [{ _type: 'grid', _key: 'g', cards: [], extra: [{ _type: 'card', _key: 'c' }], tags: ['a'] }],
      { catalog },
    ).blocks;
    expect(grid?.slotNames).toEqual(['cards', 'extra']);
    expect(grid?.slot('cards').blocks).toEqual([]);
    expect(grid?.slot('missing').blocks).toEqual([]);
    // Slots are resolved once.
    expect(grid?.slot('extra')).toBe(grid?.slot('extra'));
  });

  it('gives each block a render key unique among its siblings', () => {
    const { blocks } = resolveBlocks([
      { _type: 'a', _key: 'same' },
      { _type: 'a', _key: 'same' },
      { _type: 'a' },
    ]);
    expect(blocks.map((b) => [b.key, b.renderKey])).toEqual([
      ['same', 'same'],
      ['same', '#1'],
      [undefined, '#2'],
    ]);
  });

  it('marks ghost blocks by key, at any depth, with the attribute only in a preview', () => {
    const ghosts = { inserted: ['k3'], changed: ['k1', 'k4'], removed: ['k4'] };
    const plain = resolveBlocks(body, { catalog, ghosts });
    expect(plain.blocks.map((b) => b.ghost)).toEqual(['changed', undefined]);
    const cards = plain.blocks[1]?.slot('cards').blocks;
    expect(cards?.map((b) => b.ghost)).toEqual(['inserted', 'removed']);
    expect(cards?.[0]?.attrs).toEqual({});

    const preview = resolveBlocks(body, { catalog, ghosts, preview: ref });
    const previewCards = preview.blocks[1]?.slot('cards').blocks;
    expect(previewCards?.map((b) => b.attrs['data-cw-ghost'])).toEqual(['inserted', 'removed']);
  });

  it('adds no marks at all outside a preview render', () => {
    for (const preview of [undefined, null, false] as const) {
      const resolved = resolveBlocks(body, { catalog, preview });
      expect(resolved.attrs).toEqual({});
      expect(resolved.path).toBeUndefined();
      const [hero, grid] = resolved.blocks;
      expect(hero?.attrs).toEqual({});
      expect(hero?.path).toBeUndefined();
      expect(hero?.fieldAttrs('heading')).toEqual({});
      expect(grid?.slot('cards').attrs).toEqual({});
      expect(grid?.slot('cards').blocks[0]?.attrs).toEqual({});
    }
  });

  it('names blocks, slots and fields by key paths in a preview render', () => {
    const resolved = resolveBlocks(body, { catalog, preview: ref });
    const [hero, grid] = resolved.blocks;
    const cards = grid?.slot('cards');
    expect([resolved.path, hero?.path, grid?.path, cards?.path, cards?.blocks[0]?.path]).toEqual([
      'body',
      'body[k1]',
      'body[k2]',
      'body[k2].cards',
      'body[k2].cards[k3]',
    ]);
    const fieldRef = parseContentRef(cards?.blocks[1]?.fieldAttrs('title')['data-cw-ref']);
    expect(fieldRef).toEqual({ ...ref, field: 'body[k2].cards[k4].title' });
  });

  it('renders a slot of a block on its own from a path ref', () => {
    const resolved = resolveBlocks(body[1]?.cards, {
      preview: { ...ref, field: 'body[k2].cards' },
    });
    expect(resolved.path).toBe('body[k2].cards');
    expect(resolved.blocks[0]?.path).toBe('body[k2].cards[k3]');
  });

  it('leaves a block with no key unmarked, and everything below it', () => {
    const [block] = resolveBlocks([{ _type: 'grid', cards: [{ _type: 'card', _key: 'c' }] }], {
      catalog,
      preview: ref,
      ghosts: { inserted: ['c'] },
    }).blocks;
    expect(block?.attrs).toEqual({});
    expect(block?.fieldAttrs('title')).toEqual({});
    expect(block?.slot('cards').attrs).toEqual({});
    const [card] = block?.slot('cards').blocks ?? [];
    // Still a ghost (it has a key), but with no path to name it by.
    expect(card?.attrs).toEqual({ 'data-cw-ghost': 'inserted' });
  });
});

describe('preview marks match the live preview ref format', () => {
  const resolved = resolveBlocks(
    [
      {
        _type: 'grid',
        _key: 'a[1]%',
        cards: [{ _type: 'card', _key: '0192f-ü' }],
      },
    ],
    { catalog, preview: ref },
  );
  const [grid] = resolved.blocks;
  const slot = grid?.slot('cards');
  const [card] = slot?.blocks ?? [];

  it('uses the attribute names the channel reads', () => {
    expect(BLOCKS_SLOT_ATTRIBUTE).toBe(SLOT_ATTRIBUTE);
    expect(Object.keys(resolved.attrs)).toEqual([SLOT_ATTRIBUTE]);
    expect(Object.keys(grid?.attrs ?? {})).toEqual([CONTENT_REF_ATTRIBUTE]);
  });

  it('marks each block, slot and field exactly as refAttrs and slotAttrs would', () => {
    const path = (...steps: ({ key: string } | { field: string })[]) =>
      formatFieldPath({ field: 'body', steps });
    expect(resolved.attrs).toEqual(slotAttrs({ ...ref, field: 'body' }));
    expect(grid?.attrs).toEqual(refAttrs({ ...ref, field: path({ key: 'a[1]%' }) }));
    expect(slot?.attrs).toEqual(
      slotAttrs({ ...ref, field: path({ key: 'a[1]%' }, { field: 'cards' }) }),
    );
    expect(card?.attrs).toEqual(
      refAttrs({ ...ref, field: path({ key: 'a[1]%' }, { field: 'cards' }, { key: '0192f-ü' }) }),
    );
    expect(card?.fieldAttrs('title')).toEqual(
      refAttrs({
        ...ref,
        field: path({ key: 'a[1]%' }, { field: 'cards' }, { key: '0192f-ü' }, { field: 'title' }),
      }),
    );
  });

  it('round-trips through the parsers the admin uses', () => {
    const parsed = parseContentRef(card?.attrs['data-cw-ref']);
    expect(parsed && blockKeyOf(parsed.field)).toBe('0192f-ü');
    expect(parsed && parseFieldPath(parsed.field)).toEqual({
      field: 'body',
      steps: [{ key: 'a[1]%' }, { field: 'cards' }, { key: '0192f-ü' }],
    });
  });

  it('marks no field whose name a path cannot hold', () => {
    expect(grid?.fieldAttrs('a.b')).toEqual({});
  });
});

describe('renderBlocks', () => {
  type Types = {
    banner: { _type: 'banner'; _key: string; heading: string };
    grid: {
      _type: 'grid';
      _key: string;
      title?: string;
      cards?: { _type: 'card'; _key: string }[];
    };
  };

  it('renders each block with its function, slots with the same functions, else the fallback', () => {
    const out = renderBlocks<Types, string>([...body, { _type: 'quote', _key: 'q' }], {
      catalog,
      components: {
        banner: ({ block }) => `<h1>${block.heading}</h1>`,
        grid: ({ block, slot }) =>
          `<ul title="${block.title}">${slot('cards').items.join('')}</ul>`,
      },
      fallback: ({ block, index }) => `<!-- ${block._type} at ${index} -->`,
    });
    expect(out.items).toEqual([
      '<h1>Hello</h1>',
      '<ul title="Cards"><!-- card at 0 --><!-- card at 1 --></ul>',
      '<!-- quote at 2 -->',
    ]);
    expect(out.attrs).toEqual({});
  });

  it('skips a block with no function and no fallback, and never calls an inherited one', () => {
    const out = renderBlocks<Record<string, { _type: string }>, string>(
      [{ _type: 'toString', _key: 'a' }, { _type: 'constructor' }, { _type: 'card', _key: 'c' }],
      { components: { card: () => 'card' } },
    );
    expect(out.items).toEqual(['card']);
  });

  it('hands each slot its mark in a preview render', () => {
    const out = renderBlocks<Types, string>(body, {
      catalog,
      preview: ref,
      components: {
        grid: ({ slot }) => slot('cards').attrs['data-cw-slot'] ?? '',
      },
    });
    expect(parseContentRef(out.attrs['data-cw-slot'])?.field).toBe('body');
    expect(parseContentRef(out.items[0])?.field).toBe('body[k2].cards');
  });
});
