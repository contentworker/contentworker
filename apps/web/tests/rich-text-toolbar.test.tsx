// @vitest-environment jsdom
// The rich-text toolbar: named by tooltips that give the editor's real keys (to a mouse only), one
// Tab stop moved through by the arrows, the Insert menu that names every link and embed, marks
// that stay quiet until the reader has a selection, the "?" list's Editor group, embeds named by
// their target's title (never its id), and every stored heading level drawn at its own level.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RichTextDocument } from '@contentworker/domain';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pickers, PickOption } from '~/cms/components/EntryForm';
import { RichTextEditor } from '~/cms/components/RichTextEditor';
import { usePageShortcutGroups } from '~/cms/lib/shortcuts';
import { chooseInsert, openInsertMenu } from './rich-text-insert';

const EMPTY: Pickers = { entries: [], assets: [] };
const ENTRY_ID = '0198c2a4-5b1e-7c3d-9f00-a1b2c3d4e5f6';
const OTHER_ID = '0198c2a4-5b1e-7c3d-9f00-ffffffffffff';

function mount(value?: unknown, pickers: Pickers = EMPTY) {
  const onChange = vi.fn<(doc: RichTextDocument | undefined) => void>();
  const view = render(<RichTextEditor value={value} pickers={pickers} onChange={onChange} />);
  return { onChange, view, last: () => onChange.mock.lastCall?.[0] };
}

const doc = (...content: unknown[]) => ({ nodeType: 'document', content });
const text = (value: string) => ({ nodeType: 'text', value, marks: [] });
const para = (value: string) => ({ nodeType: 'paragraph', content: [text(value)] });

const toolbar = () => screen.getByRole('toolbar', { name: 'Text formatting' });
const button = (name: string) => within(toolbar()).getByRole('button', { name });

/** A mouse (or a finger) as `matchMedia('(pointer: fine)')` reports it. */
function pointer(fine: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: fine && query === '(pointer: fine)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

const focus = async (el: HTMLElement) => {
  await act(async () => {
    el.focus();
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rich-text toolbar tooltips', () => {
  it('names a control with its key, as the editor binds it, on a mouse', async () => {
    pointer(true);
    mount();
    await focus(button('Bold'));
    // jsdom is not an Apple device: the chord is Ctrl's.
    expect((await screen.findByRole('tooltip')).textContent).toBe('BoldCtrl+B');
    expect(button('Bold').getAttribute('aria-keyshortcuts')).toBe('Meta+B Control+B');
    expect(button('Strikethrough').getAttribute('aria-keyshortcuts')).toBe(
      'Meta+Shift+S Control+Shift+S',
    );
    expect(button('Heading 2').getAttribute('aria-keyshortcuts')).toBe('Meta+Alt+2 Control+Alt+2');
  });

  it("prints Apple's glyphs in Apple's modifier order on a Mac", async () => {
    pointer(true);
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    mount();
    await focus(button('Strikethrough'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Strikethrough⇧⌘S');
  });

  it('gives Link its name alone: ⌘K is the command palette, not the editor', async () => {
    pointer(true);
    mount();
    await focus(button('Link'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Link');
    expect(button('Link').hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('shows no key to a finger', async () => {
    pointer(false);
    mount();
    await focus(button('Italic'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Italic');
  });
});

describe('rich-text toolbar keyboard', () => {
  const stops = () =>
    within(toolbar())
      .getAllByRole('button')
      .filter((b) => b.tabIndex === 0)
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);

  it('is one Tab stop, and the arrows, Home and End move along it', async () => {
    mount();
    expect(stops()).toEqual(['Bold']);

    await focus(button('Bold'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(button('Italic'));
    expect(stops()).toEqual(['Italic']);

    // Undo and Redo are disabled with nothing to undo: End stops on Insert, before them.
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('Insert');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(button('Bold'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement?.textContent).toBe('Insert');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(button('Bold'));
  });

  it('remembers the control last focused when focus leaves', async () => {
    mount();
    await focus(button('Heading 2'));
    await act(async () => {
      (document.activeElement as HTMLElement).blur();
    });
    expect(stops()).toEqual(['Heading 2']);
  });

  it('keeps aria-pressed on the marks', async () => {
    mount(doc(para('Hello')));
    expect(button('Bold').getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      fireEvent.click(button('Bold'));
    });
    expect(button('Bold').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('rich-text toolbar active states', () => {
  it('shows no heading pressed before the editor has a selection of the reader’s', async () => {
    mount(doc({ nodeType: 'heading-1', content: [text('Title')] }, para('Body')));
    expect(button('Heading 1').getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      fireEvent.focus(screen.getByRole('textbox'));
    });
    await waitFor(() => expect(button('Heading 1').getAttribute('aria-pressed')).toBe('true'));
  });
});

describe('rich-text Insert menu', () => {
  it('names every link, embed and block it adds', async () => {
    mount();
    const menu = await openInsertMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual([
      'Link to entry',
      'Link to asset',
      'Embed entry',
      'Inline entry',
      'Embed asset',
      'Embed media',
      'Table',
      'Horizontal rule',
    ]);
    // The lookalike icons are off the toolbar: each is a word in the menu now.
    for (const gone of ['Link to entry', 'Embed entry', 'Inline entry', 'Link to asset']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
  });

  it('opens the picker row for a link to an entry, with its field focused', async () => {
    mount(doc(para('Hello')));
    await chooseInsert('Link to entry');
    expect(screen.getByText('Link selection to entry')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Pick a target' }));
  });

  it('embeds an entry block where the cursor is', async () => {
    mount(doc(para('Hello')));
    await chooseInsert('Embed entry');
    // Unpicked, so not yet in the stored document: the card asks for its entry.
    expect(await screen.findByTestId('embed-entry')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('rich-text Editor shortcuts', () => {
  function Groups() {
    const groups = usePageShortcutGroups();
    return <output data-testid="groups">{groups.map((g) => g.title).join(',')}</output>;
  }

  it('lists the Editor group once while any rich-text field is mounted', () => {
    const groups = () => screen.getByTestId('groups').textContent;
    const fields = (n: number) => (
      <>
        <Groups />
        {Array.from({ length: n }, (_, i) => (
          <RichTextEditor key={i} value={undefined} pickers={EMPTY} onChange={() => {}} />
        ))}
      </>
    );
    const view = render(fields(2));
    expect(groups()).toBe('Editor');
    // One of two fields goes (a section collapses): the other still has its keys listed.
    view.rerender(fields(1));
    expect(groups()).toBe('Editor');
    view.rerender(fields(0));
    expect(groups()).toBe('');
  });

  it('lists ⌘S, the marks the tooltips give and the toolbar’s arrows', () => {
    function Items() {
      const g = usePageShortcutGroups().find((x) => x.title === 'Editor');
      return <output data-testid="items">{g?.items.map((i) => i.label).join('|')}</output>;
    }
    render(
      <>
        <Items />
        <RichTextEditor value={undefined} pickers={EMPTY} onChange={() => {}} />
      </>,
    );
    const items = screen.getByTestId('items').textContent?.split('|');
    expect(items).toEqual(
      expect.arrayContaining([
        'Save draft',
        'Bold',
        'Italic',
        'Underline',
        'Strikethrough',
        'Code',
        'Undo',
        'Redo',
        'Next control in the toolbar',
        'First control in the toolbar',
      ]),
    );
  });
});

describe('rich-text embeds name their target', () => {
  const entryOption = (id: string, title: string): PickOption => ({
    id,
    title,
    contentType: 'article',
    label: `${title} (article)`,
  });
  const block = (id: string) => ({
    nodeType: 'embedded-entry-block',
    data: { target: { id, linkType: 'Entry' } },
    content: [],
  });
  const inline = (id: string) => ({
    nodeType: 'paragraph',
    content: [
      text('See '),
      {
        nodeType: 'embedded-entry-inline',
        data: { target: { id, linkType: 'Entry' } },
        content: [],
      },
    ],
  });

  it('looks up an entry past the picker’s first page, once for every embed in the document', async () => {
    const resolve = vi.fn(async (_type: 'Entry' | 'Asset', ids: readonly string[]) =>
      ids.filter((id) => id === ENTRY_ID).map((id) => entryOption(id, 'Spring launch')),
    );
    const { view } = mount(doc(block(ENTRY_ID), inline(ENTRY_ID)), { ...EMPTY, resolve });

    await waitFor(() =>
      expect(screen.getByTestId('embed-inline-entry').textContent).toBe('Spring launch'),
    );
    expect(
      (screen.getByRole('combobox', { name: 'Pick an entry' }) as HTMLInputElement).value,
    ).toBe('Spring launch (article)');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('Entry', [ENTRY_ID]);
    expect(view.container.innerHTML).not.toContain(`>${ENTRY_ID}<`);

    // Remounted with the same pickers, the answer is already known.
    view.unmount();
    mount(doc(inline(ENTRY_ID)), { ...EMPTY, resolve });
    await waitFor(() =>
      expect(screen.getByTestId('embed-inline-entry').textContent).toBe('Spring launch'),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('draws a skeleton while the lookup runs, not the id', async () => {
    let answer: (o: PickOption[]) => void = () => {};
    const resolve = vi.fn(
      () =>
        new Promise<PickOption[]>((r) => {
          answer = r;
        }),
    );
    mount(doc(block(OTHER_ID)), { ...EMPTY, resolve });
    const card = await screen.findByTestId('embed-entry');
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(card.querySelector('[data-slot="skeleton-text"]')).not.toBeNull();
    expect(card.textContent).toContain('Loading entry');
    expect(card.textContent).not.toContain(OTHER_ID);
    expect(screen.queryByRole('combobox', { name: 'Pick an entry' })).toBeNull();

    await act(async () => {
      answer([entryOption(OTHER_ID, 'Autumn sale')]);
    });
    expect(
      ((await screen.findByRole('combobox', { name: 'Pick an entry' })) as HTMLInputElement).value,
    ).toBe('Autumn sale (article)');
  });

  it('says an entry is not found when the lookup has no such entry', async () => {
    const gone = '0198c2a4-5b1e-7c3d-9f00-000000000000';
    const resolve = vi.fn(async () => [] as PickOption[]);
    mount(doc(block(gone), inline(gone)), { ...EMPTY, resolve });
    await waitFor(() =>
      expect(screen.getByTestId('embed-inline-entry').textContent).toBe('Entry not found'),
    );
    const card = screen.getByTestId('embed-entry');
    expect(card.textContent).toContain('Entry not found');
    // The picker offers a replacement rather than showing the dead id.
    expect((within(card).getByRole('combobox') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(gone);
  });

  it("says a lookup that failed couldn't load the entry, and asks again next time", async () => {
    const failing = '0198c2a4-5b1e-7c3d-9f00-111111111111';
    const resolve = vi
      .fn<(t: 'Entry' | 'Asset', ids: readonly string[]) => Promise<PickOption[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([entryOption(failing, 'Back online')]);
    const { view } = mount(doc(inline(failing)), { ...EMPTY, resolve });
    await waitFor(() =>
      expect(screen.getByTestId('embed-inline-entry').textContent).toBe("Entry couldn't be loaded"),
    );
    view.unmount();
    mount(doc(inline(failing)), { ...EMPTY, resolve });
    await waitFor(() =>
      expect(screen.getByTestId('embed-inline-entry').textContent).toBe('Back online'),
    );
  });

  it('names an entry in the picker’s list without asking', async () => {
    const resolve = vi.fn(async () => [] as PickOption[]);
    mount(doc(inline(ENTRY_ID)), {
      entries: [entryOption(ENTRY_ID, 'Listed')],
      assets: [],
      resolve,
    });
    expect((await screen.findByTestId('embed-inline-entry')).textContent).toBe('Listed');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('rich-text headings', () => {
  it('draws every stored heading level at its own level, and keeps it', () => {
    const heading = (n: number) => ({ nodeType: `heading-${n}`, content: [text(`Level ${n}`)] });
    const value = doc(...[1, 2, 3, 4, 5, 6].map(heading));
    const { view } = mount(value);
    const editor = view.container.querySelector('.rich-text-editor');
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(editor?.querySelector(`h${n}`)?.textContent).toBe(`Level ${n}`);
    }
  });

  it('styles h4–h6 below h3 in the editor and in prose, never left to the browser', () => {
    const css = readFileSync(join(process.cwd(), 'app/app.css'), 'utf8');
    const rule = (tag: string) =>
      new RegExp(`\\.rich-text-editor ${tag} \\{\\s*@apply ([^;]+);`).exec(css)?.[1] ?? '';
    const size = (tag: string) => /text-(2xl|xl|lg|base|sm)/.exec(rule(tag))?.[1];
    const scale = ['2xl', 'xl', 'lg', 'base', 'sm'];
    const rank = (tag: string) => scale.indexOf(size(tag) ?? '');
    for (const tag of ['h4', 'h5', 'h6']) {
      expect(rule(tag), tag).toContain('font-semibold');
      expect(rank(tag), tag).toBeGreaterThan(rank('h3'));
    }
    expect(rank('h5')).toBeGreaterThanOrEqual(rank('h4'));
    expect(rule('h6')).toContain('text-muted-foreground');
    // Never uppercase: that is a caption's alone.
    for (const tag of ['h4', 'h5', 'h6']) expect(rule(tag)).not.toContain('uppercase');
    expect(css).toContain('.cw-prose :where(h1, h2, h3, h4, h5, h6)');
  });
});
