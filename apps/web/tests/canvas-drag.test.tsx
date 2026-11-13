// @vitest-environment jsdom
// Moving blocks on the canvas: dragging the selected block by its grip with a fine pointer (to a
// seam of its slot or another that takes it, in its blocks field or another, refused where it can't
// go, put back with Esc, never on a touch screen), the page scrolling under a block carried near
// the frame's edge (in steps, or jumps with reduced motion), and Move to as the keyboard's and a
// finger's way to another slot, each one undoable step.
import {
  type BlockCatalog,
  type ContentType,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  type EntryFields,
  effectiveBlockRules,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_CHANNEL, type FrameGeometry } from '~/cms/lib/live-preview/frame-channel';
import type { PreviewEntry } from '~/cms/lib/management';
import { catalog, pageFields, pageType, ref } from './canvas-fixture';

const client = {
  listContentTypes: vi.fn(async (): Promise<ContentType[]> => [pageType]),
  getSpaceConfig: vi.fn(async () => ({ defaultLocale: 'en-US', locales: ['en-US'] })),
  getEntry: vi.fn<(id: string) => Promise<PreviewEntry>>(),
  getBlockCatalog: vi.fn(async (): Promise<BlockCatalog> => catalog),
  getEffectiveBlockRules: vi.fn(
    async (): Promise<EffectiveBlockRules> => effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG),
  ),
  getSpaceAccess: vi.fn(async () => ({ subject: 'me', scopes: ['content:write'] })),
  getEntryWorkflowState: vi.fn(async (): Promise<unknown> => null),
  listWorkflows: vi.fn(async (): Promise<unknown[]> => []),
  listEntries: vi.fn(async () => []),
  listAssets: vi.fn(async () => ({ items: [] })),
  suggestEntries: vi.fn(async () => []),
  updateEntry: vi.fn(),
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

const { ToastProvider } = await import('~/cms/lib/toast');
const { EntryCanvas } = await import('~/cms/routes/EntryCanvas');

/** lg and up, with a mouse or trackpad by default, and motion. */
let media = { wide: true, tablet: true, fine: true, still: false };
beforeEach(() => {
  media = { wide: true, tablet: true, fine: true, still: false };
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1024px')
      ? media.wide
      : query.includes('768px')
        ? media.tablet
        : query.includes('pointer: fine')
          ? media.fine
          : query.includes('pointer: coarse')
            ? !media.fine
            : query.includes('prefers-reduced-motion')
              ? media.still
              : false,
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
  client.listContentTypes.mockImplementation(async () => [pageType]);
  localStorage.clear();
});

/** The page type with a second blocks field, `aside`, taking calls to action as Main defines them. */
const withAside = (() => {
  const body = pageType.fields.find((f) => f.apiId === 'body');
  const variants = (body?.items?.variants ?? []).filter((v) => v.apiId === 'cta');
  return {
    ...pageType,
    fields: [
      ...pageType.fields,
      {
        apiId: 'aside',
        name: 'Aside',
        type: 'Array',
        localized: false,
        required: false,
        position: 2,
        items: { type: 'Component', variants },
      },
    ],
  } as unknown as ContentType;
})();

/** h1, s1 [c1], s2 [c2, c3], a1. */
function twoSections(): EntryFields {
  const fields = pageFields();
  const body = fields.body?.['en-US'] as unknown[];
  body.splice(2, 0, {
    _type: 'section',
    _key: 's2',
    heading: 'More',
    items: [
      { _type: 'card', _key: 'c2', title: 'Safe' },
      { _type: 'card', _key: 'c3', title: 'Sound' },
    ],
  });
  return fields;
}

async function setup(fields: EntryFields = twoSections()) {
  client.getEntry.mockResolvedValue({
    id: 'e1',
    contentType: 'page',
    status: 'draft',
    version: 3,
    fields,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/content/:typeId/:entryId/canvas', element: <EntryCanvas /> }],
    { initialEntries: ['/content/page/e1/canvas'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Home' });
}

/** The Site frame: up, connected with layout, and reporting `geometry`. */
function frame(geometry?: FrameGeometry) {
  const el = screen.getByTitle('Site preview') as HTMLIFrameElement;
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(el.contentWindow as Window, 'postMessage').mockImplementation((m: unknown) => {
    posted.push(m as Record<string, unknown>);
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
  say({ type: 'ready', origin: 'https://site.example' });
  say({ type: 'status', status: 'live' });
  say({
    type: 'session',
    entries: ['e1'],
    capabilities: ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout'],
  });
  if (geometry) say({ type: 'geometry', geometry });
  return { posted, say };
}

const rect = (y: number, h = 10) => ({ x: 0, y, w: 100, h });
/** The page's boxes: Main's blocks down the page, each section's cards inside it. */
const GEOMETRY: FrameGeometry = {
  truncated: false,
  blocks: [
    { ref: ref('body[h1]'), rect: rect(0, 40) },
    { ref: ref('body[s1]'), rect: rect(50, 100) },
    { ref: ref('body[s1].items[c1]'), rect: rect(70, 40) },
    { ref: ref('body[s2]'), rect: rect(200, 150) },
    { ref: ref('body[s2].items[c2]'), rect: rect(220, 40) },
    { ref: ref('body[s2].items[c3]'), rect: rect(280, 40) },
    { ref: ref('body[a1]'), rect: rect(400, 40) },
  ],
  slots: [
    {
      ref: ref('body'),
      rect: rect(0, 450),
      gaps: [
        { index: 1, axis: 'y', after: 'h1', before: 's1', rect: rect(40) },
        { index: 2, axis: 'y', after: 's1', before: 's2', rect: rect(150) },
        { index: 3, axis: 'y', after: 's2', before: 'a1', rect: rect(360) },
        { index: 4, axis: 'y', after: 'a1', rect: rect(440) },
      ],
    },
    {
      ref: ref('body[s1].items'),
      rect: rect(60, 80),
      gaps: [
        { index: 0, axis: 'y', before: 'c1', rect: rect(62) },
        { index: 1, axis: 'y', after: 'c1', rect: rect(112) },
      ],
    },
    {
      ref: ref('body[s2].items'),
      rect: rect(210, 130),
      gaps: [
        { index: 0, axis: 'y', before: 'c2', rect: rect(212) },
        { index: 1, axis: 'y', after: 'c2', before: 'c3', rect: rect(262) },
        { index: 2, axis: 'y', after: 'c3', rect: rect(322) },
      ],
    },
  ],
};

const layer = (key: string) => document.querySelector(`[data-layer="${key}"]`) as HTMLElement;
const openLayers = () => act(() => screen.getByRole('button', { name: 'Layers' }).click());
const select = (key: string) => {
  openLayers();
  act(() => layer(key).click());
};
const grip = () => document.querySelector('[data-drag-handle]') as HTMLElement | null;
const said = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';
/** The keys of a section's cards, as Layers lists them. */
const cardsIn = (section: string) =>
  [...layer(section).querySelectorAll('[role="group"] [data-layer]')].map((el) =>
    el.getAttribute('data-layer'),
  );

/** Presses the grip, travels to `(x, y)` (in the stage, which jsdom places at 0,0) and lets go. */
function drag(to: { x: number; y: number }, opts: { release?: boolean } = {}) {
  const handle = grip() as HTMLElement;
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 90, clientY: 290 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 90, clientY: 296 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to.x, clientY: to.y });
  if (opts.release !== false) {
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: to.x, clientY: to.y });
  }
}

describe('dragging a block with a fine pointer', () => {
  it('moves it to a seam of another slot that takes it, as one move that undo takes back', async () => {
    await setup();
    const f = frame(GEOMETRY);
    select('c3');
    expect(grip()?.getAttribute('title')).toBe('Drag to move Card');
    expect(cardsIn('s1')).toEqual(['c1']);

    drag({ x: 50, y: 64 }, { release: false });
    // In hand: the seam under the pointer takes the insertion line; Main's seams, which don't
    // take a card, aren't drawn.
    expect(document.querySelector('[data-drag-chip]')?.textContent).toBe('Moving Card');
    expect(
      document.querySelector('[data-seam="body[s1].items#0"] [data-insertion-line]'),
    ).toBeTruthy();
    expect(document.querySelector('[data-seam="body#1"]')).toBeNull();
    fireEvent.pointerUp(grip() as HTMLElement, { pointerId: 1, clientX: 50, clientY: 64 });

    expect(cardsIn('s1')).toEqual(['c3', 'c1']);
    expect(cardsIn('s2')).toEqual(['c2']);
    expect(said()).toBe('Moved Card to Section “Features” › Items');
    expect(document.querySelector('[data-drag-chip]')).toBeNull();
    // The page re-renders the move before anything is saved.
    await waitFor(() =>
      expect(f.posted.some((m) => m.type === 'entry' && JSON.stringify(m).includes('c3'))).toBe(
        true,
      ),
    );

    act(() => screen.getByRole('button', { name: 'Undo' }).click());
    expect(cardsIn('s1')).toEqual(['c1']);
    expect(cardsIn('s2')).toEqual(['c2', 'c3']);
    expect(said()).toBe('Undone: Moved Card to Section “Features” › Items');
  });

  it('reorders within its slot', async () => {
    await setup();
    frame(GEOMETRY);
    select('c3');
    drag({ x: 50, y: 213 });
    expect(cardsIn('s2')).toEqual(['c3', 'c2']);
    expect(said()).toBe('Moved Card up');
  });

  it('refuses a place the slot doesn’t allow, saying why on the seam, and changes nothing', async () => {
    await setup();
    frame(GEOMETRY);
    select('h1');
    drag({ x: 50, y: 113 }, { release: false });
    const seam = document.querySelector('[data-seam="body[s1].items#1"]') as HTMLElement;
    expect(seam.getAttribute('data-drop')).toBe('refused');
    expect(within(seam).getByText('Items doesn’t take Hero')).toBeTruthy();
    expect(seam.querySelector('[data-insertion-line]')).toBeNull();
    fireEvent.pointerUp(grip() as HTMLElement, { pointerId: 1, clientX: 50, clientY: 113 });
    expect(said()).toBe('Items doesn’t take Hero');
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
  });

  it('refuses a full slot', async () => {
    await setup();
    frame(GEOMETRY);
    // s2's items hold two of two.
    select('c1');
    drag({ x: 50, y: 263 });
    expect(said()).toBe('Items is full (2 at most)');
    expect(cardsIn('s1')).toEqual(['c1']);
  });

  it('puts it back with Esc, and the canvas keeps its selection', async () => {
    await setup();
    frame(GEOMETRY);
    select('c3');
    drag({ x: 50, y: 64 }, { release: false });
    // The press took focus out of the framed page (whose keys the admin never hears).
    expect(document.activeElement?.hasAttribute('data-canvas-stage')).toBe(true);
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    });
    expect(document.querySelector('[data-drag-chip]')).toBeNull();
    expect(said()).toBe('Card stays where it was');
    expect(cardsIn('s2')).toEqual(['c2', 'c3']);
    // The block is still selected: Esc put it down, it didn't deselect.
    expect(layer('c3').getAttribute('aria-selected')).toBe('true');
  });

  it('offers no grip to a touch screen, or for a block that keeps its place', async () => {
    media.fine = false;
    await setup();
    frame(GEOMETRY);
    select('c3');
    expect(grip()).toBeNull();
    cleanup();
    // A new canvas, as on a first visit: Layers would open again, remembered from the one before.
    localStorage.clear();

    media.fine = true;
    // The section's items locked by the block config: its cards keep their place.
    const slotted = {
      ...catalog,
      version: 2,
      blocks: catalog.blocks.map((b) =>
        b.id === 'section'
          ? { ...b, slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'] }] }
          : b,
      ),
    } as BlockCatalog;
    client.getBlockCatalog.mockResolvedValueOnce(slotted);
    client.getEffectiveBlockRules.mockResolvedValueOnce(
      effectiveBlockRules(slotted, {
        ...EMPTY_BLOCK_CONFIG,
        version: 1,
        blocks: [{ block: 'section', slots: { items: { locked: true } } }],
      }),
    );
    await setup();
    frame(GEOMETRY);
    select('c3');
    expect(grip()).toBeNull();
    // A block outside the lock still has one.
    act(() => layer('h1').click());
    expect(grip()?.getAttribute('data-drag-handle')).toBe('h1');
  });
});

describe('Move to, the keyboard’s way to another slot', () => {
  it('lists the slots that take the block, moves it to the end of one, and focuses its settings', async () => {
    await setup();
    frame(GEOMETRY);
    select('c2');
    const settings = screen.getByRole('complementary', { name: 'Block settings' });
    const trigger = within(settings).getByRole('button', { name: 'Move Card to another slot' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const item = await screen.findByRole('menuitem', { name: 'Section “Features” › Items' });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    act(() => fireEvent.click(item));
    expect(cardsIn('s1')).toEqual(['c1', 'c2']);
    expect(said()).toBe('Moved Card to Section “Features” › Items');
    await waitFor(() =>
      expect(document.activeElement?.hasAttribute('data-inspector-heading')).toBe(true),
    );
  });

  it('isn’t offered where the block has nowhere else to go', async () => {
    await setup();
    frame(GEOMETRY);
    select('c1');
    const settings = screen.getByRole('complementary', { name: 'Block settings' });
    expect(within(settings).queryByRole('button', { name: /to another slot/ })).toBeNull();
  });
});

/** Main as GEOMETRY draws it, and the aside below the fold: its seams at 602 and 690. */
const ASIDE: FrameGeometry = {
  ...GEOMETRY,
  blocks: [...GEOMETRY.blocks, { ref: ref('aside[x1]'), rect: rect(610, 60) }],
  slots: [
    ...GEOMETRY.slots,
    {
      ref: ref('aside'),
      rect: rect(600, 100),
      gaps: [
        { index: 0, axis: 'y', before: 'x1', rect: rect(602) },
        { index: 1, axis: 'y', after: 'x1', rect: rect(690) },
      ],
    },
  ],
};
/** `g` as the page reports it once scrolled `by` pixels down. */
const scrolled = (g: FrameGeometry, by: number): FrameGeometry => ({
  ...g,
  blocks: g.blocks.map((b) => ({ ...b, rect: { ...b.rect, y: b.rect.y - by } })),
  slots: g.slots.map((s) => ({
    ...s,
    rect: { ...s.rect, y: s.rect.y - by },
    gaps: s.gaps.map((x) => ({ ...x, rect: { ...x.rect, y: x.rect.y - by } })),
  })),
});
const asideFields = (): EntryFields => ({
  ...twoSections(),
  aside: { 'en-US': [{ _type: 'cta', _key: 'x1', label: 'More' }] },
});
/** The keys of a top-level field's blocks in the state the page was last sent. */
const sentKeys = (posted: Record<string, unknown>[], field: string) => {
  const sent = posted.filter((m) => m.type === 'entry').at(-1) as
    | { entry: { fields: Record<string, { _key: string }[]> } }
    | undefined;
  return (sent?.entry.fields[field] ?? []).map((b) => b._key);
};
/** The stage at a height jsdom doesn't lay out: what the edges are measured from. */
const stageOf = (height: number) => {
  const el = document.querySelector('[data-canvas-stage]') as HTMLElement;
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  return el;
};
const scrolls = (posted: Record<string, unknown>[]) =>
  posted.filter((m) => m.type === 'scrollBy').map((m) => m.dy as number);

describe('dragging into another blocks field', () => {
  it('moves the block there as one step, which undo takes back to where it was', async () => {
    client.listContentTypes.mockImplementation(async () => [withAside]);
    await setup(asideFields());
    const f = frame(ASIDE);
    select('a1');
    drag({ x: 50, y: 604 });
    expect(said()).toBe('Moved Call to action to Aside');
    await waitFor(() => expect(sentKeys(f.posted, 'aside')).toEqual(['a1', 'x1']));
    expect(sentKeys(f.posted, 'body')).toEqual(['h1', 's1', 's2']);
    // Still selected where it landed, with its settings.
    expect(layer('a1').getAttribute('aria-selected')).toBe('true');

    act(() => screen.getByRole('button', { name: 'Undo' }).click());
    expect(said()).toBe('Undone: Moved Call to action to Aside');
    await waitFor(() => expect(sentKeys(f.posted, 'aside')).toEqual(['x1']));
    expect(sentKeys(f.posted, 'body')).toEqual(['h1', 's1', 's2', 'a1']);
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
  });

  it('refuses another field holding a block with its key, saying why', async () => {
    client.listContentTypes.mockImplementation(async () => [withAside]);
    await setup({
      ...twoSections(),
      aside: { 'en-US': [{ _type: 'cta', _key: 'a1', label: 'Twin' }] },
    });
    // The aside's block as the page draws it, under the key it shares with Main's.
    frame(
      JSON.parse(
        JSON.stringify(ASIDE).replaceAll('aside[x1]', 'aside[a1]').replaceAll('"x1"', '"a1"'),
      ),
    );
    // Two blocks share the key, one per field: the first is Main's.
    select('a1');
    drag({ x: 50, y: 604 });
    expect(said()).toBe('Aside already has a copy of this Call to action: add a new one there');
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
  });

  it('offers the other field in Move to', async () => {
    client.listContentTypes.mockImplementation(async () => [withAside]);
    await setup(asideFields());
    const f = frame(ASIDE);
    select('a1');
    const settings = screen.getByRole('complementary', { name: 'Block settings' });
    const trigger = within(settings).getByRole('button', {
      name: 'Move Call to action to another slot',
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: 'Aside' })));
    expect(said()).toBe('Moved Call to action to Aside');
    await waitFor(() => expect(sentKeys(f.posted, 'aside')).toEqual(['x1', 'a1']));
  });
});

describe('the page scrolling under a carried block', () => {
  it('scrolls in steps near the bottom edge, and the seam the page brings up takes the block', async () => {
    client.listContentTypes.mockImplementation(async () => [withAside]);
    await setup(asideFields());
    const f = frame(ASIDE);
    select('a1');
    stageOf(600);
    drag({ x: 50, y: 590 }, { release: false });
    await waitFor(() => expect(scrolls(f.posted).length).toBeGreaterThan(1));
    // Small steps, nearer the edge faster: never a jump.
    expect(scrolls(f.posted).every((dy) => dy > 0 && dy <= 24)).toBe(true);
    // The page scrolled 100px: the aside's last seam is under the pointer now, unmoved.
    f.say({ type: 'geometry', geometry: scrolled(ASIDE, 100) });
    expect(document.querySelector('[data-seam="aside#1"] [data-insertion-line]')).toBeTruthy();
    fireEvent.pointerUp(grip() as HTMLElement, { pointerId: 1, clientX: 50, clientY: 590 });
    expect(said()).toBe('Moved Call to action to Aside');
  });

  it('scrolls up near the top edge, and not at all away from the edges', async () => {
    await setup();
    const f = frame(GEOMETRY);
    select('c3');
    stageOf(600);
    drag({ x: 50, y: 300 }, { release: false });
    drag({ x: 50, y: 4 }, { release: false });
    await waitFor(() => expect(scrolls(f.posted).length).toBeGreaterThan(0));
    expect(scrolls(f.posted).every((dy) => dy < 0)).toBe(true);
  });

  it('jumps half the view with reduced motion, only once the pointer rests at the edge', async () => {
    media.still = true;
    await setup();
    const f = frame(GEOMETRY);
    select('c3');
    stageOf(600);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      drag({ x: 50, y: 300 }, { release: false });
      act(() => vi.advanceTimersByTime(550));
      // Passing through the edge, however late into the drag, never jumps.
      fireEvent.pointerMove(grip() as HTMLElement, { pointerId: 1, clientX: 50, clientY: 595 });
      act(() => vi.advanceTimersByTime(400));
      fireEvent.pointerMove(grip() as HTMLElement, { pointerId: 1, clientX: 50, clientY: 300 });
      act(() => vi.advanceTimersByTime(400));
      expect(scrolls(f.posted)).toEqual([]);
      // Resting there: one jump after the rest, then one per rest.
      fireEvent.pointerMove(grip() as HTMLElement, { pointerId: 1, clientX: 50, clientY: 595 });
      act(() => vi.advanceTimersByTime(560));
      expect(scrolls(f.posted)).toEqual([]);
      act(() => vi.advanceTimersByTime(80));
      expect(scrolls(f.posted)).toEqual([300]);
      act(() => vi.advanceTimersByTime(640));
      expect(scrolls(f.posted)).toEqual([300, 300]);
    } finally {
      vi.useRealTimers();
    }
  });
});
