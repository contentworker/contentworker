import { describe, expect, it } from 'vitest';
import {
  type BlockManifest,
  blocksUsed,
  type ContentType,
  canonicalJson,
  catalogVariants,
  checkBlockCatalog,
  defineContentType,
  diffBlockCatalogs,
  type FieldDefinition,
  planCatalogTypes,
  removedVariants,
  ValidationError,
} from '../src/index';

const symbol = (apiId: string, over: Partial<FieldDefinition> = {}) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  ...over,
});

const HERO = {
  id: 'hero',
  name: 'Hero',
  group: 'Headers',
  fields: [
    symbol('heading', { required: true }),
    symbol('size', { validations: { in: ['sm', 'md', 'lg'] } }),
  ],
};
const CARD = { id: 'card', name: 'Card', fields: [symbol('title')], allowedParents: ['grid'] };
const GRID = {
  id: 'grid',
  name: 'Grid',
  fields: [],
  slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], min: 1, max: 6 }],
};

const TARGET = { contentTypeApiId: 'page', field: 'body' };

/** The issues a catalog is refused with, as `field: message` lines. */
function refusal(blocks: unknown, targets: unknown = [TARGET]): string[] {
  try {
    checkBlockCatalog({ blocks, targets });
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => `${i.field}: ${i.message}`);
    throw err;
  }
  throw new Error('expected the catalog to be refused');
}

const page = (variants: { apiId: string; name: string; fields: FieldDefinition[] }[]) =>
  defineContentType({
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
      {
        apiId: 'body',
        name: 'Body',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: { type: 'Component', variants },
      },
    ],
  });

const placeholder = {
  apiId: 'placeholder',
  name: 'Placeholder',
  fields: [
    { apiId: 'x', name: 'x', type: 'Symbol', localized: false, required: false, position: 0 },
  ] as FieldDefinition[],
};

describe('checking a block catalog', () => {
  it('normalizes fields the way the content model stores them', () => {
    const { blocks, targets } = checkBlockCatalog({ blocks: [HERO], targets: [TARGET] });
    expect(blocks[0]?.fields[1]).toMatchObject({
      apiId: 'size',
      localized: false,
      required: false,
      position: 1,
    });
    expect(targets).toEqual([TARGET]);
  });

  it('collects every structural problem in one refusal', () => {
    const issues = refusal([
      { id: '1bad', name: 'Bad', fields: [symbol('x')] },
      { id: 'hero', name: '', fields: [] },
      { id: 'hero', name: 'Again', fields: [symbol('y')] },
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"1bad" is not a valid block id'),
        'blocks[hero].name: must be a non-empty string',
        'blocks[hero]: A block needs at least one field or slot',
        'blocks[hero]: Block id "hero" is used twice',
      ]),
    );
  });

  it('refuses free-form styling: no JSON props, and style props only as tokens', () => {
    expect(refusal([{ id: 'box', name: 'Box', fields: [symbol('css')] }])).toEqual([
      'blocks[box].css: "css" is a style prop, so it must be a token: a Symbol with validations.in',
    ]);
    expect(
      refusal([{ id: 'box', name: 'Box', fields: [{ apiId: 'theme', type: 'JSON' }] }])[0],
    ).toMatch(/cannot be JSON/);
    // A token style prop is fine.
    const ok = {
      id: 'box',
      name: 'Box',
      fields: [symbol('style', { validations: { in: ['plain', 'card'] } })],
    };
    expect(() => checkBlockCatalog({ blocks: [ok], targets: [TARGET] })).not.toThrow();
  });

  it("holds a block's props to the content model's nested rules, naming the block", () => {
    expect(
      refusal([{ id: 'hero', name: 'Hero', fields: [symbol('heading', { localized: true })] }]),
    ).toEqual([expect.stringMatching(/^blocks\[hero\]\.heading: .*cannot be localized/)]);
  });

  it('takes a thumbnail as an asset or an https URL, nothing else', () => {
    const withThumb = (thumbnail: unknown) => [{ ...HERO, thumbnail }];
    expect(
      checkBlockCatalog({
        blocks: withThumb({ url: 'https://cdn.example/hero.png' }),
        targets: [TARGET],
      }).blocks[0]?.thumbnail,
    ).toEqual({ url: 'https://cdn.example/hero.png' });
    expect(
      checkBlockCatalog({ blocks: withThumb({ assetId: 'a1' }), targets: [TARGET] }).blocks[0]
        ?.thumbnail,
    ).toEqual({ assetId: 'a1' });
    expect(refusal(withThumb({ url: 'http://cdn.example/x.png' }))[0]).toMatch(/https URL/);
    expect(refusal(withThumb({ url: 'data:image/svg+xml,<svg/>' }))[0]).toMatch(/https URL/);
    expect(refusal(withThumb({ url: 'https://u:p@cdn.example/x.png' }))[0]).toMatch(/credentials/);
    expect(refusal(withThumb('hero.png'))[0]).toMatch(/assetId.*or.*url/);
  });

  it('needs slots and parents to name blocks that exist, and to agree', () => {
    expect(refusal([GRID])).toEqual(['blocks[grid].slots.items.allowedChildren: No block "card"']);
    expect(refusal([{ ...CARD, allowedParents: ['hero'] }, HERO])).toEqual([
      'blocks[card].allowedParents: "hero" has no slot that takes "card"',
    ]);
    const strict = { ...CARD, allowedParents: ['other'] };
    const other = { ...GRID, id: 'other', name: 'Other' };
    expect(refusal([GRID, strict, other])).toEqual([
      'blocks[grid].slots.items.allowedChildren: "card" lists its allowedParents, and "grid" is not one of them',
    ]);
  });

  it('refuses a block that could end up inside itself', () => {
    const a = {
      id: 'a',
      name: 'A',
      fields: [],
      slots: [{ apiId: 's', name: 'S', allowedChildren: ['b'] }],
    };
    const b = {
      id: 'b',
      name: 'B',
      fields: [],
      slots: [{ apiId: 's', name: 'S', allowedChildren: ['a'] }],
    };
    expect(refusal([a, b])).toEqual([
      'blocks[a].slots: Blocks cannot nest inside themselves: a → b → a',
    ]);
  });

  it('checks slot bounds', () => {
    const grid = { ...GRID, slots: [{ ...GRID.slots[0], min: 3, max: 2 }] };
    expect(refusal([grid, CARD])).toEqual(['blocks[grid].slots.items: min is more than max']);
  });

  it('keeps aliases to former ids: never a current id, never two owners', () => {
    expect(refusal([{ ...HERO, aliases: ['hero'] }])).toEqual([
      'blocks[hero].aliases: A block cannot alias its own id',
    ]);
    expect(
      refusal([
        { ...HERO, aliases: ['banner'] },
        { id: 'banner', name: 'Banner', fields: [symbol('x')] },
      ]),
    ).toEqual(['blocks[hero].aliases: "banner" is the id of another block']);
  });

  it('needs targets, and refuses a top-level block that only goes inside parents', () => {
    expect(refusal([HERO], [])).toEqual([
      'targets: must name at least one { contentTypeApiId, field } the blocks go in',
    ]);
    expect(refusal([HERO, GRID, CARD], [{ ...TARGET, blocks: ['card'] }])).toEqual([
      'targets[0].blocks: "card" has allowedParents, so it only goes inside them',
    ]);
  });
});

describe('mapping a catalog onto a blocks field', () => {
  const { blocks } = checkBlockCatalog({ blocks: [HERO, GRID, CARD], targets: [TARGET] });

  it('takes every block without allowedParents at the top, slots as nested blocks fields', () => {
    const variants = catalogVariants(blocks, TARGET);
    expect(variants.map((v) => v.apiId)).toEqual(['hero', 'grid']);
    const items = variants[1]?.fields.find((f) => f.apiId === 'items');
    expect(items).toMatchObject({
      type: 'Array',
      required: true,
      validations: { size: { min: 1, max: 6 } },
      items: { type: 'Component', variants: [{ apiId: 'card', name: 'Card' }] },
    });
  });

  it('narrows the top level to the target’s blocks', () => {
    expect(catalogVariants(blocks, { ...TARGET, blocks: ['grid'] }).map((v) => v.apiId)).toEqual([
      'grid',
    ]);
  });

  it('refuses slots nested deeper than the content model allows, naming the path', () => {
    const chain = ['a', 'b', 'c', 'd'].map((id, i, all) => ({
      id,
      name: id,
      fields: [symbol('x')],
      ...(all[i + 1] ? { slots: [{ apiId: 's', name: 's', allowedChildren: [all[i + 1]] }] } : {}),
    }));
    const deep = checkBlockCatalog({ blocks: chain, targets: [TARGET] }).blocks;
    expect(() => catalogVariants(deep, { ...TARGET, blocks: ['a'] })).toThrow(ValidationError);
    try {
      catalogVariants(deep, { ...TARGET, blocks: ['a'] });
    } catch (err) {
      expect((err as ValidationError).issues[0]?.field).toBe('page.body[a].s[b].s[c].s');
    }
    // Two levels of slots below the page fit.
    expect(() => catalogVariants(deep, { ...TARGET, blocks: ['b'] })).not.toThrow();
  });

  it('plans the content types it changes, and leaves an unchanged one out', () => {
    const types = new Map<string, ContentType>([['page', page([placeholder])]]);
    const [plan] = planCatalogTypes(blocks, [TARGET], types);
    expect(plan?.changes).toEqual([
      {
        field: 'body',
        added: ['hero', 'grid'],
        changed: [],
        removed: ['placeholder'],
        renamed: [],
      },
    ]);
    expect(plan?.destructive).toBe(true);
    // Defining the planned fields is valid, and planning again over them changes nothing.
    const applied = page(
      (plan?.fields[1]?.items?.variants ?? []) as {
        apiId: string;
        name: string;
        fields: FieldDefinition[];
      }[],
    );
    expect(planCatalogTypes(blocks, [TARGET], new Map([['page', applied]]))).toEqual([]);
  });

  it('refuses a target that is missing or not a blocks field', () => {
    const types = new Map<string, ContentType>([['page', page([placeholder])]]);
    expect(() =>
      planCatalogTypes(blocks, [{ contentTypeApiId: 'page', field: 'title' }], types),
    ).toThrow(ValidationError);
    expect(() =>
      planCatalogTypes(blocks, [{ contentTypeApiId: 'nope', field: 'body' }], types),
    ).toThrow(ValidationError);
  });

  it('maps a rename through aliases: the old variant is renamed, not removed', () => {
    const before = page(catalogVariants(blocks, TARGET) as never);
    const renamed = checkBlockCatalog({
      blocks: [{ ...HERO, id: 'banner', aliases: ['hero'] }, GRID, CARD],
      targets: [TARGET],
    }).blocks;
    const [plan] = planCatalogTypes(renamed, [TARGET], new Map([['page', before]]));
    expect(plan?.changes[0]).toMatchObject({
      added: [],
      removed: [],
      renamed: [{ from: 'hero', to: 'banner' }],
    });
    expect(plan?.destructive).toBe(false);
    expect(removedVariants(before.fields, plan?.fields ?? []).size).toBe(0);
  });
});

describe('diffing catalog versions', () => {
  const QUOTE = { id: 'quote', name: 'Quote', fields: [symbol('text')] };
  const v1 = checkBlockCatalog({ blocks: [HERO, GRID, CARD, QUOTE], targets: [TARGET] }).blocks;

  it('lists added, changed, removed and renamed blocks by id', () => {
    const v2 = checkBlockCatalog({
      blocks: [
        { ...HERO, id: 'banner', aliases: ['hero'] },
        { ...GRID, name: 'Grid of cards' },
        CARD,
        { id: 'stat', name: 'Stat', fields: [symbol('value')] },
      ],
      targets: [TARGET],
    }).blocks;
    expect(diffBlockCatalogs(v1, v2)).toEqual({
      added: ['stat'],
      changed: ['grid'],
      removed: ['quote'],
      renamed: [{ from: 'hero', to: 'banner' }],
    });
    expect(diffBlockCatalogs(null, v1).added).toEqual(['hero', 'grid', 'card', 'quote']);
  });

  it('refuses a former id reused for another block', () => {
    const v2 = checkBlockCatalog({
      blocks: [{ ...HERO, id: 'banner', aliases: ['hero'] }],
      targets: [TARGET],
    }).blocks;
    const v3 = checkBlockCatalog({
      blocks: [
        { ...HERO, id: 'banner' },
        { id: 'hero', name: 'New hero', fields: [symbol('x')] },
      ],
      targets: [TARGET],
    }).blocks;
    let issues: string[] = [];
    try {
      diffBlockCatalogs(v2, v3);
    } catch (err) {
      issues = (err as ValidationError).issues.map((i) => `${i.field}: ${i.message}`);
    }
    expect(issues).toEqual([
      'blocks[hero]: "hero" was renamed to "banner"; a former id is never reused, so pick another',
    ]);
  });

  it('gives the same canonical JSON whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }),
    );
  });
});

describe('counting the blocks an entry uses', () => {
  const { blocks } = checkBlockCatalog({ blocks: [HERO, GRID, CARD], targets: [TARGET] });
  const type = page(catalogVariants(blocks, TARGET) as never);

  it('finds blocks at every depth and every locale, once each', () => {
    const used = blocksUsed(type.fields, {
      body: {
        'en-US': [
          { _type: 'hero', heading: 'Hi' },
          {
            _type: 'grid',
            items: [
              { _type: 'card', title: 'A' },
              { _type: 'card', title: 'B' },
            ],
          },
        ],
        'de-DE': [{ _type: 'hero', heading: 'Hallo' }],
      },
    });
    expect([...used].sort()).toEqual(['card', 'grid', 'hero']);
  });

  it('counts a block stored under a former id as its block', () => {
    const renamed = checkBlockCatalog({
      blocks: [{ ...HERO, id: 'banner', aliases: ['hero'] } as BlockManifest],
      targets: [TARGET],
    }).blocks;
    const t = page(catalogVariants(renamed, TARGET) as never);
    expect([
      ...blocksUsed(t.fields, { body: { 'en-US': [{ _type: 'hero', heading: 'x' }] } }),
    ]).toEqual(['banner']);
  });
});
