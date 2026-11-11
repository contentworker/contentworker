import { describe, expect, it } from 'vitest';
import {
  assignBlockKeys,
  type BlockLock,
  blockLockIssues,
  defineContentType,
  type EntryFields,
  validateEntryFields,
} from '../src/index';

/**
 * On a blocks field that declares no breakpoints, a block's stored `_responsive` (its
 * per-breakpoint overrides, docs/specs/breakpoint-overrides.md) never fails a save: validation
 * lets a well-formed one through on any block, and the save drops it. The release before
 * overrides were kept did the same for any `_responsive` at all, which is what a rollback lands
 * on: entries lose their overrides on the next save, and every one of them still saves.
 */

const symbol = (apiId: string, position = 0) => ({
  apiId,
  name: apiId,
  type: 'Symbol' as const,
  localized: false,
  required: false,
  position,
});

const PAGE = defineContentType({
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  fields: [
    symbol('title'),
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: false,
      required: false,
      position: 1,
      items: {
        type: 'Component',
        variants: [
          { apiId: 'hero', name: 'Hero', fields: [symbol('size')] },
          {
            apiId: 'section',
            name: 'Section',
            fields: [
              symbol('label'),
              {
                apiId: 'items',
                name: 'Items',
                type: 'Array',
                localized: false,
                required: false,
                position: 1,
                items: {
                  type: 'Component',
                  variants: [{ apiId: 'hero', name: 'Hero', fields: [symbol('size')] }],
                },
              },
            ],
          },
        ],
      },
    },
  ],
});

const VCTX = { defaultLocale: 'en-US', locales: ['en-US'] };
const body = (blocks: unknown[]): EntryFields => ({ body: { 'en-US': blocks } });

const stored = body([
  { _type: 'hero', _key: 'a', size: 'md', _responsive: { lg: { size: 'xl' } } },
  {
    _type: 'section',
    _key: 's',
    _responsive: { md: { label: 'x' } },
    items: [{ _type: 'hero', _key: 'b', _responsive: { xl: { size: 1 } } }],
  },
]);

describe('a block’s _responsive before anything declares breakpoints', () => {
  it('never fails validation when well formed, while any other _ key still does', () => {
    expect(validateEntryFields(PAGE, stored, VCTX)).toEqual([]);
    // What can never be an override is refused: a map that isn't one, `base`.
    expect(
      validateEntryFields(
        PAGE,
        body([
          { _type: 'hero', _responsive: 'big' },
          { _type: 'hero', _responsive: { base: {} } },
        ]),
        VCTX,
      ).map((i) => i.field),
    ).toEqual(['body[0]._responsive', 'body[1]._responsive.base']);
    expect(
      validateEntryFields(PAGE, body([{ _type: 'hero', _style: { color: 'red' } }]), VCTX),
    ).toMatchObject([{ field: 'body[0]._style' }]);
  });

  it('is dropped by the save, at any depth', () => {
    expect(assignBlockKeys(PAGE, stored, () => 'n').body?.['en-US']).toEqual([
      { _type: 'hero', _key: 'a', size: 'md' },
      { _type: 'section', _key: 's', items: [{ _type: 'hero', _key: 'b' }] },
    ]);
  });

  it('dropping it is no edit of a frozen region', () => {
    const lock: BlockLock = {
      field: 'body',
      keys: ['a'],
      depth: 'subtree',
      freeze: 'all',
      lockedBy: 'x',
      lockedAt: '2026-11-10T00:00:00.000Z',
    };
    const saved = assignBlockKeys(PAGE, stored, () => 'n');
    expect(blockLockIssues(PAGE, [lock], stored, saved)).toEqual([]);
    // A real edit still is.
    const edited = body([{ _type: 'hero', _key: 'a', size: 'sm' }, saved.body?.['en-US']?.[1]]);
    expect(blockLockIssues(PAGE, [lock], stored, edited)).toMatchObject([
      { code: 'region_frozen' },
    ]);
  });
});
