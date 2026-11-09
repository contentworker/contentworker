import { describe, expect, it } from 'vitest';
import {
  type BlockLock,
  blockConfigIssues,
  blockLockIssues,
  catalogVariants,
  checkBlockCatalog,
  checkBlockConfig,
  checkBlockLocks,
  defineContentType,
  diffBlockLocks,
  type EntryFields,
  staleBlockLocks,
  ValidationError,
} from '../src/index';

const symbol = (apiId: string) => ({ apiId, name: apiId, type: 'Symbol' });

const { blocks, targets } = checkBlockCatalog({
  blocks: [
    { id: 'hero', name: 'Hero', aliases: ['banner'], fields: [symbol('heading')] },
    {
      id: 'grid',
      name: 'Grid',
      fields: [symbol('label')],
      slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'] }],
    },
    { id: 'card', name: 'Card', fields: [symbol('title')], allowedParents: ['grid'] },
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
      required: false,
      position: 0,
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: true,
      required: false,
      position: 1,
      items: {
        type: 'Component',
        variants: catalogVariants(blocks, targets[0] as (typeof targets)[number]),
      },
    },
  ],
});

type Block = Record<string, unknown>;
const hero = (key: string, heading = 'Hi', type = 'hero'): Block => ({
  _type: type,
  _key: key,
  heading,
});
const card = (key: string, title = 'Card'): Block => ({ _type: 'card', _key: key, title });
const quote = (key: string): Block => ({ _type: 'quote', _key: key, text: 'Q' });
const grid = (key: string, items: Block[], label = 'G'): Block => ({
  _type: 'grid',
  _key: key,
  label,
  items,
});
const body = (en: Block[], others: Record<string, Block[]> = {}): EntryFields => ({
  body: { 'en-US': en, ...others },
});

const lock = (keys: string[], over: Partial<BlockLock> = {}): BlockLock => ({
  field: 'body',
  keys,
  depth: 'subtree',
  freeze: 'structure',
  lockedBy: 'user:1',
  lockedAt: '2026-11-09T00:00:00.000Z',
  ...over,
});

/** What the locks say of a save, as `code locale field key` lines. */
const judged = (
  locks: BlockLock[],
  before: EntryFields,
  after: EntryFields,
  locales?: readonly string[],
) =>
  blockLockIssues(PAGE, locks, before, after, locales).map(
    (i) => `${i.code} ${i.locale} ${i.field} ${i.key}`,
  );

const STORED = body([hero('h1'), hero('h2'), grid('g1', [card('c1'), card('c2')]), hero('h3')]);

describe('locked regions: judging a save', () => {
  it('lets an unchanged save, and edits outside the region, through', () => {
    const locks = [lock(['h1', 'h2'])];
    expect(judged(locks, STORED, structuredClone(STORED))).toEqual([]);
    expect(
      judged(locks, STORED, body([hero('h1'), hero('h2'), grid('g1', [card('c2')]), hero('h0')])),
    ).toEqual([]);
  });

  it('refuses a locked block removed', () => {
    expect(
      judged(
        [lock(['h1', 'h2'])],
        STORED,
        body([hero('h1'), grid('g1', [card('c1')]), hero('h3')]),
      ),
    ).toEqual(['region_locked en-US body h1']);
  });

  it('refuses a locked block swapped for another block type', () => {
    const swapped = body([hero('h1'), quote('h2'), grid('g1', [card('c1')]), hero('h3')]);
    expect(judged([lock(['h1', 'h2'])], STORED, swapped)).toEqual(['region_locked en-US body h1']);
  });

  it('takes a block renamed to its new id as the same block, not a swap', () => {
    const stored = body([hero('h1', 'Hi', 'banner')]);
    expect(judged([lock(['h1'])], stored, body([hero('h1')]))).toEqual([]);
  });

  it('refuses a block inserted between two of a run’s blocks', () => {
    const inserted = body([hero('h1'), hero('x'), hero('h2'), grid('g1', []), hero('h3')]);
    expect(judged([lock(['h1', 'h2'])], STORED, inserted)).toEqual(['region_locked en-US body h1']);
  });

  it('refuses a run reordered', () => {
    const reordered = body([hero('h2'), hero('h1'), grid('g1', [card('c1')]), hero('h3')]);
    expect(judged([lock(['h1', 'h2'])], STORED, reordered)).toEqual([
      'region_locked en-US body h1',
    ]);
  });

  it('refuses a run split across slots', () => {
    const stored = body([grid('g1', [card('c1'), card('c2')]), grid('g2', [])]);
    const split = body([grid('g1', [card('c1')]), grid('g2', [card('c2')])]);
    expect(judged([lock(['c1', 'c2'])], stored, split)).toEqual([
      'region_locked en-US body[0].items c1',
    ]);
  });

  it('lets a run move as a whole', () => {
    const moved = body([grid('g1', [card('c1')]), hero('h3'), hero('h1'), hero('h2')]);
    expect(judged([lock(['h1', 'h2'])], STORED, moved)).toEqual([]);
  });

  it('with subtree, refuses any change to a slot inside a locked block', () => {
    const locks = [lock(['g1'])];
    const added = body([hero('h1'), hero('h2'), grid('g1', [card('c1'), card('c2'), card('c3')])]);
    const reordered = body([hero('h1'), hero('h2'), grid('g1', [card('c2'), card('c1')])]);
    expect(judged(locks, STORED, added)).toEqual(['region_locked en-US body[2] g1']);
    expect(judged(locks, STORED, reordered)).toEqual(['region_locked en-US body[2] g1']);
  });

  it('with self, leaves the slots inside a locked block open', () => {
    const locks = [lock(['g1'], { depth: 'self' })];
    const added = body([hero('h1'), hero('h2'), grid('g1', [card('c2'), card('c3')]), hero('h3')]);
    expect(judged(locks, STORED, added)).toEqual([]);
  });

  it('with structure, keeps fields inside the region editable', () => {
    const edited = body([
      hero('h1', 'New'),
      hero('h2'),
      grid('g1', [card('c1', 'New'), card('c2')], 'New'),
      hero('h3'),
    ]);
    expect(judged([lock(['h1']), lock(['g1'])], STORED, edited)).toEqual([]);
  });

  it('with freeze all, refuses a field inside the region changed', () => {
    const heading = body([hero('h1', 'New'), hero('h2'), grid('g1', [card('c1'), card('c2')])]);
    const inner = body([hero('h1'), hero('h2'), grid('g1', [card('c1', 'New'), card('c2')])]);
    expect(judged([lock(['h1'], { freeze: 'all' })], STORED, heading)).toEqual([
      'region_frozen en-US body[0] h1',
    ]);
    expect(judged([lock(['g1'], { freeze: 'all' })], STORED, inner)).toEqual([
      'region_frozen en-US body[2] g1',
    ]);
  });

  it('with freeze all and self, freezes the blocks’ own fields, not their slots', () => {
    const locks = [lock(['g1'], { depth: 'self', freeze: 'all' })];
    const inner = body([hero('h1'), hero('h2'), grid('g1', [card('c1', 'New')]), hero('h3')]);
    const label = body([hero('h1'), hero('h2'), grid('g1', [card('c1'), card('c2')], 'New')]);
    expect(judged(locks, STORED, inner)).toEqual([]);
    expect(judged(locks, STORED, label)).toEqual(['region_frozen en-US body[2] g1']);
  });

  it('holds a lock in every locale holding its keys, and not where they are absent', () => {
    const stored = body([hero('h1'), hero('h2')], { 'de-DE': [hero('h1'), hero('h2')], fr: [] });
    const locks = [lock(['h1', 'h2'])];
    const changed = body([hero('h1'), hero('h2')], {
      'de-DE': [hero('h2'), hero('h1')],
      fr: [hero('x')],
    });
    expect(judged(locks, stored, changed)).toEqual(['region_locked de-DE body h1']);
    // The space's locales only, as the block config judges them.
    expect(judged(locks, stored, changed, ['en-US', 'fr'])).toEqual([]);
  });

  it('refuses a locale’s value dropped from under a held region', () => {
    const stored = body([hero('h1')], { 'de-DE': [hero('h1')] });
    expect(judged([lock(['h1'])], stored, body([hero('h1')]))).toEqual([
      'region_locked de-DE body h1',
    ]);
  });

  it('never lets a stale lock block a save', () => {
    const locks = [lock(['gone'])];
    expect(judged(locks, STORED, body([]))).toEqual([]);
    expect(staleBlockLocks(PAGE, STORED, [...locks, lock(['h1'])])).toEqual(locks);
  });

  it('judges no create, and no lock on a field the type no longer has', () => {
    expect(blockLockIssues(PAGE, [lock(['h1'])], undefined, body([]))).toEqual([]);
    expect(judged([lock(['h1'], { field: 'gone' })], STORED, body([]))).toEqual([]);
  });

  it('is judged by blockConfigIssues, with or without a catalog', () => {
    const removed = body([hero('h2')]);
    const config = {
      version: 1,
      ...checkBlockConfig({ targets: [], blocks: [] }, CATALOG),
    };
    for (const catalog of [CATALOG, null]) {
      expect(
        blockConfigIssues(PAGE, catalog, config, STORED, removed, undefined, [lock(['h1'])]).map(
          (i) => i.code,
        ),
      ).toEqual(['region_locked']);
    }
  });
});

describe('locked regions: setting locks', () => {
  const stamp = { by: 'user:2', at: '2026-11-10T00:00:00.000Z' };
  const refusal = (input: unknown, stored: BlockLock[] = [], fields = STORED): string[] => {
    try {
      checkBlockLocks(PAGE, fields, input, stored, stamp);
    } catch (err) {
      if (err instanceof ValidationError) {
        return err.issues.map((i) => `${(i as { code?: string }).code} ${i.field}`);
      }
      throw err;
    }
    throw new Error('expected the locks to be refused');
  };

  it('normalizes and stamps new locks, keeping the stamp of ones already held', () => {
    const held = lock(['h1']);
    const set = checkBlockLocks(
      PAGE,
      STORED,
      [
        { field: 'body', keys: ['h1'] },
        { field: 'body', keys: ['c1', 'c2'], freeze: 'all' },
      ],
      [held],
      stamp,
    );
    expect(set).toEqual([
      held,
      {
        field: 'body',
        keys: ['c1', 'c2'],
        depth: 'subtree',
        freeze: 'all',
        lockedBy: 'user:2',
        lockedAt: stamp.at,
      },
    ]);
  });

  it('refuses keys no locale holds, and keys that are not a run', () => {
    expect(refusal([{ field: 'body', keys: ['nope'] }])).toEqual(['lock_not_found locks[0].keys']);
    expect(refusal([{ field: 'body', keys: ['h2', 'h1'] }])).toEqual([
      'lock_not_a_run locks[0].keys',
    ]);
    expect(refusal([{ field: 'body', keys: ['h1', 'c1'] }])).toEqual([
      'lock_not_a_run locks[0].keys',
    ]);
  });

  it('keeps a stale lock it already held, and refuses a new one', () => {
    const stale = lock(['gone']);
    expect(checkBlockLocks(PAGE, STORED, [stale], [stale], stamp)).toEqual([stale]);
    expect(refusal([{ ...stale, freeze: 'all' }], [stale])).toEqual([
      'lock_not_found locks[0].keys',
    ]);
  });

  it('refuses overlapping regions: a shared block, or one inside a subtree', () => {
    expect(
      refusal([
        { field: 'body', keys: ['h1', 'h2'] },
        { field: 'body', keys: ['h2'] },
      ]),
    ).toEqual(['lock_overlaps locks[1].keys']);
    expect(
      refusal([
        { field: 'body', keys: ['g1'] },
        { field: 'body', keys: ['c1'] },
      ]),
    ).toEqual(['lock_overlaps locks[1].keys']);
    // Inside a `self` region is outside it.
    expect(
      checkBlockLocks(
        PAGE,
        STORED,
        [
          { field: 'body', keys: ['g1'], depth: 'self' },
          { field: 'body', keys: ['c1'] },
        ],
        [],
        stamp,
      ),
    ).toHaveLength(2);
  });

  it('refuses what isn’t a lock, collecting every problem', () => {
    expect(refusal({})).toEqual(['lock_invalid locks']);
    expect(
      refusal([
        'x',
        { field: 'title', keys: ['h1'] },
        { field: 'body', keys: [] },
        { field: 'body', keys: ['h1', 'h1'] },
        { field: 'body', keys: ['h1'], depth: 'deep' },
        { field: 'body', keys: ['h1'], freeze: 'some' },
      ]),
    ).toEqual([
      'lock_invalid locks[0]',
      'lock_invalid locks[1].field',
      'lock_invalid locks[2].keys',
      'lock_invalid locks[3].keys',
      'lock_invalid locks[4].depth',
      'lock_invalid locks[5].freeze',
    ]);
  });
});

describe('locked regions: what a set changed', () => {
  it('lists the regions locked and unlocked', () => {
    const a = lock(['h1']);
    const b = lock(['g1'], { freeze: 'all' });
    expect(diffBlockLocks('e1', [a], [b])).toEqual({
      entryId: 'e1',
      locked: [{ field: 'body', keys: ['g1'], depth: 'subtree', freeze: 'all' }],
      unlocked: [{ field: 'body', keys: ['h1'], depth: 'subtree', freeze: 'structure' }],
    });
  });
});
