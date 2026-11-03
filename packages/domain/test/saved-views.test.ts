import { describe, expect, it } from 'vitest';
import {
  canSeeSavedView,
  checkSavedViewColumns,
  checkSavedViewQuery,
  MAX_PATH_FILTERS,
  type Principal,
  type SavedView,
  savedViewEntryQuery,
  savedViewFor,
  ValidationError,
} from '../src/index';

const issues = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.issues.map((i) => `${i.field}: ${i.message}`);
    throw e;
  }
  throw new Error('expected a ValidationError');
};

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'v1',
  name: 'V',
  contentTypeApiId: 'staff',
  visibility: 'shared',
  createdBy: 'ada',
  query: {},
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const user = (subject: string, contentGrants?: Principal['contentGrants']): Principal => ({
  spaceId: 's',
  kind: 'user',
  subject,
  scopes: [],
  ...(contentGrants ? { contentGrants } : {}),
});

describe('saved view queries', () => {
  it('stores the structured form: prefixes stripped, empty parts dropped', () => {
    expect(
      checkSavedViewQuery({
        filters: [{ field: 'fields.title', op: 'match', value: 'cat' }],
        order: [{ field: 'fields.title', direction: 'asc' }],
        search: '  ',
        where: { and: [{ field: 'fields.rank', op: 'between', value: [1, 2] }] },
      }),
    ).toEqual({
      filters: [{ field: 'title', op: 'match', value: 'cat' }],
      order: [{ field: 'title', direction: 'asc' }],
      where: { and: [{ field: 'rank', op: 'between', value: [1, 2] }] },
    });
    expect(checkSavedViewQuery(undefined)).toEqual({});
  });

  it('checks top-level filters as strictly as a where tree', () => {
    expect(
      issues(() => checkSavedViewQuery({ filters: [{ field: 'tags', op: 'in', value: [] }] })),
    ).toEqual(['query.filters[0]: in takes 1 to 100 values']);
    expect(
      issues(() =>
        checkSavedViewQuery({ filters: [{ field: 'metadata.tags.slug', op: 'eq', value: 'x' }] }),
      ),
    ).toEqual(['query.filters[0]: filter tags and concepts by id in a saved view']);
    const paths = Array.from({ length: MAX_PATH_FILTERS + 1 }, (_, i) => ({
      field: `seo.f${i}`,
      op: 'exists',
    }));
    expect(issues(() => checkSavedViewQuery({ filters: paths }))).toEqual([
      `query: a view names at most ${MAX_PATH_FILTERS} component paths (seo.title)`,
    ]);
    expect(issues(() => checkSavedViewQuery({ extra: { 'a b': 1 } }))).toEqual([
      expect.stringContaining('query.extra'),
    ]);
  });

  it('keeps columns to known sys columns and the type’s own fields', () => {
    const type = { apiId: 'staff', fields: [{ apiId: 'team' }] } as never;
    expect(checkSavedViewColumns(['fields.team', 'sys.status'], type)).toEqual([
      'team',
      'sys.status',
    ]);
    expect(issues(() => checkSavedViewColumns(['team', 'team'], type))).toEqual([
      'columns[1]: "team" is listed twice',
    ]);
    expect(checkSavedViewColumns(null, type)).toBeUndefined();
  });
});

describe('who sees a saved view', () => {
  it('shows a personal view to its owner only', () => {
    const mine = view({ visibility: 'personal', createdBy: 'ada' });
    expect(canSeeSavedView(user('ada'), mine)).toBe(true);
    expect(canSeeSavedView(user('bob'), mine)).toBe(false);
    expect(canSeeSavedView({ spaceId: 's', kind: 'cma', scopes: [] }, mine)).toBe(false);
  });

  it('hides a view naming a field the role hides, and drops hidden columns', () => {
    const hidden = user('bob', [
      { contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] },
    ]);
    expect(
      canSeeSavedView(hidden, view({ query: { order: [{ field: 'salary', direction: 'asc' }] } })),
    ).toBe(false);
    expect(canSeeSavedView(hidden, view({ query: { search: 'x' } }))).toBe(false);
    expect(savedViewFor(hidden, view({ columns: ['salary', 'team'] })).columns).toEqual(['team']);
    expect(
      canSeeSavedView(user('cy', [{ contentTypeApiId: 'memo', actions: ['read'] }]), view()),
    ).toBe(false);
  });

  it('never applies kept extra keys', () => {
    expect(savedViewEntryQuery(view({ query: { extra: { me: 1 }, search: 'a' } }))).toEqual({
      contentTypeApiId: 'staff',
      search: 'a',
    });
  });
});
