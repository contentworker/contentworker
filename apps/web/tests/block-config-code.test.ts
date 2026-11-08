// Build → Blocks' rules as code: the config as the API takes it (the PUT body, normalized, in a
// stable order whatever order it was given in), and each place's code rule beside the one in force
// (only the places that differ unless all are asked for, and the ignored parts of a stale config
// where they lie).
import {
  type BlockCatalog,
  checkBlockConfig,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
} from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  changedText,
  configJson,
  ignoredElsewhere,
  placesAsCode,
  placesToShow,
} from '~/cms/lib/block-config-code';
import { configFromDraft, placesOf, seedDraft } from '~/cms/lib/block-config-draft';

const catalog = {
  version: 3,
  hash: 'h',
  pushedAt: '2026-11-01T00:00:00Z',
  pushedBy: null,
  changes: { added: [], changed: [], removed: [], renamed: [] },
  targets: [
    { contentTypeApiId: 'page', field: 'body' },
    { contentTypeApiId: 'post', field: 'body' },
  ],
  blocks: [
    { id: 'hero', name: 'Hero', aliases: ['banner'], fields: [] },
    {
      id: 'grid',
      name: 'Grid',
      fields: [],
      slots: [
        { apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'], min: 1, max: 6 },
        { apiId: 'aside', name: 'Aside', allowedChildren: ['quote'] },
      ],
    },
    { id: 'card', name: 'Card', allowedParents: ['grid'], fields: [] },
    { id: 'quote', name: 'Quote', allowedParents: ['grid'], fields: [] },
  ],
} as unknown as BlockCatalog;

const places = placesOf(catalog);
const config = (c: Partial<Parameters<typeof effectiveBlockRules>[1]>) => ({
  ...EMPTY_BLOCK_CONFIG,
  version: 2,
  ...c,
});

describe('the config as code', () => {
  it('is the PUT body, in the catalog’s order and the domain’s key order, whatever it was given in', () => {
    const text = configJson(places, {
      targets: [
        { locked: true, field: 'body', contentTypeApiId: 'post' },
        { max: 4, blocks: ['hero'], field: 'body', contentTypeApiId: 'page' },
      ],
      blocks: [
        {
          block: 'grid',
          slots: { aside: { locked: true }, items: { max: 3, allowedChildren: ['card'] } },
        },
      ],
    });
    expect(text).toBe(
      [
        '{',
        '  "targets": [',
        '    {',
        '      "contentTypeApiId": "page",',
        '      "field": "body",',
        '      "blocks": [',
        '        "hero"',
        '      ],',
        '      "max": 4',
        '    },',
        '    {',
        '      "contentTypeApiId": "post",',
        '      "field": "body",',
        '      "locked": true',
        '    }',
        '  ],',
        '  "blocks": [',
        '    {',
        '      "block": "grid",',
        '      "slots": {',
        '        "items": {',
        '          "allowedChildren": [',
        '            "card"',
        '          ],',
        '          "max": 3',
        '        },',
        '        "aside": {',
        '          "locked": true',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}',
      ].join('\n'),
    );
  });

  it('is an empty config before anything is narrowed', () => {
    expect(JSON.parse(configJson(places, { targets: [], blocks: [] }))).toEqual({
      targets: [],
      blocks: [],
    });
  });

  it('of the rules in force is what the domain accepts unchanged, aliases followed, stale left out', () => {
    // Set before a push: the banner is the hero now, and the promo is gone.
    const stored = config({
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['banner'], locked: true }],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card', 'promo'], min: 2 } } },
        { block: 'gone', slots: { x: { locked: true } } },
      ],
    });
    const rules = effectiveBlockRules(catalog, stored);
    const body = configFromDraft(places, seedDraft(places, rules));
    const text = configJson(places, body);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero'], locked: true }],
      blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['card'], min: 2 } } }],
    });
    // Normalized: the domain's check gives back what it was given, key for key.
    expect(configJson(places, checkBlockConfig(parsed, catalog))).toBe(text);
  });
});

describe('each place as code', () => {
  it('is the code’s rule on both sides where nothing is narrowed', () => {
    const list = placesAsCode(places, effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG));
    expect(list.map((p) => p.place.key)).toEqual([
      'targets[page.body]',
      'targets[post.body]',
      'blocks[grid].slots.items',
      'blocks[grid].slots.aside',
    ]);
    for (const p of list) {
      expect(p.inForce).toBe(p.code);
      expect(p.changed).toEqual([]);
    }
    expect(JSON.parse(list[2]?.code ?? '')).toEqual({
      allowedChildren: ['card', 'quote'],
      min: 1,
      max: 6,
      locked: false,
    });
    expect(placesToShow(list, false)).toEqual([]);
    expect(placesToShow(list, true)).toHaveLength(4);
  });

  it('shows a target’s list as `blocks` and a slot’s as `allowedChildren`, with what changed', () => {
    const rules = effectiveBlockRules(
      catalog,
      config({
        targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'], max: 5 }],
        blocks: [{ block: 'grid', slots: { items: { max: 3, locked: true } } }],
      }),
    );
    const list = placesAsCode(places, rules);
    const [page, , items] = list;
    expect(JSON.parse(page?.code ?? '')).toEqual({ blocks: ['hero', 'grid'], locked: false });
    expect(JSON.parse(page?.inForce ?? '')).toEqual({ blocks: ['grid'], max: 5, locked: false });
    expect(page?.changed).toEqual(['blocks', 'max']);
    expect(JSON.parse(items?.inForce ?? '')).toEqual({
      allowedChildren: ['card', 'quote'],
      min: 1,
      max: 3,
      locked: true,
    });
    expect(items?.changed).toEqual(['max', 'locked']);
    expect(changedText(items?.changed ?? [])).toBe('the most, locked');
    expect(placesToShow(list, false).map((p) => p.place.key)).toEqual([
      'targets[page.body]',
      'blocks[grid].slots.items',
    ]);
  });

  it('marks a place narrowed exactly where the domain does, and words what changed there', () => {
    const configs = [
      EMPTY_BLOCK_CONFIG,
      config({ targets: [{ contentTypeApiId: 'post', field: 'body', min: 0 }] }),
      config({ targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'grid'] }] }),
      config({ blocks: [{ block: 'grid', slots: { items: { min: 1, max: 6 } } }] }),
      config({
        blocks: [{ block: 'grid', slots: { items: { min: 2 }, aside: { locked: true } } }],
      }),
    ];
    for (const c of configs) {
      for (const p of placesAsCode(places, effectiveBlockRules(catalog, c))) {
        expect(p.changed.length > 0, p.place.key).toBe(p.narrowed);
      }
    }
  });

  it('keeps the JSON lines stable, so a diff marks only what changed', () => {
    const rules = effectiveBlockRules(
      catalog,
      config({ blocks: [{ block: 'grid', slots: { items: { locked: true } } }] }),
    );
    const items = placesAsCode(places, rules)[2];
    const a = items?.code.split('\n') ?? [];
    const b = items?.inForce.split('\n') ?? [];
    expect(a.length).toBe(b.length);
    expect(a.filter((line, i) => line !== b[i])).toEqual(['  "locked": false']);
  });

  it('lists a stale part at its place, and one no place holds apart', () => {
    const stored = config({
      targets: [
        { contentTypeApiId: 'page', field: 'body', blocks: ['promo'] },
        { contentTypeApiId: 'old', field: 'body', locked: true },
      ],
    });
    const rules = effectiveBlockRules(catalog, stored);
    const list = placesAsCode(places, rules);
    const page = list[0];
    // None of its blocks are left, so the code's list applies: no difference, but it is shown.
    expect(page?.changed).toEqual([]);
    expect(page?.ignored.map((s) => s.at)).toEqual([
      'targets[page.body].blocks',
      'targets[page.body].blocks',
    ]);
    expect(placesToShow(list, false).map((p) => p.place.key)).toEqual(['targets[page.body]']);
    expect(ignoredElsewhere(places, rules.stale).map((s) => s.at)).toEqual(['targets[old.body]']);
  });

  it('lays a draft’s rules over the code the same way, with the stored stale parts', () => {
    const stored = effectiveBlockRules(
      catalog,
      config({ targets: [{ contentTypeApiId: 'old', field: 'body', locked: true }] }),
    );
    const draft = effectiveBlockRules(
      catalog,
      config({ targets: [{ contentTypeApiId: 'post', field: 'body', locked: true }] }),
    );
    const list = placesAsCode(places, draft, stored.stale);
    expect(placesToShow(list, false).map((p) => [p.place.key, p.changed])).toEqual([
      ['targets[post.body]', ['locked']],
    ]);
    expect(ignoredElsewhere(places, stored.stale)).toHaveLength(1);
  });
});
