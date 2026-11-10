import { describe, expect, it } from 'vitest';
import {
  type BlockConfig,
  blockConfigIssues,
  blockRuleChanges,
  catalogVariants,
  checkBlockCatalog,
  checkBlockConfig,
  defineContentType,
  diffBlockConfigs,
  type EntryFields,
  effectiveBlockConfig,
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

describe('judging a save: what a review found', () => {
  // The top level is locked and takes grids and sections only; a grid's items take only cards.
  const LOCKED_TOP = config({
    targets: [
      { contentTypeApiId: 'page', field: 'body', blocks: ['grid', 'section'], locked: true },
    ],
    blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['card'] } } }],
  });

  it('judges a block whose _type changed under the same _key as placed', () => {
    // Nested, in a narrowed slot: a grid's card c1 becomes a quote, keeping its key.
    const before = body([grid('g1', [card('c1')])]);
    expect(judged(NARROWED, before, body([grid('g1', [{ ...quote('q'), _key: 'c1' }])]))).toEqual([
      'block_not_allowed_here en-US body[0].items[0]',
    ]);
    // The top level: grid g1 becomes a hero.
    expect(judged(NARROWED, before, body([{ ...hero('h'), _key: 'g1' }]))).toEqual([
      'block_not_allowed_here en-US body[0]',
    ]);
    // A locked slot: swapping a block for another under its key changes the slot.
    const locked = body([section('s1', [hero('h1'), grid('g1', [card('c1')])])]);
    const toGrid = body([section('s1', [grid('h1', []), grid('g1', [card('c1')])])]);
    expect(judged(NARROWED, locked, toGrid)).toEqual(['slot_locked en-US body[0].content']);
  });

  it('fills a locked target in a locale, or a field, it held no blocks in', () => {
    const en = body([grid('g1', [card('c1')])]);
    // A de value added to an entry whose top level is locked.
    expect(
      judged(LOCKED_TOP, en, body([grid('g1', [card('c1')])], { de: [grid('g2', [card('c9')])] })),
    ).toEqual([]);
    // A field that was absent, or empty, filled.
    expect(judged(LOCKED_TOP, { title: { 'en-US': 'x' } }, en)).toEqual([]);
    expect(judged(LOCKED_TOP, body([]), en)).toEqual([]);
    // Placement still holds there.
    expect(judged(LOCKED_TOP, en, body([grid('g1', [card('c1')])], { de: [hero('h1')] }))).toEqual([
      'block_not_allowed_here de body[0]',
    ]);
    // And the lock holds where the locale held blocks.
    expect(
      judged(LOCKED_TOP, en, body([grid('g1', [card('c1')]), grid('g2', [card('c2')])])),
    ).toEqual(['slot_locked en-US body']);
  });

  it('never refuses an unchanged save of a tree holding one key at two depths', () => {
    const tight = config({
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], min: 2, locked: true } } },
      ],
    });
    const stored = body([
      grid('g', [card('c1'), card('c2')]),
      section('s', [grid('g', [card('c3')])]),
    ]);
    expect(judged(tight, stored, structuredClone(stored))).toEqual([]);
    // Placement is still judged in those slots: a quote new to every grid g.
    const withQuote = body([
      grid('g', [card('c1'), card('c2'), quote('q1')]),
      section('s', [grid('g', [card('c3')])]),
    ]);
    expect(judged(tight, stored, withQuote)).toEqual([
      'block_not_allowed_here en-US body[0].items[2]',
    ]);
  });

  it('reads a slot named like an Object method as the block’s own value only', () => {
    const odd = checkBlockCatalog({
      blocks: [
        {
          id: 'box',
          name: 'Box',
          fields: [],
          slots: [{ apiId: 'constructor', name: 'Inside', allowedChildren: ['leaf'] }],
        },
        { id: 'leaf', name: 'Leaf', fields: [symbol('text')], allowedParents: ['box'] },
      ],
      targets: [{ contentTypeApiId: 'page', field: 'body' }],
    });
    const cat = { version: 1, ...odd };
    const cfg = {
      version: 1,
      ...checkBlockConfig(
        { blocks: [{ block: 'box', slots: { constructor: { max: 1, locked: true } } }] },
        cat,
      ),
    };
    expect(cfg.blocks[0]?.slots).toEqual({ constructor: { max: 1, locked: true } });
    const fixed = defineContentType({
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        PAGE.fields[0] as (typeof PAGE.fields)[number],
        {
          apiId: 'body',
          name: 'body',
          type: 'Array',
          localized: true,
          required: false,
          position: 1,
          items: {
            type: 'Component',
            variants: catalogVariants(odd.blocks, odd.targets[0] as (typeof targets)[number]),
          },
        },
      ],
    });
    const leaf = (key: string) => ({ _type: 'leaf', _key: key, text: 't' });
    // No value under the slot: the block's own nothing, never Object's constructor.
    expect(
      blockConfigIssues(fixed, cat, cfg, undefined, body([{ _type: 'box', _key: 'b1' }])),
    ).toEqual([]);
    const before = body([{ _type: 'box', _key: 'b1', constructor: [leaf('l1')] }]);
    const after = body([{ _type: 'box', _key: 'b1', constructor: [leaf('l1'), leaf('l2')] }]);
    expect(
      blockConfigIssues(fixed, cat, cfg, before, after).map((i) => `${i.code} ${i.field}`),
    ).toEqual(['slot_locked body[0].constructor', 'slot_too_many body[0].constructor']);
    expect(effectiveBlockRules(cat, cfg).blocks[0]?.slots).toMatchObject({
      constructor: { max: 1, locked: true },
    });
  });

  it('checks a ten-thousand-block slot quickly, and lists at most a hundred issues', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => quote(`q${i}`));
    const started = performance.now();
    const issues = blockConfigIssues(
      PAGE,
      CATALOG,
      NARROWED,
      body([grid('g1', [])]),
      body([grid('g1', many)]),
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(issues).toHaveLength(101);
    expect(issues.at(-1)).toMatchObject({ code: 'more_issues' });
    expect(issues.at(-1)?.message).toMatch(/and 9901 more/);
    // Unchanged, the same slot is judged as quickly, and passes.
    const stored = body([grid('g1', many)]);
    const again = performance.now();
    expect(blockConfigIssues(PAGE, CATALOG, NARROWED, stored, structuredClone(stored))).toEqual([]);
    expect(performance.now() - again).toBeLessThan(500);
  });
});

describe('bounding a config refusal', () => {
  it('names a list’s problems once, and stops listing at a hundred issues', () => {
    expect(
      refusal({ blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['x0', 'x1'] } } }] }),
    ).toEqual([
      'blocks[grid].slots.items.allowedChildren: "x0", "x1" are not blocks the code allows here (it allows "card", "quote")',
    ]);
    const blocks = Array.from({ length: 150 }, (_, i) => ({ block: `nope${i}`, slots: {} }));
    const issues = refusal({ blocks });
    expect(issues).toHaveLength(101);
    expect(issues.at(-1)).toBe(': …and 50 more');
  });
});

describe('what a set changed', () => {
  it('names parts added, removed, loosened and unlocked', () => {
    const before = {
      version: 3,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'], locked: true }],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3 } } },
        { block: 'section', slots: { content: { locked: true } } },
      ],
    };
    const after = {
      version: 4,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid', 'section'] }],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 2 } } },
        { block: 'hero', slots: { media: { locked: true } } },
      ],
    };
    expect(diffBlockConfigs(before, after)).toEqual({
      from: 3,
      to: 4,
      added: ['blocks[hero].slots.media'],
      removed: ['blocks[section].slots.content'],
      loosened: ['targets[page.body]'],
      unlocked: ['targets[page.body]', 'blocks[section].slots.content'],
    });
  });
});

describe('carrying a config to another environment', () => {
  const rulesOf = (c: { targets: unknown; blocks: unknown }) => {
    const { targets, blocks } = effectiveBlockRules(CATALOG, {
      version: 1,
      ...(c as Pick<BlockConfig, 'targets' | 'blocks'>),
    });
    return { targets, blocks };
  };

  it('keeps what is in force, follows former ids, and leaves stale parts behind, named', () => {
    const stored = {
      targets: [
        // Gone from the catalog: stale.
        { contentTypeApiId: 'post', field: 'body', blocks: ['hero'] },
        // A former id and a block no longer here: the rest of the list holds.
        { contentTypeApiId: 'page', field: 'body', blocks: ['banner', 'gone'], locked: true },
      ],
      blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['tile'], max: 3 }, old: {} } }],
    };
    const carried = effectiveBlockConfig(CATALOG, stored);
    expect(carried.targets).toEqual([
      { contentTypeApiId: 'page', field: 'body', blocks: ['hero'], locked: true },
    ]);
    expect(carried.blocks).toEqual([
      { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3 } } },
    ]);
    expect(carried.stale.map((s) => s.at)).toEqual([
      'targets[post.body]',
      'targets[page.body].blocks',
      'blocks[grid].slots.old',
    ]);
    // Laid over the same catalog, the same rules: what a copy judges saves by.
    expect(rulesOf(carried)).toEqual(rulesOf(stored));
    // And a set would take it as it stands.
    expect(checkBlockConfig(carried, CATALOG)).toEqual({
      targets: carried.targets,
      blocks: carried.blocks,
    });
  });

  it('leaves behind what is not shaped like a narrowing, rather than trusting it', () => {
    const carried = effectiveBlockConfig(CATALOG, {
      targets: [
        { contentTypeApiId: 'page', field: 'aside', max: 1 },
        { contentTypeApiId: 'page', field: 'body', min: 'lots' },
        'everything',
      ],
      blocks: { grid: true },
    });
    expect(carried.targets).toEqual([{ contentTypeApiId: 'page', field: 'aside', max: 1 }]);
    expect(carried.blocks).toEqual([]);
    expect(carried.stale.map((s) => s.at)).toEqual(['blocks', 'targets[1]', 'targets[2]']);
  });

  it('keeps a narrowing as written when it equals the code today, so it holds after a push widens it', () => {
    const stored = {
      targets: [{ contentTypeApiId: 'page', field: 'aside', blocks: ['hero', 'grid'] }],
      blocks: [{ block: 'grid', slots: { items: { max: 6 } } }],
    };
    const carried = effectiveBlockConfig(CATALOG, stored);
    expect({ targets: carried.targets, blocks: carried.blocks }).toEqual(stored);
    expect(carried.stale).toEqual([]);
    // The code widens: a new top-level block, and room for more items. Both copies still hold.
    const wider = checkBlockCatalog({
      blocks: [
        ...blocks.map((b) =>
          b.id === 'grid' ? { ...b, slots: b.slots?.map((s) => ({ ...s, max: 12 })) } : b,
        ),
        { id: 'promo', name: 'Promo', fields: [symbol('text')] },
      ],
      targets: [
        { contentTypeApiId: 'page', field: 'body' },
        { contentTypeApiId: 'page', field: 'aside', blocks: ['hero', 'grid', 'promo'] },
      ],
    });
    const next = { version: 5, ...wider };
    expect(effectiveBlockRules(next, { version: 1, ...carried })).toEqual(
      effectiveBlockRules(next, { version: 1, ...stored }),
    );
  });

  it('replaces a part a set would refuse by what is in force of it', () => {
    const tighter = checkBlockCatalog({
      blocks: blocks.map((b) =>
        b.id === 'grid' ? { ...b, slots: b.slots?.map((s) => ({ ...s, max: 4 })) } : b,
      ),
      targets,
    });
    const catalog = { version: 5, ...tighter };
    // Set when the code allowed six: above the code's four now, and so refused by a set.
    const stored = {
      targets: [],
      blocks: [{ block: 'grid', slots: { items: { max: 5, locked: true } } }],
    };
    const carried = effectiveBlockConfig(catalog, stored);
    expect(carried.blocks).toEqual([{ block: 'grid', slots: { items: { locked: true } } }]);
    expect(effectiveBlockRules(catalog, { version: 1, ...carried })).toMatchObject({
      blocks: effectiveBlockRules(catalog, { version: 1, ...stored }).blocks,
    });
  });
});

describe('what changes for editors', () => {
  const before = effectiveBlockRules(CATALOG, { version: 0, targets: [], blocks: [] });

  it('is nothing when the rules match, whatever the versions', () => {
    expect(
      blockRuleChanges(before, effectiveBlockRules({ ...CATALOG, version: 9 }, before)),
    ).toEqual([]);
  });

  it('names each target and slot that moves, and what it was', () => {
    const after = effectiveBlockRules(CATALOG, {
      version: 1,
      targets: [{ contentTypeApiId: 'page', field: 'aside', blocks: ['grid'], locked: true }],
      blocks: [{ block: 'grid', slots: { items: { max: 2 } } }],
    });
    expect(blockRuleChanges(before, after)).toEqual([
      'page.aside takes grid, locked (was: takes hero, grid)',
      'grid.slots.items takes card, quote, at least 1, at most 2 (was: takes card, quote, at least 1, at most 6)',
    ]);
    expect(blockRuleChanges(after, { targets: [], blocks: [] })).toContain('page.body is gone');
  });
});
