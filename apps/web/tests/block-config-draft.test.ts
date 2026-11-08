// Build → Blocks' rules as data: every place of the catalog with the code's rule, a draft seeded
// from the rules in force (aliases followed, stale parts left out), bounds checked against the
// code's before a save, the config a save sends (only what narrows, accepted by the domain's own
// check), and a refusal's issues by the control they name.
import {
  type BlockCatalog,
  checkBlockConfig,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
} from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  configFromDraft,
  draftErrors,
  issuesByControl,
  placesOf,
  sameConfig,
  seedDraft,
} from '~/cms/lib/block-config-draft';

const catalog = {
  version: 1,
  hash: 'h',
  pushedAt: '2026-11-01T00:00:00Z',
  pushedBy: null,
  changes: { added: [], changed: [], removed: [], renamed: [] },
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  blocks: [
    { id: 'hero', name: 'Hero', aliases: ['banner'], fields: [] },
    {
      id: 'grid',
      name: 'Grid',
      fields: [],
      slots: [
        { apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'], min: 1, max: 6 },
      ],
    },
    { id: 'card', name: 'Card', allowedParents: ['grid'], fields: [] },
    { id: 'quote', name: 'Quote', allowedParents: ['grid'], fields: [] },
  ],
} as unknown as BlockCatalog;

const places = placesOf(catalog);
const TOP = 'targets[page.body]';
const ITEMS = 'blocks[grid].slots.items';

describe('the places of a catalog', () => {
  it('lists each target and each slot with what the code allows there', () => {
    expect(places.map((p) => [p.key, p.code])).toEqual([
      [TOP, { allowed: ['hero', 'grid'] }],
      [ITEMS, { allowed: ['card', 'quote'], min: 1, max: 6 }],
    ]);
  });
});

describe('a draft', () => {
  it('starts as the code’s rule where nothing is narrowed', () => {
    const draft = seedDraft(places, effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG));
    expect(draft[TOP]).toEqual({ allowed: ['hero', 'grid'], min: '', max: '', locked: false });
    expect(draft[ITEMS]).toEqual({ allowed: ['card', 'quote'], min: '', max: '', locked: false });
    expect(configFromDraft(places, draft)).toEqual({ targets: [], blocks: [] });
  });

  it('starts from the rules in force: a former id followed, a stale part left out', () => {
    const rules = effectiveBlockRules(catalog, {
      version: 2,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['banner'], locked: true }],
      blocks: [{ block: 'grid', slots: { items: { max: 3 }, gone: { locked: true } } }],
    });
    expect(rules.stale.map((s) => s.at)).toEqual(['blocks[grid].slots.gone']);
    const draft = seedDraft(places, rules);
    expect(draft[TOP]).toEqual({ allowed: ['hero'], min: '', max: '', locked: true });
    expect(draft[ITEMS]).toMatchObject({ max: '3' });
    // Saved as it is, the stale part goes and the former id is named by the block's id.
    expect(configFromDraft(places, draft)).toEqual({
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero'], locked: true }],
      blocks: [{ block: 'grid', slots: { items: { max: 3 } } }],
    });
  });

  it('sends only what narrows, which the domain accepts as only narrower', () => {
    const draft = {
      [TOP]: { allowed: ['grid', 'hero'], min: '', max: '4', locked: false },
      [ITEMS]: { allowed: ['quote'], min: '1', max: '6', locked: true },
    };
    const sent = configFromDraft(places, draft);
    // Every block of the code chosen, and bounds equal to the code's, narrow nothing.
    expect(sent).toEqual({
      targets: [{ contentTypeApiId: 'page', field: 'body', max: 4 }],
      blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['quote'], locked: true } } }],
    });
    expect(checkBlockConfig(sent, catalog)).toEqual(sent);
  });

  it('compares by what it sends', () => {
    const a = seedDraft(places, effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG));
    const b = { ...a, [ITEMS]: { ...(a[ITEMS] as NonNullable<(typeof a)[string]>), min: '1' } };
    expect(sameConfig(places, a, b)).toBe(true);
    const c = { ...a, [ITEMS]: { ...(a[ITEMS] as NonNullable<(typeof a)[string]>), min: '2' } };
    expect(sameConfig(places, a, c)).toBe(false);
  });
});

describe('a draft’s problems', () => {
  const base = seedDraft(places, effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG));
  const withItems = (over: Record<string, unknown>) => ({
    ...base,
    [ITEMS]: { ...(base[ITEMS] as NonNullable<(typeof base)[string]>), ...over },
  });

  const errorsOf = (over: Record<string, unknown>) => draftErrors(places, withItems(over), catalog);

  it('refuses bounds wider than the code’s, never narrower ones, as the domain does', () => {
    expect(errorsOf({ min: '0' })).toEqual({
      [`${ITEMS}.min`]: "cannot be below the code's min of 1",
    });
    expect(errorsOf({ max: '7' })).toEqual({
      [`${ITEMS}.max`]: "cannot be above the code's max of 6",
    });
    expect(errorsOf({ min: '2', max: '5' })).toEqual({});
    expect(draftErrors(places, base, catalog)).toEqual({});
  });

  it('says what isn’t a count, a most of none, and a fewest over the most', () => {
    expect(errorsOf({ min: '1.5', max: '0' })).toEqual({
      [`${ITEMS}.min`]: 'A whole number, or blank for the code’s.',
      [`${ITEMS}.max`]: 'must be at least 1',
      // Under the code's least of 1, as the server says it too.
      [ITEMS]: 'min (1) is more than max (0)',
    });
    expect(errorsOf({ min: '4', max: '3' })).toEqual({
      [ITEMS]: 'min (4) is more than max (3)',
    });
  });

  it('wants at least one block', () => {
    expect(errorsOf({ allowed: [] })).toEqual({
      [`${ITEMS}.allowedChildren`]: 'names at least one block id, or is left out',
    });
  });
});

describe('a refusal', () => {
  it('lands each issue on the control it names, and the rest on the section', () => {
    expect(
      issuesByControl(places, [
        { field: `${ITEMS}.max`, message: 'cannot be above the code’s max of 6' },
        { field: TOP, message: 'min (3) is more than max (2)' },
        { field: 'blocks[gone]', message: 'No block "gone" in the catalog' },
      ]),
    ).toEqual({
      [`${ITEMS}.max`]: 'cannot be above the code’s max of 6',
      [TOP]: 'min (3) is more than max (2)',
      '': 'No block "gone" in the catalog',
    });
  });
});
