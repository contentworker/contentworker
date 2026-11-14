// @vitest-environment jsdom
// A blocks field reads as sections of the form, not cards inside its card: each block a header
// (its name, place, move and a quiet Remove) over its fields, and each folds to one line so a
// long landing page scans as a list of its blocks.
import type { ComponentVariant, ContentType, FieldDefinition } from '@contentworker/domain';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockSummary, EntryForm } from '~/cms/components/EntryForm';

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

const HERO: ComponentVariant = {
  apiId: 'hero',
  name: 'Hero',
  fields: [
    field({ apiId: 'image', name: 'Image', type: 'Integer' }),
    field({ apiId: 'heading', name: 'Heading', required: true, position: 1 }),
  ],
};
const COPY: ComponentVariant = {
  apiId: 'copy',
  name: 'Copy',
  fields: [field({ apiId: 'text', name: 'Text', type: 'Text' })],
};

const PAGE: ContentType = {
  apiId: 'page',
  name: 'Page',
  displayField: 'name',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'name', name: 'Name' }),
    field({
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      position: 1,
      items: { type: 'Component', variants: [HERO, COPY] },
    }),
  ],
};

const BLOCKS = [
  { _type: 'hero', _key: 'k1', heading: 'Welcome aboard' },
  { _type: 'copy', _key: 'k2', text: 'First line\nSecond line' },
];

function renderForm(blocks: unknown[] = BLOCKS) {
  const onSave = vi.fn();
  render(
    <EntryForm
      contentType={PAGE}
      initial={{ name: { 'en-US': 'Home' }, body: { 'en-US': blocks } }}
      locales={['en-US']}
      defaultLocale="en-US"
      pickers={{ entries: [], assets: [] }}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return onSave;
}

const block = (name: string) => screen.getByRole('group', { name });
const toggle = (name: string) =>
  within(block(name))
    .getAllByRole('button')
    .find((b) => b.hasAttribute('aria-expanded')) as HTMLButtonElement | undefined;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

describe('a block in the form', () => {
  it('is a section, not a tinted card inside the card: its fields sit one surface deep', () => {
    renderForm();
    const hero = block('Hero block 1');
    expect(hero.className).not.toMatch(/bg-secondary/);
    // Its fields have no fill of their own either: no box in a box.
    const body = hero.querySelector('[id$="-body"]') as HTMLElement;
    expect(body.querySelector('[class*="bg-secondary"]')).toBeNull();
    expect(within(body).getByLabelText(/^Heading/)).toBeTruthy();
  });

  it('folds and opens from its header, a real button that says which', () => {
    renderForm();
    const button = toggle('Hero block 1') as HTMLButtonElement;
    // A native button: Enter and Space work, and it is in the tab order.
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(body?.hidden).toBe(false);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(body?.hidden).toBe(true);
    fireEvent.click(button);
    expect(body?.hidden).toBe(false);
  });

  it('reads as its first line of text when folded', () => {
    renderForm();
    const hero = toggle('Hero block 1') as HTMLButtonElement;
    expect(hero.textContent).not.toContain('Welcome aboard');
    fireEvent.click(hero);
    expect(hero.textContent).toContain('Welcome aboard');
    const copy = toggle('Copy block 2') as HTMLButtonElement;
    fireEvent.click(copy);
    expect(copy.textContent).toContain('First line');
    expect(copy.textContent).not.toContain('Second line');
  });

  it('keeps a folded block’s edits and saves them', () => {
    const onSave = renderForm();
    fireEvent.change(screen.getByLabelText(/^Heading/), { target: { value: 'Hello' } });
    fireEvent.click(toggle('Hero block 1') as HTMLButtonElement);
    save();
    expect(onSave.mock.calls[0]?.[0].body['en-US'][0]).toMatchObject({ heading: 'Hello' });
  });

  it('opens itself when a save is refused for a field inside it', () => {
    const onSave = renderForm([{ _type: 'hero', _key: 'k1' }]);
    const button = toggle('Hero block 1') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText(/^Heading/).getAttribute('aria-invalid')).toBe('true');
  });

  it('opens when a pick lands on it', () => {
    renderForm();
    const button = toggle('Hero block 1') as HTMLButtonElement;
    fireEvent.click(button);
    act(() => block('Hero block 1').focus());
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps Remove quiet until it is meant, and still names the block it removes', () => {
    const onSave = renderForm();
    const remove = screen.getByRole('button', { name: 'Remove Copy block 2' });
    expect(remove.className).toContain('text-muted-foreground');
    expect(remove.className).toContain('hover:text-destructive');
    expect(remove.className).toContain('focus-visible:text-destructive');
    expect(remove.className).not.toMatch(/(^| )text-destructive( |$)/);
    fireEvent.click(remove);
    save();
    expect(onSave.mock.calls[0]?.[0].body['en-US']).toEqual([BLOCKS[0]]);
  });
});

describe('a block’s one line', () => {
  it('is its first text value in its fields’ order, else nothing', () => {
    expect(blockSummary(HERO, { heading: '  Hi there  ' })).toBe('Hi there');
    expect(blockSummary(COPY, { text: '\nAfter a blank\nMore' })).toBe('After a blank');
    expect(blockSummary(HERO, { image: 3 })).toBeUndefined();
  });
});
