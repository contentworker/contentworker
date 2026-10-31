// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EntriesTable,
  type EntryRowActions,
  shouldIgnoreShortcut,
} from '~/cms/components/entries/EntriesTable';
import type { PreviewEntry } from '~/cms/lib/management';

// jsdom has no layout, so it has no scrollIntoView; every real browser does.
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

const field = (over: Partial<FieldDefinition>): FieldDefinition => ({
  apiId: 'x',
  name: 'X',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

const ARTICLE: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [field({ apiId: 'title', name: 'Headline', localized: true })],
};

const entry = (id: string, status: string, title?: string): PreviewEntry => ({
  id,
  contentType: 'article',
  status,
  version: 1,
  fields: title === undefined ? {} : { title: { 'en-US': title } },
});

const ENTRIES = [
  entry('e-draft', 'draft', 'Spring launch'),
  entry('e-changed', 'changed', 'Pricing page'),
  entry('e-live', 'published', 'About us'),
  entry('e-none', 'published'),
];

function actions(): EntryRowActions {
  return {
    publish: vi.fn(),
    diff: vi.fn(),
    duplicate: vi.fn(),
    unpublish: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
    purge: vi.fn(),
  };
}

function renderTable(over: Partial<Parameters<typeof EntriesTable>[0]> = {}) {
  const props = {
    type: ARTICLE,
    entries: ENTRIES,
    locale: 'en-US',
    picked: new Set<string>(),
    busy: false,
    viewingTrash: false,
    hrefFor: (e: PreviewEntry) => `/content/article/${e.id}`,
    onTogglePick: vi.fn(),
    onPickAll: vi.fn(),
    actions: actions(),
    ...over,
  };
  render(
    <MemoryRouter>
      <EntriesTable {...props} />
    </MemoryRouter>,
  );
  return props;
}

// Radix menus open on pointerdown (left button, no modifiers).
const openMenu = (name: string) =>
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });

describe('EntriesTable rows', () => {
  it('heads the title column with the field name, not its apiId', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Headline' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'title' })).toBeNull();
  });

  it('links each title to the entry editor', () => {
    renderTable();
    const link = screen.getByRole('link', { name: 'Spring launch' });
    expect(link.getAttribute('href')).toBe('/content/article/e-draft');
    expect(screen.getByRole('link', { name: 'Untitled entry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('labels checkboxes by title, never by id', () => {
    renderTable();
    expect(screen.getByRole('checkbox', { name: 'Select “Spring launch”' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select untitled entry' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /e-draft/ })).toBeNull();
  });

  it('offers Publish only for draft and changed entries, in its own cell', () => {
    const props = renderTable();
    const rows = screen.getAllByRole('row').slice(1);
    // Every row has the same number of cells, so columns never shift.
    for (const row of rows) expect(within(row).getAllByRole('cell')).toHaveLength(5);
    expect(screen.getAllByRole('button', { name: /^Publish / })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Publish “Pricing page”' }));
    expect(props.actions.publish).toHaveBeenCalledWith(ENTRIES[1]);
  });

  it('puts the rest in a per-row menu with Move to trash last', () => {
    const props = renderTable();
    openMenu('More actions for About us');
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Diff vs published', 'Duplicate', 'Unpublish', 'Move to trash']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to trash' }));
    expect(props.actions.trash).toHaveBeenCalledWith(ENTRIES[2]);
  });

  it('leaves Diff and Unpublish out of a draft’s menu', () => {
    renderTable();
    openMenu('More actions for Spring launch');
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Duplicate', 'Move to trash']);
  });

  it('restores from the trash and keeps permanent delete in the menu', () => {
    const props = renderTable({ viewingTrash: true });
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]!);
    expect(props.actions.restore).toHaveBeenCalledWith(ENTRIES[0]);
    openMenu('More actions for Spring launch');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently…' }));
    expect(props.actions.purge).toHaveBeenCalledWith(ENTRIES[0]);
  });
});

describe('EntriesTable keyboard', () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

  it('moves with J/K and the arrows, and X selects the focused row', () => {
    const props = renderTable();
    press('j');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Spring launch' }));
    press('j');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Pricing page' }));
    press('ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'About us' }));
    press('k');
    press('ArrowUp');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Spring launch' }));
    press('x');
    expect(props.onTogglePick).toHaveBeenCalledWith('e-draft');
  });

  it('ignores keys with a modifier held', () => {
    renderTable();
    press('j', { metaKey: true });
    press('j', { ctrlKey: true });
    expect(document.activeElement).toBe(document.body);
  });

  it('ignores keys while typing or while a dialog is open', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const typing = new KeyboardEvent('keydown', { key: 'j' });
    Object.defineProperty(typing, 'target', { value: input });
    expect(shouldIgnoreShortcut(typing)).toBe(true);
    input.remove();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    expect(shouldIgnoreShortcut(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true);
    dialog.remove();
    expect(shouldIgnoreShortcut(new KeyboardEvent('keydown', { key: 'j' }))).toBe(false);
  });
});
