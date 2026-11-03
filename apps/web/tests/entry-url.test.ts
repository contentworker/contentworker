import type { SavedView } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  listQueryToViewQuery,
  listStateFromParams,
  listStateToParams,
  matchesView,
  viewToListState,
} from '~/cms/lib/entry-url';

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'v1',
  name: 'Drafts',
  contentTypeApiId: 'article',
  visibility: 'personal',
  createdBy: 'ada',
  query: {},
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('the entries list URL', () => {
  it('reads the Preview API’s own query string, and writes it back the same', () => {
    const url =
      'view=v1&fields.title[match]=cat&sys.status=draft&fields.tags[in]=a,b&fields.rank[exists]=false' +
      '&order=-sys.updatedAt,fields.title&query=launch&columns=sys.status,rank&space=s1&next=me';
    const state = listStateFromParams(new URLSearchParams(url));
    expect(state).toEqual({
      viewId: 'v1',
      columns: ['sys.status', 'rank'],
      query: {
        filters: [
          { field: 'title', op: 'match', value: 'cat' },
          { field: 'sys.status', op: 'eq', value: 'draft' },
          { field: 'tags', op: 'in', value: ['a', 'b'] },
          { field: 'rank', op: 'exists', value: false },
        ],
        order: [
          { field: 'sys.updatedAt', direction: 'desc' },
          { field: 'title', direction: 'asc' },
        ],
        search: 'launch',
        // Kept, never sent; the connection's `space` is the client's, not the list's.
        extra: { next: 'me' },
      },
    });
    expect(listStateFromParams(listStateToParams(state))).toEqual(state);
  });

  it('carries a where tree through as JSON, and drops one that isn’t', () => {
    const where = { or: [{ field: 'title', op: 'startsWith', value: 'A' }] };
    const params = listStateToParams({ query: { where } });
    expect(listStateFromParams(params).query.where).toEqual(where);
    expect(listStateFromParams(new URLSearchParams('where={nope')).query).toEqual({});
  });

  it('opens a view as its URL, and saves the URL back as the view’s structured query', () => {
    const saved = view({
      query: {
        filters: [{ field: 'rank', op: 'gt', value: 3 }],
        order: [{ field: 'title', direction: 'asc' }],
        extra: { 'sys.createdBy': 'me' },
      },
      columns: ['rank'],
    });
    const state = viewToListState(saved);
    expect(listStateToParams(state).toString()).toBe(
      'view=v1&fields.rank%5Bgt%5D=3&order=fields.title&sys.createdBy=me&columns=rank',
    );
    expect(matchesView(state, saved)).toBe(true);
    // A link to it reads back as the same view, unchanged.
    expect(matchesView(listStateFromParams(listStateToParams(state)), saved)).toBe(true);
    expect(matchesView({ ...state, columns: undefined }, saved)).toBe(false);
    expect(listQueryToViewQuery(state.query)).toEqual({
      filters: [{ field: 'rank', op: 'gt', value: '3' }],
      order: [{ field: 'title', direction: 'asc' }],
      extra: { 'sys.createdBy': 'me' },
    });
  });

  it('leaves a half-typed filter out of a saved view', () => {
    expect(
      listQueryToViewQuery({
        filters: [
          { field: 'title', op: 'eq', value: '' },
          { field: 'rank', op: 'exists', value: true },
        ],
        trashed: true,
      }),
    ).toEqual({ filters: [{ field: 'rank', op: 'exists', value: true }] });
  });
});
