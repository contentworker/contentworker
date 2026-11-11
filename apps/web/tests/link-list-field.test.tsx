// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryForm, type Pickers, type PickOption } from '~/cms/components/EntryForm';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
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

const typeWith = (related: Partial<FieldDefinition>): ContentType => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'name',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'name', name: 'Name' }),
    field({ apiId: 'related', name: 'Related', type: 'Array', position: 1, ...related }),
  ],
});

const ENTRY_LINKS = typeWith({ items: { type: 'Link', linkType: 'Entry' } });

const entry = (id: string, title: string, contentType: string): PickOption => ({
  id,
  title,
  contentType,
  label: `${title} (${contentType})`,
});

const PICKERS: Pickers = {
  entries: [
    entry('e1', 'Pricing', 'page'),
    entry('e2', 'Launch notes', 'post'),
    entry('e3', 'About us', 'page'),
  ],
  assets: [{ id: 'a1', label: 'Logo', mimeType: 'image/png' }],
};

const link = (id: string, linkType = 'Entry') => ({ id, linkType });

function renderForm(
  contentType: ContentType,
  initial = {},
  extra: Partial<Parameters<typeof EntryForm>[0]> = {},
) {
  const onSave = vi.fn();
  render(
    <EntryForm
      contentType={contentType}
      initial={initial}
      locales={['en-US']}
      defaultLocale="en-US"
      pickers={PICKERS}
      onSave={onSave}
      onCancel={() => {}}
      {...extra}
    />,
  );
  return onSave;
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
const saved = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls[0]?.[0].related?.['en-US'];
const rows = () => within(screen.getByRole('list', { name: 'Related' })).getAllByRole('listitem');

describe('a list of links', () => {
  it('shows each link as its entry, by title and type, never as JSON', () => {
    renderForm(ENTRY_LINKS, { related: { 'en-US': [link('e1'), link('e2')] } });
    const [first, second] = rows();
    expect(within(first as HTMLElement).getByText('Pricing')).toBeTruthy();
    expect(within(first as HTMLElement).getByText('page')).toBeTruthy();
    expect(within(second as HTMLElement).getByText('Launch notes')).toBeTruthy();
    expect(within(second as HTMLElement).getByText('post')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/JSON/)).toBeNull();
  });

  it('shows the id of a link the pickers don’t hold, rather than a blank', () => {
    renderForm(ENTRY_LINKS, { related: { 'en-US': [link('gone-1')] } });
    expect(within(rows()[0] as HTMLElement).getByText('gone-1')).toBeTruthy();
  });

  it('looks up links past the pickers’ page once, by id, and names them', async () => {
    const resolve = vi.fn(async (_type: 'Entry' | 'Asset', ids: readonly string[]) =>
      ids.filter((i) => i === 'far').map((i) => entry(i, 'Far away', 'article')),
    );
    renderForm(
      ENTRY_LINKS,
      { related: { 'en-US': [link('e1'), link('far'), link('gone')] } },
      { pickers: { ...PICKERS, resolve } },
    );
    const [, far, gone] = rows();
    expect(await within(far as HTMLElement).findByText('Far away')).toBeTruthy();
    expect(within(far as HTMLElement).getByText('article')).toBeTruthy();
    // One request, for only the ids the pickers lack; one it can't find keeps its id.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('Entry', ['far', 'gone']);
    expect(within(gone as HTMLElement).getByText('gone')).toBeTruthy();
  });

  it('gives Add the field’s id, so the field’s label leads to it', () => {
    renderForm(ENTRY_LINKS);
    const add = screen.getByRole('combobox', { name: 'Add an entry to Related' });
    expect(document.querySelector('label[for="' + add.id + '"]')?.textContent).toMatch(/Related/);
  });

  it('adds through the reference picker, offering only the types the field takes', async () => {
    const onSave = renderForm(
      typeWith({
        items: {
          type: 'Link',
          linkType: 'Entry',
          validations: { linkContentTypes: ['page'] },
        },
      }),
    );
    const add = screen.getByRole('combobox', { name: 'Add an entry to Related' });
    fireEvent.click(add);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByText(/Launch notes/)).toBeNull();
    fireEvent.click(within(listbox).getByText('About us (page)'));
    expect(within(rows()[0] as HTMLElement).getByText('About us')).toBeTruthy();
    save();
    expect(saved(onSave)).toEqual([link('e3')]);
  });

  it('keeps the title of a link found by a server search', async () => {
    const onSearchEntries = vi.fn(async () => [entry('far', 'Far away', 'page')]);
    renderForm(ENTRY_LINKS, {}, { onSearchEntries });
    const add = screen.getByRole('combobox', { name: 'Add an entry to Related' });
    fireEvent.click(add);
    fireEvent.change(add, { target: { value: 'far' } });
    fireEvent.click(await screen.findByText('Far away (page)'));
    // Not in the seeded pickers, and still named.
    expect(within(rows()[0] as HTMLElement).getByText('Far away')).toBeTruthy();
  });

  it('removes the link asked for, and hands focus to the row that took its place', async () => {
    const onSave = renderForm(ENTRY_LINKS, {
      related: { 'en-US': [link('e1'), link('e2'), link('e3')] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove “Launch notes” from Related' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove “About us” from Related' }),
      ),
    );
    expect(screen.getByText('“Launch notes” removed from Related.')).toBeTruthy();
    save();
    expect(saved(onSave)).toEqual([link('e1'), link('e3')]);
  });

  it('hands focus to Add when the last link goes', async () => {
    renderForm(ENTRY_LINKS, { related: { 'en-US': [link('e1')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove “Pricing” from Related' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('combobox', { name: 'Add an entry to Related' }),
      ),
    );
  });

  it('reorders from the keyboard, focus staying on the moved row', async () => {
    const onSave = renderForm(ENTRY_LINKS, {
      related: { 'en-US': [link('e1'), link('e2'), link('e3')] },
    });
    expect(
      (screen.getByRole('button', { name: 'Move “Pricing” up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move “About us” up' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Move “About us” up' }),
      ),
    );
    expect(screen.getByText('“About us” moved to position 2 of 3.')).toBeTruthy();

    // At the top the button just used is disabled: focus moves to the row's other arrow.
    fireEvent.click(screen.getByRole('button', { name: 'Move “About us” up' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Move “About us” down' }),
      ),
    );
    save();
    expect(saved(onSave)).toEqual([link('e3'), link('e1'), link('e2')]);
  });

  it('lists assets by name and file type, adding only the files the field takes', async () => {
    const onSave = renderForm(
      typeWith({
        items: { type: 'Link', linkType: 'Asset' },
        validations: { assetMimeTypes: ['image/*'] },
      }),
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Add an asset to Related' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByText('Logo'));
    const row = rows()[0] as HTMLElement;
    expect(within(row).getByText('Logo')).toBeTruthy();
    expect(within(row).getByText('image/png')).toBeTruthy();
    save();
    expect(saved(onSave)).toEqual([link('a1', 'Asset')]);
  });

  it('marks Add invalid, tied to the message, when a required list is empty', async () => {
    const onSave = renderForm(
      typeWith({ required: true, items: { type: 'Link', linkType: 'Entry' } }),
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Home' } });
    save();
    const add = screen.getByRole('combobox', { name: 'Add an entry to Related' });
    await waitFor(() => expect(add.getAttribute('aria-invalid')).toBe('true'));
    const described = add.getAttribute('aria-describedby') ?? '';
    expect(described).not.toBe('');
    expect(onSave).not.toHaveBeenCalled();
  });
});
