import { describe, expect, it } from 'vitest';
import {
  type BlockConfig,
  blockConfigIssues,
  catalogVariants,
  checkBlockCatalog,
  checkBlockConfig,
  defineContentType,
  type EntryFields,
  effectiveBlockRules,
  ValidationError,
} from '../src/index';

const symbol = (apiId: string) => ({ apiId, name: apiId, type: 'Symbol' });

// hero and section go at the top of a page; grid too, and inside a section; card and quote only
// inside a grid.
const { blocks, targets } = checkBlockCatalog({
  blocks: [
    { id: 'hero', name: 'Hero', aliases: ['banner'], fields: [symbol('heading')] },
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
      aliases: ['tile'],
      fields: [symbol('title')],
      allowedParents: ['grid'],
    },
    { id: 'quote', name: 'Quote', fields: [symbol('text')], allowedParents: ['grid'] },
  ],
  targets: [
    { contentTypeApiId: 'page', field: 'body' },
    { contentTypeApiId: 'page', field: 'aside', blocks: ['hero', 'grid'] },
  ],
});
const CATALOG = { version: 4, blocks, targets };

const blocksField = (apiId: string, position: number, target: (typeof targets)[number]) => ({
  apiId,
  name: apiId,
  type: 'Array' as const,
  localized: true,
  required: false,
  position,
  items: { type: 'Component' as const, variants: catalogVariants(blocks, target) },
});
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
      required: false,
      position: 0,
    },
    blocksField('body', 1, targets[0] as (typeof targets)[number]),
    blocksField('aside', 2, targets[1] as (typeof targets)[number]),
  ],
});

/** The issues a config is refused with, as `field: message` lines. */
function refusal(input: { targets?: unknown; blocks?: unknown }, catalog = CATALOG): string[] {
  try {
    checkBlockConfig({ targets: input.targets, blocks: input.blocks }, catalog);
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => `${i.field}: ${i.message}`);
    throw err;
  }
  throw new Error('expected the config to be refused');
}

const config = (input: { targets?: unknown; blocks?: unknown }): BlockConfig => ({
  version: 1,
  ...checkBlockConfig({ targets: input.targets, blocks: input.blocks }, CATALOG),
  updatedAt: null,
  updatedBy: null,
});

// --- blocks as an entry stores them ---

type Block = Record<string, unknown>;
const hero = (key: string, heading = 'Hi'): Block => ({ _type: 'hero', _key: key, heading });
const card = (key: string, title = 'Card'): Block => ({ _type: 'card', _key: key, title });
const quote = (key: string): Block => ({ _type: 'quote', _key: key, text: 'Q' });
const grid = (key: string, items: Block[]): Block => ({ _type: 'grid', _key: key, items });
const section = (key: string, content: Block[]): Block => ({
  _type: 'section',
  _key: key,
  label: 'S',
  content,
});
const body = (en: Block[], others: Record<string, Block[]> = {}): EntryFields => ({
  body: { 'en-US': en, ...others },
});

/** What the config says of a save, as `code locale field` lines. */
function judged(
  cfg: BlockConfig,
  before: EntryFields | undefined,
  after: EntryFields,
  locales?: readonly string[],
): string[] {
  return blockConfigIssues(PAGE, CATALOG, cfg, before, after, locales).map(
    (i) => `${i.code} ${i.locale} ${i.field}`,
  );
}

const NARROWED = config({
  targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid', 'section'] }],
  blocks: [
    { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3 } } },
    { block: 'section', slots: { content: { locked: true } } },
  ],
});

describe('checking a block config', () => {
  it('normalizes a valid narrowing: unknown keys and narrowings of nothing dropped', () => {
    const out = checkBlockConfig(
      {
        targets: [
          { contentTypeApiId: 'page', field: 'body', blocks: ['section', 'grid'], note: 'x' },
          { contentTypeApiId: 'page', field: 'aside', locked: false },
        ],
        blocks: [
          { block: 'grid', slots: { items: { allowedChildren: ['card'], min: 2, max: 4 } } },
          { block: 'section', slots: { content: { locked: true, extra: 1 } } },
        ],
      },
      CATALOG,
    );
    expect(out).toEqual({
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['section', 'grid'] }],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], min: 2, max: 4 } } },
        { block: 'section', slots: { content: { locked: true } } },
      ],
    });
  });

  it('accepts an empty config, with or without a catalog', () => {
    expect(checkBlockConfig({ targets: [], blocks: [] }, CATALOG)).toEqual({
      targets: [],
      blocks: [],
    });
    expect(checkBlockConfig({ targets: undefined, blocks: undefined }, null)).toEqual({
      targets: [],
      blocks: [],
    });
  });

  it('refuses every widening', () => {
    expect(
      refusal({
        targets: [
          // card only goes inside a grid, so the code never allows it at the top.
          { contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'card'] },
          { contentTypeApiId: 'page', field: 'aside', blocks: [] },
        ],
        blocks: [
          {
            block: 'grid',
            slots: { items: { allowedChildren: ['card', 'hero'], min: 0, max: 7 } },
          },
          { block: 'section', slots: { content: { max: 0 } } },
        ],
      }),
    ).toEqual([
      'targets[page.body].blocks: "card" is not a block the code allows here (it allows "hero", "grid", "section")',
      'targets[page.aside].blocks: names at least one block id, or is left out',
      'blocks[grid].slots.items.allowedChildren: "hero" is not a block the code allows here (it allows "card", "quote")',
      "blocks[grid].slots.items.min: cannot be below the code's min of 1",
      "blocks[grid].slots.items.max: cannot be above the code's max of 6",
      'blocks[section].slots.content.max: must be at least 1',
    ]);
  });

  it('refuses bounds that cross, against the code’s as well as each other', () => {
    expect(refusal({ blocks: [{ block: 'grid', slots: { items: { min: 4, max: 3 } } }] })).toEqual([
      'blocks[grid].slots.items: min (4) is more than max (3)',
    ]);
    // max 6 from the code, min 5 from the config is fine; min 7 is refused by the code's max.
    expect(refusal({ blocks: [{ block: 'grid', slots: { items: { min: 7 } } }] })).toEqual([
      'blocks[grid].slots.items: min (7) is more than max (6)',
    ]);
  });

  it('refuses names the catalog in force does not have', () => {
    expect(
      refusal({
        targets: [
          { contentTypeApiId: 'post', field: 'body' },
          { contentTypeApiId: 'page', field: 'body', locked: true },
          { contentTypeApiId: 'page', field: 'body', locked: true },
        ],
        blocks: [
          { block: 'gallery', slots: {} },
          { block: 'banner', slots: {} },
          { block: 'hero', slots: {} },
          { block: 'grid', slots: { cells: { locked: true } } },
          { block: 'grid', slots: {} },
          { block: 'section', slots: { content: { allowedChildren: ['tile'] } } },
        ],
      }),
    ).toEqual([
      'targets[post.body]: post.body is not a target of the block catalog',
      'targets[page.body]: page.body is narrowed twice',
      'blocks[gallery]: No block "gallery" in the catalog',
      'blocks[banner]: "banner" is a former id of "hero"; name the block by its id',
      'blocks[hero]: "hero" has no slots to narrow',
      'blocks[grid].slots.cells: "grid" has no slot "cells" (its slots: "items")',
      'blocks[grid]: "grid" is narrowed twice',
      'blocks[section].slots.content.allowedChildren: "tile" is not a block the code allows here (it allows "hero", "grid")',
    ]);
    expect(
      refusal({ targets: [{ contentTypeApiId: 'page', field: 'body' }] }, null as never),
    ).toEqual(['targets[page.body]: page.body is not a target of the block catalog']);
  });

  it('refuses malformed input and oversized lists', () => {
    expect(refusal({ targets: {}, blocks: 'grid' })).toEqual([
      'targets: must be a list of { contentTypeApiId, field } narrowings',
      'blocks: must be a list of { block, slots } narrowings',
    ]);
    expect(
      refusal({ blocks: [{ block: 'grid', slots: { items: { locked: 'yes', min: 1.5 } } }] }),
    ).toEqual([
      'blocks[grid].slots.items.min: must be a whole number',
      'blocks[grid].slots.items.locked: must be true or false',
    ]);
    const many = Array.from({ length: 21 }, () => ({ contentTypeApiId: 'page', field: 'body' }));
    expect(refusal({ targets: many })[0]).toBe('targets: A config narrows at most 20 targets');
  });
});

describe('the rules in force', () => {
  it('lays the config over every target and slot of the catalog, never wider', () => {
    const rules = effectiveBlockRules(CATALOG, NARROWED);
    expect(rules.catalogVersion).toBe(4);
    expect(rules.configVersion).toBe(1);
    expect(rules.targets).toEqual([
      {
        contentTypeApiId: 'page',
        field: 'body',
        blocks: ['grid', 'section'],
        locked: false,
        narrowed: true,
      },
      {
        contentTypeApiId: 'page',
        field: 'aside',
        blocks: ['hero', 'grid'],
        locked: false,
        narrowed: false,
      },
    ]);
    expect(rules.blocks).toEqual([
      {
        block: 'grid',
        slots: {
          items: { allowedChildren: ['card'], min: 1, max: 3, locked: false, narrowed: true },
        },
      },
      {
        block: 'section',
        slots: { content: { allowedChildren: ['hero', 'grid'], locked: true, narrowed: true } },
      },
    ]);
    expect(rules.stale).toEqual([]);
  });

  it('reports what the catalog no longer has as stale, ignores it, and follows renames', () => {
    // As a config set against an older catalog could hold: nothing here is checked again.
    const old: BlockConfig = {
      version: 7,
      targets: [
        { contentTypeApiId: 'post', field: 'body', locked: true },
        // banner is hero's former id: still hero, not stale. quote was never allowed at the top.
        { contentTypeApiId: 'page', field: 'aside', blocks: ['banner', 'quote'] },
      ],
      blocks: [
        { block: 'gallery', slots: { images: { locked: true } } },
        { block: 'hero', slots: { media: { locked: true } } },
        {
          block: 'grid',
          slots: { items: { allowedChildren: ['tile'], min: 8 }, cells: { locked: true } },
        },
        { block: 'section', slots: { content: { allowedChildren: ['video'] } } },
      ],
      updatedAt: null,
      updatedBy: null,
    };
    const rules = effectiveBlockRules(CATALOG, old);
    expect(rules.targets[1]).toMatchObject({ field: 'aside', blocks: ['hero'], narrowed: true });
    // tile is card's former id, so the narrowing holds; the impossible min falls back to the code.
    expect(rules.blocks[0]?.slots.items).toEqual({
      allowedChildren: ['card'],
      min: 1,
      max: 6,
      locked: false,
      narrowed: true,
    });
    expect(rules.blocks[1]?.slots.content).toMatchObject({
      allowedChildren: ['hero', 'grid'],
      narrowed: false,
    });
    expect(rules.stale).toEqual([
      { at: 'targets[post.body]', message: 'post.body is no longer a catalog target' },
      { at: 'blocks[gallery]', message: 'No block "gallery" in the catalog' },
      { at: 'blocks[hero]', message: '"hero" has no slots any more' },
      {
        at: 'targets[page.aside].blocks',
        message: 'The catalog no longer allows "quote" here',
      },
      { at: 'blocks[grid].slots.cells', message: '"grid" has no slot "cells" any more' },
      {
        at: 'blocks[grid].slots.items',
        message: 'Its min and max no longer fit the code’s, so the code’s apply',
      },
      {
        at: 'blocks[section].slots.content.allowedChildren',
        message: 'The catalog no longer allows "video" here',
      },
      {
        at: 'blocks[section].slots.content.allowedChildren',
        message:
          'None of the blocks it names are allowed here any more, so the code’s list applies',
      },
    ]);
  });

  it('is the code’s own rules before any config, and nothing before any catalog', () => {
    const rules = effectiveBlockRules(CATALOG, { version: 0, targets: [], blocks: [] });
    expect(rules.targets.every((t) => !t.narrowed && !t.locked)).toBe(true);
    expect(rules.blocks[0]?.slots.items).toEqual({
      allowedChildren: ['card', 'quote'],
      min: 1,
      max: 6,
      locked: false,
      narrowed: false,
    });
    const none = effectiveBlockRules(null, NARROWED);
    expect(none).toMatchObject({ catalogVersion: null, targets: [], blocks: [] });
    expect(none.stale.map((s) => s.at)).toEqual([
      'targets[page.body]',
      'blocks[grid]',
      'blocks[section]',
    ]);
  });
});

describe('judging a save against the config', () => {
  it('refuses a block inserted where the narrowed list does not take it', () => {
    const before = body([grid('g1', [card('c1')])]);
    expect(judged(NARROWED, before, body([grid('g1', [card('c1')]), hero('h1')]))).toEqual([
      'block_not_allowed_here en-US body[1]',
    ]);
    // A block the list takes is fine.
    expect(judged(NARROWED, before, body([grid('g1', [card('c1')]), section('s1', [])]))).toEqual(
      [],
    );
  });

  it('carries the block’s key and a message naming what the slot takes', () => {
    const [issue] = blockConfigIssues(PAGE, CATALOG, NARROWED, body([]), body([hero('h1')]));
    expect(issue).toEqual({
      field: 'body[0]',
      locale: 'en-US',
      code: 'block_not_allowed_here',
      key: 'h1',
      message: '"Hero" can\'t go here: this slot takes "grid", "section"',
    });
  });

  it('refuses a block moved into a slot that does not take it', () => {
    const before = body([grid('g1', [card('c1')]), grid('g2', [card('c2'), quote('q1')])]);
    const after = body([grid('g1', [card('c1'), quote('q1')]), grid('g2', [card('c2')])]);
    expect(judged(NARROWED, before, after)).toEqual([
      'block_not_allowed_here en-US body[0].items[1]',
    ]);
  });

  it('judges a block stored under a former id as its block', () => {
    const banner = { _type: 'banner', _key: 'b1', heading: 'Old' };
    expect(judged(NARROWED, body([]), body([banner]))).toEqual([
      'block_not_allowed_here en-US body[0]',
    ]);
    const tile = { _type: 'tile', _key: 't1', title: 'Old' };
    expect(
      judged(NARROWED, body([grid('g1', [card('c1')])]), body([grid('g1', [card('c1'), tile])])),
    ).toEqual([]);
  });

  it('keeps stored content the config would not allow saveable while its slot is left alone', () => {
    // Saved before the config: a hero at the top, a quote in a grid, five cards in another.
    const cards = ['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => card(k));
    const before = body([hero('h1'), grid('g1', [quote('q1')]), grid('g2', cards)]);
    // Edited inside, reordered, the cards retitled: nothing placed, no count changed.
    const after = body([
      grid('g2', cards.map((c) => ({ ...c, title: 'New' })).reverse()),
      hero('h1', 'Edited'),
      grid('g1', [{ ...quote('q1'), text: 'Edited' }]),
    ]);
    expect(judged(NARROWED, before, after)).toEqual([]);
  });

  it('refuses any change to a locked slot’s blocks, never an edit inside one', () => {
    const before = body([section('s1', [hero('h1'), grid('g1', [card('c1')])])]);
    const content = (blocks: Block[]) => body([section('s1', blocks)]);
    const locked = ['slot_locked en-US body[0].content'];
    // Insert, remove, reorder.
    expect(
      judged(NARROWED, before, content([hero('h1'), grid('g1', [card('c1')]), hero('h2')])),
    ).toEqual(locked);
    expect(judged(NARROWED, before, content([grid('g1', [card('c1')])]))).toEqual(locked);
    expect(judged(NARROWED, before, content([grid('g1', [card('c1')]), hero('h1')]))).toEqual(
      locked,
    );
    // Moved out to the top of the page (where grid is allowed).
    expect(
      judged(NARROWED, before, body([section('s1', [hero('h1')]), grid('g1', [card('c1')])])),
    ).toEqual(locked);
    // Inside the locked slot's blocks, anything goes: a heading, a card in the grid's own slot.
    expect(
      judged(NARROWED, before, content([hero('h1', 'New'), grid('g1', [card('c1'), card('c2')])])),
    ).toEqual([]);
    // The section itself moving keeps its slot: the slot is the section's, by key.
    expect(
      judged(
        NARROWED,
        before,
        body([grid('g9', [card('c9')]), section('s1', [hero('h1'), grid('g1', [card('c1')])])]),
      ),
    ).toEqual([]);
  });

  it('fills a locked slot that comes with a newly placed block', () => {
    const before = body([]);
    expect(judged(NARROWED, before, body([section('s2', [hero('h1')])]))).toEqual([]);
  });

  it('checks min and max only when the save changes the count, and lets it move toward them', () => {
    const cards = (n: number) => Array.from({ length: n }, (_, i) => card(`c${i}`));
    const before = body([grid('g1', cards(5))]);
    // Five cards stored before max: 3. Retitled: fine.
    expect(
      judged(
        NARROWED,
        before,
        body([
          grid(
            'g1',
            cards(5).map((c) => ({ ...c, title: 'x' })),
          ),
        ]),
      ),
    ).toEqual([]);
    // One more: refused. One fewer: closer to the bounds, so fine.
    expect(judged(NARROWED, before, body([grid('g1', [...cards(5), card('c9')])]))).toEqual([
      'slot_too_many en-US body[0].items',
    ]);
    expect(judged(NARROWED, before, body([grid('g1', cards(4))]))).toEqual([]);

    const twoMin = config({ blocks: [{ block: 'grid', slots: { items: { min: 2 } } }] });
    const one = body([grid('g1', [card('c1')])]);
    expect(judged(twoMin, one, body([grid('g1', [card('c1', 'x')])]))).toEqual([]);
    expect(judged(twoMin, one, body([grid('g1', [])]))).toEqual([
      'slot_too_few en-US body[0].items',
    ]);
    expect(judged(twoMin, one, body([grid('g1', [card('c1'), card('c2')])]))).toEqual([]);
    // A new grid is counted as it comes.
    expect(judged(twoMin, one, body([grid('g1', [card('c1')]), grid('g2', [card('c2')])]))).toEqual(
      ['slot_too_few en-US body[1].items'],
    );
  });

  it('holds a create to every placement and count', () => {
    const cards = ['a', 'b', 'c', 'd'].map((k) => card(k));
    expect(
      judged(
        NARROWED,
        undefined,
        body([hero('h1'), grid('g1', cards), section('s1', [hero('h2')])]),
      ),
    ).toEqual(['block_not_allowed_here en-US body[0]', 'slot_too_many en-US body[1].items']);
    // A field the create leaves empty isn't counted: required says whether it must be there.
    const minOne = config({ targets: [{ contentTypeApiId: 'page', field: 'body', min: 1 }] });
    expect(judged(minOne, undefined, { title: { 'en-US': 'x' } })).toEqual([]);
    expect(judged(minOne, undefined, body([]))).toEqual(['slot_too_few en-US body']);
  });

  it('judges nested slots at their own path', () => {
    const before = body([section('s1', [grid('g1', [card('c1')])])]);
    const after = body([section('s1', [grid('g1', [card('c1'), quote('q1')])])]);
    expect(judged(NARROWED, before, after)).toEqual([
      'block_not_allowed_here en-US body[0].content[0].items[1]',
    ]);
  });

  it('judges each locale on its own, and only the locales asked for', () => {
    const before = body([grid('g1', [card('c1')])], { de: [grid('g1', [card('c1')])] });
    const after = body([grid('g1', [card('c1')])], { de: [grid('g1', [card('c1')]), hero('h1')] });
    expect(judged(NARROWED, before, after)).toEqual(['block_not_allowed_here de body[1]']);
    expect(judged(NARROWED, before, after, ['en-US'])).toEqual([]);
  });

  it('leaves types and fields that are not catalog targets alone', () => {
    const post = defineContentType({ ...PAGE, apiId: 'post' });
    expect(blockConfigIssues(post, CATALOG, NARROWED, body([]), body([hero('h1')]))).toEqual([]);
    expect(blockConfigIssues(PAGE, null, NARROWED, body([]), body([hero('h1')]))).toEqual([]);
  });
});
