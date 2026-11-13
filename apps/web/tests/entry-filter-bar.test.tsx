// @vitest-environment jsdom
// The entries list's filter bar: a condition being built never reaches the list, the status chips
// are the Status condition in one click, Escape closes the panel, and the count is conditions only.
import type { ContentType } from '@contentworker/domain';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chosenStatuses,
  EntryFilterBar,
  filterComplete,
  withStatuses,
} from '~/cms/components/EntryFilterBar';
import type { EntryListQuery } from '~/cms/lib/management';

afterEach(() => cleanup());

const article = {
  apiId: 'article',
  name: 'Article',
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
  ],
} as unknown as ContentType;

/** The bar over a query it owns, as the list holds it; every change it makes is recorded. */
function setup(initial: EntryListQuery = {}) {
  const changes: EntryListQuery[] = [];
  const onChange = vi.fn((q: EntryListQuery) => changes.push(q));
  function Harness() {
    const [query, setQuery] = useState<EntryListQuery>(initial);
    return (
      <EntryFilterBar
        type={article}
        value={query}
        onChange={(q) => {
          onChange(q);
          setQuery(q);
        }}
      />
    );
  }
  render(<Harness />);
  return { onChange, changes };
}

const filtersButton = () => screen.getByRole('button', { name: /^Filters/ });
const chip = (name: string) =>
  within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name });

describe('a condition being built', () => {
  it('stays in the panel until it has a value, so the list never empties for it', () => {
    const { onChange } = setup();
    act(() => filtersButton().click());
    act(() => screen.getByRole('button', { name: 'Add filter' }).click());
    // The row is there to finish, and nothing reached the list.
    expect(screen.getByRole('combobox', { name: 'Filter field' })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(filtersButton().textContent).toBe('Filters');
  });

  it('reaches the list once it says what it matches, and leaves it when removed', () => {
    const { onChange, changes } = setup();
    act(() => filtersButton().click());
    act(() => screen.getByRole('button', { name: 'Add filter' }).click());
    // Title contains "spring".
    act(() => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Filter field' }));
    });
    act(() => screen.getByRole('option', { name: 'Title' }).click());
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter value' }), {
      target: { value: 'spring' },
    });
    expect(changes.at(-1)?.filters).toEqual([{ field: 'title', op: 'eq', value: 'spring' }]);
    act(() => screen.getByRole('button', { name: 'Remove filter' }).click());
    expect(changes.at(-1)?.filters).toBeUndefined();
  });

  it('is kept while the chips change the list’s conditions', () => {
    setup();
    act(() => filtersButton().click());
    act(() => screen.getByRole('button', { name: 'Add filter' }).click());
    act(() => chip('Draft').click());
    // The Draft condition, and the row still being built after it.
    expect(screen.getAllByRole('combobox', { name: 'Filter field' })).toHaveLength(2);
  });
});

describe('the status chips', () => {
  it('are the Status condition: one is "is", several are "is any of", none is no condition', () => {
    const { changes } = setup();
    act(() => chip('Draft').click());
    expect(chip('Draft').getAttribute('aria-pressed')).toBe('true');
    expect(changes.at(-1)?.filters).toEqual([{ field: 'sys.status', op: 'eq', value: 'draft' }]);
    act(() => chip('Changed').click());
    expect(changes.at(-1)?.filters).toEqual([
      { field: 'sys.status', op: 'in', value: ['draft', 'changed'] },
    ]);
    act(() => chip('Draft').click());
    act(() => chip('Changed').click());
    expect(changes.at(-1)?.filters).toBeUndefined();
    expect(chip('Changed').getAttribute('aria-pressed')).toBe('false');
  });

  it('show a Status condition that came from a link or a view, and keep the other conditions', () => {
    const { changes } = setup({
      filters: [
        { field: 'title', op: 'match', value: 'spring' },
        { field: 'sys.status', op: 'in', value: ['changed', 'published'] },
      ],
    });
    expect(chip('Changed').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Published').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Draft').getAttribute('aria-pressed')).toBe('false');
    act(() => chip('Published').click());
    expect(changes.at(-1)?.filters).toEqual([
      { field: 'sys.status', op: 'eq', value: 'changed' },
      { field: 'title', op: 'match', value: 'spring' },
    ]);
  });
});

describe('the panel', () => {
  it('closes on Escape and hands focus back to Filters', () => {
    setup();
    act(() => filtersButton().click());
    const add = screen.getByRole('button', { name: 'Add filter' });
    add.focus();
    act(() => {
      fireEvent.keyDown(add, { key: 'Escape' });
    });
    expect(screen.queryByRole('button', { name: 'Add filter' })).toBeNull();
    expect(document.activeElement).toBe(filtersButton());
    expect(filtersButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('counts conditions only: the search shows itself in its box', () => {
    setup({
      search: 'spring',
      filters: [{ field: 'sys.status', op: 'eq', value: 'draft' }],
    });
    expect(filtersButton().textContent).toBe('Filters1');
    // A search alone still offers Clear.
    cleanup();
    setup({ search: 'spring' });
    expect(filtersButton().textContent).toBe('Filters');
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });
});

describe('filterComplete, chosenStatuses, withStatuses', () => {
  it('judges a condition by its value', () => {
    expect(filterComplete({ field: 'title', op: 'eq', value: '' })).toBe(false);
    expect(filterComplete({ field: 'title', op: 'eq', value: '  ' })).toBe(false);
    expect(filterComplete({ field: 'tags', op: 'in', value: ['', ' '] })).toBe(false);
    expect(filterComplete({ field: 'tags', op: 'in', value: ['a'] })).toBe(true);
    expect(filterComplete({ field: 'done', op: 'eq', value: false })).toBe(true);
    expect(filterComplete({ field: 'title', op: 'exists', value: true })).toBe(true);
    expect(filterComplete({ field: 'title', op: 'exists', value: '' })).toBe(false);
  });

  it('reads and writes only an "is" or "is any of" status, never "is not"', () => {
    const not = { field: 'sys.status', op: 'ne' as const, value: 'archived' };
    expect(chosenStatuses([not])).toEqual([]);
    expect(withStatuses([not], ['draft'])).toEqual([
      { field: 'sys.status', op: 'eq', value: 'draft' },
      not,
    ]);
  });
});
