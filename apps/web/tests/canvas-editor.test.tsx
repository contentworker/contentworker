// @vitest-environment jsdom
// The canvas editor's screen: seams drawn from the page's geometry, the dock offering exactly what
// a slot takes, inserts, moves and removes that undo and redo, the inspector's edits reaching the
// page, Layers by keyboard, the save held to its version (and the conflict it can meet), the block
// config (a narrowed dock, a locked slot, a refusal said on its block), and every state the canvas
// says in place instead of editing.
import {
  type BlockCatalog,
  type BlockConfig,
  type ContentType,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_CHANNEL, type FrameGeometry } from '~/cms/lib/live-preview/frame-channel';
import { ApiError, type PreviewEntry, type PrincipalInfo } from '~/cms/lib/management';
import { catalog, pageFields, pageType, ref } from './canvas-fixture';

const client = {
  listContentTypes: vi.fn(async (): Promise<ContentType[]> => [pageType]),
  getSpaceConfig: vi.fn(async () => ({ defaultLocale: 'en-US', locales: ['en-US'] })),
  getEntry: vi.fn<(id: string) => Promise<PreviewEntry>>(),
  getBlockCatalog: vi.fn(async (): Promise<BlockCatalog> => catalog),
  getEffectiveBlockRules: vi.fn(
    async (): Promise<EffectiveBlockRules> => effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG),
  ),
  getSpaceAccess: vi.fn(
    async (): Promise<Partial<PrincipalInfo>> => ({ subject: 'me', scopes: ['content:write'] }),
  ),
  getEntryWorkflowState: vi.fn(async (): Promise<unknown> => null),
  listWorkflows: vi.fn(async (): Promise<unknown[]> => []),
  listEntries: vi.fn(async () => []),
  listAssets: vi.fn(async () => ({ items: [] })),
  suggestEntries: vi.fn(async () => []),
  updateEntry: vi.fn(),
  publishEntry: vi.fn(),
  unpublishEntry: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 'sp', environment: 'main', locale: 'en-US' },
    busy: false,
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    },
  }),
}));

const { clearHandedDraft, draftId, handOffDraft, peekDraft } = await import(
  '~/cms/lib/draft-handoff'
);
const { ToastProvider } = await import('~/cms/lib/toast');
const { EntryCanvas } = await import('~/cms/routes/EntryCanvas');

/** What the screen is as wide as: lg and up by default. */
let media = { wide: true, tablet: true };
beforeEach(() => {
  media = { wide: true, tablet: true };
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1024px') ? media.wide : query.includes('768px') ? media.tablet : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  clearHandedDraft();
});

function entry(over: Partial<PreviewEntry> = {}): PreviewEntry {
  return {
    id: 'e1',
    contentType: 'page',
    status: 'draft',
    version: 3,
    fields: pageFields(),
    ...over,
  };
}

async function setup(over: Partial<PreviewEntry> = {}, opts: { loading?: boolean } = {}) {
  if (opts.loading) client.getEntry.mockReturnValue(new Promise(() => {}));
  else client.getEntry.mockResolvedValue(entry(over));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/content/:typeId/:entryId/canvas', element: <EntryCanvas /> },
      { path: '/content/:typeId/:entryId', element: <p>The form</p> },
    ],
    { initialEntries: ['/content/page/e1/canvas'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

/** The Site frame: says it's up, that the page connected with `capabilities`, and its geometry. */
function frame() {
  const el = screen.getByTitle('Site preview') as HTMLIFrameElement;
  const posted: unknown[] = [];
  vi.spyOn(el.contentWindow as Window, 'postMessage').mockImplementation((m: unknown) => {
    posted.push(m);
  });
  const say = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { channel: FRAME_CHANNEL, ...data },
          origin: window.location.origin,
          source: el.contentWindow,
        }),
      );
    });
  return {
    posted,
    say,
    connect(capabilities = ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout']) {
      say({ type: 'ready', origin: 'https://site.example' });
      say({ type: 'status', status: 'live' });
      say({ type: 'session', entries: ['e1'], capabilities });
    },
    geometry(g: FrameGeometry) {
      say({ type: 'geometry', geometry: g });
    },
  };
}

const rect = (y: number, h = 10) => ({ x: 0, y, w: 100, h });
const GEOMETRY: FrameGeometry = {
  truncated: false,
  blocks: [
    { ref: ref('body[h1]'), rect: rect(0, 40) },
    { ref: ref('body[s1]'), rect: rect(50, 100) },
  ],
  slots: [
    {
      ref: ref('body'),
      rect: rect(0, 300),
      gaps: [
        { index: 1, axis: 'y', after: 'h1', before: 's1', rect: rect(40) },
        { index: 3, axis: 'y', after: 'a1', rect: rect(290) },
      ],
    },
    {
      ref: ref('body[s1].items'),
      rect: rect(60, 80),
      gaps: [{ index: 1, axis: 'y', after: 'c1', rect: rect(130) }],
    },
  ],
};

const seam = (id: string) => document.querySelector(`[data-seam="${id}"]`) as HTMLElement;
const dock = () => screen.getByRole('region', { name: /^Add to/ });
const layer = (key: string) => document.querySelector(`[data-layer="${key}"]`) as HTMLElement;
const openLayers = () => act(() => screen.getByRole('button', { name: 'Layers' }).click());

describe('seams and the dock', () => {
  it('draws a seam per place the page reports, and the dock offers only what that slot takes', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    expect(document.querySelectorAll('[data-seam]')).toHaveLength(3);

    act(() => seam('body#1').click());
    const top = dock();
    expect(within(top).getByText('after Hero', { exact: false })).toBeTruthy();
    // Where it goes in plain words, the field and its room under it; named field first.
    expect(within(top).getByRole('heading', { level: 2 }).textContent).toBe('Add after Hero');
    expect(top.getAttribute('aria-label')).toBe('Add to Main, after Hero');
    expect(within(top).getByText(/^In Main · /)).toBeTruthy();
    const offered = [...top.querySelectorAll('[data-dock-item]')].map((b) =>
      b.getAttribute('data-dock-item'),
    );
    expect(offered).toEqual(['section', 'hero', 'cta']);
    expect(within(top).getByRole('heading', { name: 'Headers' })).toBeTruthy();
    expect(within(top).getByText('A big opening')).toBeTruthy();
    // The first block it offers has focus: Enter puts it there.
    expect(document.activeElement?.getAttribute('data-dock-item')).toBe('section');

    act(() => seam('body[s1].items#1').click());
    expect([...dock().querySelectorAll('[data-dock-item]')].map((b) => b.textContent)).toEqual([
      'Card',
    ]);
  });

  it('marks the chosen seam with an insertion line while the dock is open, and scrolls it into view', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    expect(document.querySelector('[data-insertion-line]')).toBeNull();
    act(() => seam('body#1').click());
    expect(seam('body#1').querySelector('[data-insertion-line]')).toBeTruthy();
    expect(document.querySelectorAll('[data-insertion-line]')).toHaveLength(1);
    // The stage here has no height, so the dock would cover the seam: the page is asked to bring
    // the block after it to the top of its view, and nothing is selected for it.
    expect(f.posted).toContainEqual({
      channel: FRAME_CHANNEL,
      type: 'scroll',
      ref: ref('body[s1]'),
      align: 'start',
      inset: 24,
    });
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(document.querySelector('[data-insertion-line]')).toBeNull();
    act(() => seam('body#1').click());
    act(() => (dock().querySelector('[data-dock-item="cta"]') as HTMLElement).click());
    expect(document.querySelector('[data-insertion-line]')).toBeNull();
  });

  it('moves across the dock’s cards with the arrows, one tab stop for the row', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    act(() => seam('body#1').click());
    const cards = () => [...dock().querySelectorAll<HTMLElement>('[data-dock-item]')];
    expect(cards().map((c) => c.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('data-dock-item')).toBe('hero');
    expect(cards().map((c) => c.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-dock-item')).toBe('cta');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('data-dock-item')).toBe('cta');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement?.getAttribute('data-dock-item')).toBe('section');
    // Each group is named by its caption; blocks without one are under "Blocks".
    expect(within(dock()).getByRole('list', { name: 'Blocks' })).toBeTruthy();
    expect(within(dock()).getByRole('list', { name: 'Headers' })).toBeTruthy();
  });

  it('never lets a seam grow past its cap, whatever box the page reports', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry({
      ...GEOMETRY,
      slots: [
        {
          ref: ref('body'),
          rect: rect(0, 5000),
          gaps: [{ index: 1, axis: 'y', after: 'h1', rect: rect(0, 5000) }],
        },
      ],
    });
    expect(Number.parseFloat(seam('body#1').style.height)).toBe(48);
  });

  it('says a full slot is full and offers nothing there', async () => {
    const fields = pageFields();
    const section = (fields.body!['en-US'] as { items: unknown[] }[])[1] as { items: unknown[] };
    section.items.push({ _type: 'card', _key: 'c2', title: 'Kind' });
    await setup({ fields });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry({
      ...GEOMETRY,
      slots: [
        {
          ref: ref('body[s1].items'),
          rect: rect(60, 80),
          gaps: [{ index: 2, axis: 'y', after: 'c2', rect: rect(130) }],
        },
      ],
    });
    expect(seam('body[s1].items#2').dataset.full).toBe('true');
    act(() => seam('body[s1].items#2').click());
    expect(within(dock()).getByText(/Items is full: it holds 2 of 2/)).toBeTruthy();
    // With nothing to offer, the dock itself takes focus, so its words are heard.
    expect(dock().contains(document.activeElement)).toBe(true);
    expect(dock().querySelectorAll('[data-dock-item]')).toHaveLength(0);
  });

  it('without the page’s layout, says seams aren’t shown and still selects from a click', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect(['select', 'patch.fields', 'patch.blocks', 'scroll']);
    f.geometry(GEOMETRY);
    expect(document.querySelectorAll('[data-seam]')).toHaveLength(0);
    expect(screen.getByText(/doesn’t report its layout, so seams aren’t shown/)).toBeTruthy();
    f.say({ type: 'pick', ref: ref('body[s1].items[c1].title') });
    expect(screen.getByRole('heading', { level: 2, name: 'Card' })).toBeTruthy();
  });

  it('ignores a click naming another entry', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.say({ type: 'pick', ref: ref('body[h1]', { entryId: 'other' }) });
    expect(screen.getByRole('heading', { level: 2, name: 'Checks' })).toBeTruthy();
  });
});

describe('editing on the canvas', () => {
  it('inserts at a seam (unsaved, in the page at once), and undo and redo take it back and again', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    act(() => seam('body#1').click());
    act(() => (dock().querySelector('[data-dock-item="cta"]') as HTMLElement).click());

    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    // Selected, and its first empty field has focus, ready to type.
    expect(document.activeElement).toBe(screen.getByLabelText(/^Label/));
    // The page was sent the insert as a key-addressed op, before anything was saved.
    const sent = f.posted.at(-2) as { type: string; edits: { blocks: { ops: unknown[] }[] } };
    expect(sent.type).toBe('entry');
    expect(sent.edits.blocks[0]?.ops[0]).toMatchObject({ op: 'insert', after: 'h1' });
    openLayers();
    const names = () =>
      [...document.querySelectorAll('[role="tree"] > [data-layer]')].map(
        (el) => el.querySelector('span')?.textContent,
      );
    expect(names()).toEqual(['Hero', 'Call to action', 'Section', 'Call to action']);

    act(() => screen.getByRole('button', { name: 'Undo' }).click());
    expect(names()).toEqual(['Hero', 'Section', 'Call to action']);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    act(() => screen.getByRole('button', { name: 'Redo' }).click());
    expect(names()).toHaveLength(4);
  });

  it('moves with ⌘↓, removes with Delete and puts it back from the toast', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('h1').click());
    fireEvent.keyDown(document.body, { key: 'ArrowDown', metaKey: true });
    const order = () =>
      [...document.querySelectorAll('[role="tree"] > [data-layer]')].map((el) =>
        el.getAttribute('data-layer'),
      );
    expect(order()).toEqual(['s1', 'h1', 'a1']);

    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(order()).toEqual(['s1', 'a1']);
    // The selection steps to its neighbour.
    expect(layer('a1').getAttribute('aria-selected')).toBe('true');
    // The toast's Undo (the header has one too).
    const undos = screen.getAllByRole('button', { name: 'Undo' });
    expect(undos).toHaveLength(2);
    act(() => (undos.at(-1) as HTMLElement).click());
    expect(order()).toEqual(['s1', 'h1', 'a1']);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(order()).toEqual(['h1', 's1', 'a1']);
  });

  it('gives focus back to what opened the dock, and keeps plain keys off buttons', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('h1').click());
    const add = screen.getByRole('button', { name: 'Add a block to the end of Main' });
    act(() => add.focus());
    act(() => add.click());
    expect(dock()).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(document.activeElement).toBe(add);
    // Backspace on a button is the button's: the selected block stays.
    fireEvent.keyDown(add, { key: 'Backspace' });
    expect(layer('h1')).toBeTruthy();
  });

  it('keeps focus in Layers when a block is removed from there', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('h1').focus());
    act(() => layer('h1').click());
    fireEvent.keyDown(layer('h1'), { key: 'Delete' });
    await waitFor(() => expect(document.activeElement).toBe(layer('s1')));
  });

  it('opens the dock at the selected block with /, and closes it with Esc', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('s1').click());
    fireEvent.keyDown(document.body, { key: '/' });
    expect(within(dock()).getByText('after Section', { exact: false })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: /^Add to/ })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(layer('s1').getAttribute('aria-selected')).toBe('false');
  });

  it('edits a block’s content and its look in the inspector, and the page gets the new value', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    openLayers();
    act(() => layer('h1').click());
    const heading = screen.getByLabelText(/^Heading/) as HTMLInputElement;
    fireEvent.change(heading, { target: { value: 'Hello' } });
    const sent = f.posted.at(-1) as { type: string; edits: { blocks: { ops: unknown[] }[] } };
    expect(sent.edits.blocks[0]?.ops[0]).toMatchObject({
      op: 'update',
      key: 'h1',
      set: { heading: 'Hello' },
    });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Look' }));
    // A token prop is a segmented control of its choices, never a free CSS field.
    act(() => screen.getByRole('radio', { name: 'dark' }).click());
    expect(screen.getByRole('radio', { name: 'dark' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Data' })).toBeTruthy();
  });

  it('moves the selection through Layers with the arrows', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('s1').focus());
    act(() => layer('s1').click());
    const tree = layer('s1').closest('[role="tree"]') as HTMLElement;
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(layer('c1').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(layer('s1').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(layer('c1').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(layer('a1').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tree, { key: 'Home' });
    expect(layer('h1').getAttribute('aria-selected')).toBe('true');
    expect(layer('h1').getAttribute('tabindex')).toBe('0');
  });
});

describe('saving', () => {
  const saved = (version: number) => ({
    entry: {
      id: 'e1',
      contentTypeApiId: 'page',
      status: 'draft',
      currentVersion: version,
      publishedVersion: null,
    },
    fields: pageFields(),
  });

  async function edited() {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('a1').click());
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
  }

  it('leaves the fields the role makes read-only out of the save, which keeps them', async () => {
    client.getSpaceAccess.mockResolvedValueOnce({
      subject: 'me',
      scopes: ['content:write'],
      fieldRules: {
        types: { page: { deniedFields: [], readOnlyFields: ['title'] } },
        others: { deniedFields: [], readOnlyFields: [] },
      },
    });
    client.updateEntry.mockResolvedValue(saved(4));
    await edited();
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalled());
    const fields = client.updateEntry.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(['body']);
  });

  it('saves through the entry’s save, held to the version the canvas started from', async () => {
    client.updateEntry.mockResolvedValue(saved(4));
    await edited();
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalled());
    const [id, fields, opts] = client.updateEntry.mock.calls[0] as [string, unknown, unknown];
    expect(id).toBe('e1');
    expect(opts).toEqual({ expectedVersion: 3 });
    expect((fields as { body: { 'en-US': { label?: string }[] } }).body['en-US'][2]?.label).toBe(
      'Go',
    );
  });

  it('meets a newer save with the two-way choice, and saves over it when asked', async () => {
    client.updateEntry.mockRejectedValueOnce(
      new ApiError(409, 'stale', {
        error: { code: 'conflict', details: { currentVersion: 5, expectedVersion: 3 } },
      }),
    );
    client.updateEntry.mockResolvedValueOnce(saved(6));
    await edited();
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/It’s at v5 now, and the canvas started from v3/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Load theirs' })).toBeTruthy();
    act(() => within(dialog).getByRole('button', { name: 'Save mine over it' }).click());
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(2));
    expect(client.updateEntry.mock.calls[1]?.[2]).toEqual({ expectedVersion: 5 });
  });

  it('offers Publish only to someone who may publish', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('publishes from the canvas: unsaved edits save first, then the publish confirm asks', async () => {
    client.getSpaceAccess.mockResolvedValueOnce({
      subject: 'me',
      scopes: ['content:write', 'content:publish'],
    });
    client.updateEntry.mockResolvedValue(saved(4));
    client.publishEntry.mockResolvedValue({
      ...saved(4).entry,
      status: 'published',
      publishedVersion: 4,
    });
    await edited();
    act(() => screen.getByRole('button', { name: 'Publish' }).click());
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(1));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Publish “Home”?')).toBeTruthy();
    act(() => within(dialog).getByRole('button', { name: 'Publish entry' }).click());
    await waitFor(() => expect(client.publishEntry).toHaveBeenCalledWith('e1'));
    expect(await screen.findByRole('button', { name: 'Published' })).toBeTruthy();
    // Still editing: publishing doesn't turn the canvas into the published version's review.
    expect(screen.queryByText(/This is the published version/)).toBeNull();
  });

  // One draft, two views: the form and the canvas hand unsaved edits across.
  it('opens with the form’s unsaved edits, held to the version the form had', async () => {
    handOffDraft(draftId('sp', 'main', 'e1'), 2, { title: { 'en-US': 'From the form' } });
    client.updateEntry.mockResolvedValue({
      entry: { id: 'e1', contentTypeApiId: 'page', status: 'draft', currentVersion: 4 },
      fields: pageFields(),
    });
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'From the form' });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalled());
    expect(client.updateEntry.mock.calls[0]?.[2]).toEqual({ expectedVersion: 2 });
    // Taken in once: a later canvas on this entry starts from what is saved.
    expect(peekDraft(draftId('sp', 'main', 'e1'))).toBeNull();
  });

  it('leaves the form’s edits waiting when it is left before the entry loads', async () => {
    handOffDraft(draftId('sp', 'main', 'e1'), 2, { title: { 'en-US': 'From the form' } });
    const router = await setup({}, { loading: true });
    act(() => void router.navigate('/content/page/e1'));
    expect(await screen.findByText('The form')).toBeTruthy();
    expect(peekDraft(draftId('sp', 'main', 'e1'))?.fields).toEqual({
      title: { 'en-US': 'From the form' },
    });
  });

  it('says where to save the form’s edits when it can only review them', async () => {
    client.getSpaceAccess.mockResolvedValueOnce({ subject: 'me', scopes: ['content:read'] });
    handOffDraft(draftId('sp', 'main', 'e1'), 3, { title: { 'en-US': 'From the form' } });
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'From the form' });
    expect(await screen.findByText(/can’t be saved from this view/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it('holds the settings while the dock is open: dimmed, inert, the selection stepped back', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    openLayers();
    act(() => layer('h1').click());
    const settings = screen.getByRole('complementary', { name: 'Block settings' });
    expect(settings.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[data-outline="selected"]')).not.toBeNull();
    act(() => seam('body#1').click());
    expect(settings.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-outline="selected"]')).toBeNull();
    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    await waitFor(() => expect(settings.hasAttribute('inert')).toBe(false));
  });

  it('remembers Layers open at lg, and never opens its sheet below lg on arrival', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    expect(localStorage.getItem('cw.canvas.layers')).toBe('open');
    cleanup();
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.getByRole('button', { name: 'Layers' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    cleanup();
    media = { wide: false, tablet: true };
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.queryByRole('dialog', { name: 'Layers' })).toBeNull();
  });

  it('hands its edits to the form instead of asking to discard them', async () => {
    const router = await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('a1').click());
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
    act(() => screen.getByRole('radio', { name: 'Form' }).click());
    expect(await screen.findByText('The form')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(router.state.location.pathname).toBe('/content/page/e1');
    const handed = peekDraft(draftId('sp', 'main', 'e1'));
    expect(handed?.version).toBe(3);
    expect(Object.keys(handed?.fields ?? {})).toEqual(['body']);
  });

  it('still asks before leaving the entry altogether', async () => {
    const router = await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('a1').click());
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
    act(() => void router.navigate('/content/page'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Discard unsaved changes?')).toBeTruthy();
    expect(peekDraft(draftId('sp', 'main', 'e1'))).toBeNull();
  });

  it('refuses to save while a required slot is empty, and lists it in the checks', async () => {
    const fields = pageFields();
    ((fields.body!['en-US'] as unknown[])[1] as { items: unknown[] }).items = [];
    await setup({ fields });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.getByRole('button', { name: 'Items needs a block' })).toBeTruthy();
    openLayers();
    act(() => layer('a1').click());
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    expect(client.updateEntry).not.toHaveBeenCalled();
    expect(await screen.findByText('Fix 1 check to save the draft')).toBeTruthy();
    // The checks are in view, and a check selects the block it is about.
    act(() => screen.getByRole('button', { name: 'Items needs a block' }).click());
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeTruthy();
  });
});

describe('the block config', () => {
  /** The fixture's catalog with the section's items as a slot, as a push would have it. */
  const slotted = {
    ...catalog,
    version: 2,
    blocks: catalog.blocks.map((b) =>
      b.id === 'section'
        ? { ...b, slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], max: 2 }] }
        : b,
    ),
  } as BlockCatalog;
  /** Heroes and sections only at the top; the section's items locked. */
  const NARROWED: Pick<BlockConfig, 'version' | 'targets' | 'blocks'> = {
    version: 1,
    targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'section'] }],
    blocks: [{ block: 'section', slots: { items: { locked: true } } }],
  };
  beforeEach(() => {
    client.getBlockCatalog.mockResolvedValue(slotted);
    client.getEffectiveBlockRules.mockResolvedValue(effectiveBlockRules(slotted, NARROWED));
  });

  it('offers in the dock only what the narrowed rule takes, and keeps what is stored', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    act(() => seam('body#1').click());
    expect(
      [...dock().querySelectorAll('[data-dock-item]')].map((b) => b.getAttribute('data-dock-item')),
    ).toEqual(['section', 'hero']);
    // The call to action stored before the config stays on the page, in Layers too.
    openLayers();
    expect(layer('a1')).toBeTruthy();
    expect(client.getEffectiveBlockRules).toHaveBeenCalledTimes(1);
  });

  it('draws no seams in a locked slot, says the lock in Layers, and keeps its blocks in place', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    expect(
      [...document.querySelectorAll('[data-seam]')].map((el) => el.getAttribute('data-seam')),
    ).toEqual(['body#1', 'body#3']);
    openLayers();
    expect(screen.getByRole('group', { name: 'Items · 1 of 1–2 · locked' })).toBeTruthy();
    act(() => layer('c1').click());
    expect(
      screen.getByText(
        'Items is locked: this block keeps its place. Its settings can still be edited.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Card' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Card down' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Duplicate Card' })).toBeNull();
    // Nor do the keys move or remove it.
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'ArrowUp', metaKey: true });
    expect(layer('c1')).toBeTruthy();
    // The section holding it says so, and offers no Add there.
    act(() => layer('s1').click());
    expect(screen.queryByRole('button', { name: 'Add to Items' })).toBeNull();
    const settings = screen.getByRole('complementary', { name: 'Block settings' });
    expect(within(settings).getByText('Items · 1 of 1–2 · locked')).toBeTruthy();
  });

  it('won’t duplicate a stored block the narrowed rule no longer takes', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('a1').click());
    const copy = screen.getByRole('button', {
      name: 'Duplicate Call to action',
    }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    // Still edited in place.
    expect((screen.getByLabelText(/^Label/) as HTMLInputElement).value).toBe('Start');
  });

  it('says a save the server’s config refused on the block it names', async () => {
    client.updateEntry.mockRejectedValueOnce(
      new ApiError(422, 'Validation failed', {
        error: {
          code: 'validation_failed',
          message: 'Validation failed',
          issues: [
            {
              field: 'body[0]',
              locale: 'en-US',
              code: 'block_not_allowed_here',
              key: 'h1',
              message: '"Hero banner" can’t go here',
            },
          ],
        },
      }),
    );
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    act(() => layer('h1').click());
    fireEvent.change(screen.getByLabelText(/^Heading/), { target: { value: 'Hello' } });
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    const check = await screen.findByRole('button', {
      name: 'Hero can’t go in Main: the block config doesn’t allow it there',
    });
    expect(
      await screen.findByText('The block config refused a change: see the checks'),
    ).toBeTruthy();
    act(() => check.click());
    expect(screen.getByRole('heading', { level: 2, name: 'Hero' })).toBeTruthy();
  });
});

describe('what the canvas says instead of editing', () => {
  it('explains a type without a preview URL, with the way back to the form', async () => {
    client.listContentTypes.mockResolvedValueOnce([{ ...pageType, preview: undefined }]);
    await setup();
    expect(await screen.findByText('Page has no preview URL')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit in the form' }).getAttribute('href')).toBe(
      '/content/page/e1',
    );
    expect(screen.queryByTitle('Site preview')).toBeNull();
  });

  it('is review-only for a role that can’t edit', async () => {
    client.getSpaceAccess.mockResolvedValueOnce({ subject: 'me', scopes: ['preview:read'] });
    await setup();
    expect(await screen.findByText(/Your role can read this entry but not edit it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it('is review-only for a role that can’t change the blocks field, and says which', async () => {
    client.getSpaceAccess.mockResolvedValueOnce({
      subject: 'me',
      scopes: ['content:write'],
      fieldRules: {
        types: { page: { deniedFields: [], readOnlyFields: ['body'] } },
        others: { deniedFields: [], readOnlyFields: [] },
      },
    });
    await setup();
    expect(
      await screen.findByText(/Your role can’t change Main: the canvas is for review here/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'the form' }).getAttribute('href')).toBe(
      '/content/page/e1',
    );
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it('is review-only below md, and says so', async () => {
    media = { wide: false, tablet: false };
    await setup();
    expect(await screen.findByText(/Arranging blocks needs a wider screen/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it('shows the published version read-only until a draft is started', async () => {
    await setup({ status: 'published' });
    await screen.findByText(/This is the published version/);
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    act(() => screen.getByRole('button', { name: 'Edit a draft' }).click());
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
  });

  it('says where the entry is in a workflow', async () => {
    client.getEntryWorkflowState.mockResolvedValue({ workflowId: 'w', currentStepId: 'r' });
    client.listWorkflows.mockResolvedValue([
      { id: 'w', steps: [{ id: 'r', name: 'Legal review' }] },
    ]);
    await setup();
    expect(await screen.findByText('Legal review')).toBeTruthy();
  });

  it('offers to keep or remove a block the code no longer provides', async () => {
    const fields = pageFields();
    (fields.body!['en-US'] as unknown[]).push({ _type: 'gone', _key: 'g1' });
    await setup({ fields });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    openLayers();
    expect(within(layer('g1')).getByText('Removed from code')).toBeTruthy();
    act(() => layer('g1').click());
    act(() => screen.getByRole('button', { name: 'Keep for now' }).click());
    expect(screen.queryByRole('button', { name: 'Keep for now' })).toBeNull();
    act(() => screen.getByRole('button', { name: 'Remove' }).click());
    expect(layer('g1')).toBeNull();
  });

  it('reuses the Site pane’s notice when the page never connects', async () => {
    await setup();
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    frame().say({ type: 'status', status: 'not-connected' });
    expect(screen.getByText('This site isn’t connected for live preview')).toBeTruthy();
  });
});
