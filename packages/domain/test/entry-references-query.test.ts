import { describe, expect, it } from 'vitest';
import {
  ANY_FIELD,
  assertQueryRespectsFieldRules,
  type EntryFields,
  ForbiddenError,
  type Principal,
  type QueryFilter,
  queryFilterIssues,
  runEntryQuery,
} from '../src/index';

// Filtering by referenced entry: `ref`/`refIn` on a field, and `*` (links_to_entry) over all.

const link = (id: string, linkType: 'Entry' | 'Asset' = 'Entry') => ({ id, linkType });

interface Row {
  readonly id: string;
  readonly fields: EntryFields;
}

const ROWS: Row[] = [
  { id: 'by-ann', fields: { author: { 'en-US': link('ann') } } },
  { id: 'by-bob', fields: { author: { 'en-US': link('bob') } } },
  { id: 'related-ann', fields: { related: { 'en-US': [link('cid'), link('ann')] } } },
  {
    id: 'body-embeds-ann',
    fields: {
      body: {
        'en-US': {
          nodeType: 'document',
          data: {},
          content: [
            { nodeType: 'embedded-entry-block', data: { target: link('ann') }, content: [] },
          ],
        },
      },
    },
  },
  { id: 'card-ann', fields: { card: { 'en-US': { heading: 'x', person: link('ann') } } } },
  // An asset with the same id is not an entry link.
  { id: 'asset-ann', fields: { author: { 'en-US': link('ann', 'Asset') } } },
  // Only the German value links to ann: an English read resolves English.
  { id: 'de-ann', fields: { author: { 'en-US': link('bob'), de: link('ann') } } },
  { id: 'none', fields: { title: { 'en-US': 'ann' } } },
];

const run = (filters: QueryFilter[], locale = 'en-US') =>
  runEntryQuery(
    ROWS,
    { filters, locale },
    (r) => r.fields,
    (r) => ({ id: r.id }),
  ).map((r) => r.id);

describe('reference filters in the query engine', () => {
  it('ref matches a link field holding the entry, and only an Entry link', () => {
    expect(run([{ field: 'author', op: 'ref', value: 'ann' }])).toEqual(['by-ann']);
  });

  it('refIn matches any of several ids, through lists of links too', () => {
    expect(run([{ field: 'related', op: 'refIn', value: ['ann', 'zed'] }])).toEqual([
      'related-ann',
    ]);
    expect(run([{ field: 'author', op: 'refIn', value: ['ann', 'bob'] }])).toEqual([
      'by-ann',
      'by-bob',
      'de-ann',
    ]);
  });

  it('reads the resolved locale, like every other field predicate', () => {
    expect(run([{ field: 'author', op: 'ref', value: 'ann' }], 'de')).toEqual(['by-ann', 'de-ann']);
  });

  it('links_to_entry (*) finds a link in any field: rich text, components, lists', () => {
    expect(run([{ field: ANY_FIELD, op: 'ref', value: 'ann' }])).toEqual([
      'by-ann',
      'related-ann',
      'body-embeds-ann',
      'card-ann',
    ]);
  });

  it('never matches a plain string holding the id', () => {
    expect(run([{ field: 'title', op: 'ref', value: 'ann' }])).toEqual([]);
  });
});

describe('reference filter validation', () => {
  it('accepts one id for ref, a list for refIn, and * for both', () => {
    expect(queryFilterIssues({ field: 'author', op: 'ref', value: 'ann' }, 'f')).toEqual([]);
    expect(queryFilterIssues({ field: '*', op: 'refIn', value: ['a', 'b'] }, 'f')).toEqual([]);
  });

  it('refuses a missing id, an empty or oversized list, * on another op, a sys field', () => {
    for (const f of [
      { field: 'author', op: 'ref', value: '' },
      { field: 'author', op: 'ref', value: ['a'] },
      { field: 'author', op: 'refIn', value: [] },
      { field: 'author', op: 'refIn', value: Array.from({ length: 101 }, (_, i) => `e${i}`) },
      { field: 'author', op: 'refIn', value: [1] },
      { field: '*', op: 'eq', value: 'a' },
      { field: 'sys.id', op: 'ref', value: 'a' },
    ] as QueryFilter[]) {
      expect(queryFilterIssues(f, 'f').length, JSON.stringify(f)).toBeGreaterThan(0);
    }
  });
});

describe('reference filters and field rules', () => {
  const restricted: Principal = {
    spaceId: 's1',
    kind: 'cda',
    scopes: ['delivery:read'],
    contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['secret'] }],
  };

  it('refuses links_to_entry where a field is hidden: it would look inside that field too', () => {
    expect(() =>
      assertQueryRespectsFieldRules(restricted, {
        contentTypeApiId: 'post',
        filters: [{ field: ANY_FIELD }],
      }),
    ).toThrow(ForbiddenError);
  });

  it('refuses ref on a hidden field and allows it on a readable one', () => {
    expect(() =>
      assertQueryRespectsFieldRules(restricted, {
        contentTypeApiId: 'post',
        filters: [{ field: 'secret' }],
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      assertQueryRespectsFieldRules(restricted, {
        contentTypeApiId: 'post',
        filters: [{ field: 'author' }],
      }),
    ).not.toThrow();
  });
});
