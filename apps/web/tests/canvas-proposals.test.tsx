// @vitest-environment jsdom
// Coworker on the canvas: "Ask Coworker to fill this" at a seam asks for exactly what the dock
// offers there (and is never offered where the dock offers nothing), with the slot in that one
// message; a proposal waiting in a card goes to the page as ghosts, which the canvas marks
// "Proposed" in words and Layers lists as proposed; Not now takes them back; a saved one is read
// again as the entry.
import {
  type BlockCatalog,
  type ContentType,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProposedBlocks, useAssistant } from '~/cms/lib/assistant';
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
  getEntryBlockLocks: vi.fn(async () => ({ locks: [], stale: [] })),
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
const { AssistantProvider } = await import('~/cms/lib/assistant');
const { FeaturesProvider } = await import('~/cms/lib/features');
const { EntryCanvas } = await import('~/cms/routes/EntryCanvas');

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1024px') || query.includes('768px'),
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
});

/** What the assistant holds, as the test reads and drives it (the panel isn't mounted). */
let assistant: ReturnType<typeof useAssistant>;
function Probe() {
  assistant = useAssistant();
  return null;
}

async function setup({ coworker = true, version = 3 } = {}) {
  client.getEntry.mockResolvedValue({
    id: 'e1',
    contentType: 'page',
    status: 'draft',
    version,
    fields: pageFields(),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/content/:typeId/:entryId/canvas', element: <EntryCanvas /> }],
    { initialEntries: ['/content/page/e1/canvas'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <FeaturesProvider value={{ assistant: coworker }}>
        <AssistantProvider>
          <Probe />
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </AssistantProvider>
      </FeaturesProvider>
    </QueryClientProvider>,
  );
  await screen.findByTitle('Site preview');
}

/** The Site frame: says it's up, that the page connected with `capabilities`, and its geometry. */
function frame() {
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
  return {
    posted,
    say,
    connect(
      capabilities = ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout', 'proposals'],
    ) {
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
      gaps: [{ index: 1, axis: 'y', after: 'h1', before: 's1', rect: rect(40) }],
    },
    {
      ref: ref('body[s1].items'),
      rect: rect(60, 80),
      gaps: [{ index: 1, axis: 'y', after: 'c1', rect: rect(130) }],
    },
  ],
};

/** The dry run's applied insert of a call to action after the hero, keyed as the api keys it. */
const GHOST: ProposedBlocks = {
  entryId: 'e1',
  spaceId: 'sp',
  environmentId: 'main',
  state: 'pending',
  ops: [
    {
      op: 'insert',
      field: 'body',
      locale: 'en-US',
      index: 1,
      block: { _type: 'cta', _key: 'g1', label: 'Proposed by Coworker' },
    },
  ],
};

const seam = (id: string) => document.querySelector(`[data-seam="${id}"]`) as HTMLElement;
const proposals = (f: ReturnType<typeof frame>) => f.posted.filter((m) => m.type === 'proposal');

describe('Ask Coworker to fill this', () => {
  it('asks for what the dock offers at that seam, with the slot in that one message', async () => {
    await setup();
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    act(() => seam('body#1').click());
    const ask = await screen.findByRole('button', { name: 'Ask Coworker to fill this' });
    act(() => ask.click());
    expect(assistant.pendingAsk?.text).toBe('Fill Main after Hero');
    const page = assistant.pendingAsk?.page;
    expect(page).toMatchObject({ kind: 'entry', entryId: 'e1', contentType: 'page' });
    const fill = page?.kind === 'entry' ? page.fill : undefined;
    expect(fill).toMatchObject({ field: 'body', locale: 'en-US', after: 'h1', slot: 'Main' });
    expect(fill?.blocks.map((b) => b.type)).toEqual(['section', 'hero', 'cta']);
    expect(fill?.around).toEqual([
      'Hero “Welcome”',
      'Section “Features”',
      'Call to action “Start”',
    ]);
    // Asking puts nothing in: the dock closes, and the draft is as it was.
    expect(screen.queryByRole('region', { name: /^Add to/ })).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('is not offered with Coworker off, nor where the dock offers nothing (a full slot)', async () => {
    await setup({ coworker: false });
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    act(() => seam('body#1').click());
    await screen.findByRole('region', { name: /^Add to/ });
    expect(screen.queryByRole('button', { name: 'Ask Coworker to fill this' })).toBeNull();
    cleanup();

    await setup();
    const g = frame();
    g.connect();
    g.geometry(GEOMETRY);
    // The section's items hold one of two: offered; filled to two by hand, the slot is full.
    act(() => seam('body[s1].items#1').click());
    expect(await screen.findByRole('button', { name: 'Ask Coworker to fill this' })).toBeTruthy();
    act(() => screen.getByRole('button', { name: /^Card/ }).click());
    act(() => seam('body[s1].items#1').click());
    expect(await screen.findByText(/is full: it holds 2 of 2/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask Coworker to fill this' })).toBeNull();
  });

  it('waits while the canvas holds unsaved edits, and says why', async () => {
    await setup();
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    act(() => seam('body#1').click());
    // Put a block in by hand: the draft now differs from what Coworker would read.
    act(() => screen.getByRole('button', { name: /^Call to action/ }).click());
    act(() => seam('body#1').click());
    const ask = await screen.findByRole('button', { name: 'Ask Coworker to fill this' });
    expect((ask as HTMLButtonElement).disabled).toBe(true);
    expect(ask.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/Save the draft first/)).toBeTruthy();
  });
});

describe('a proposal waiting in Coworker', () => {
  it('goes to the page as ghosts, marked Proposed on the canvas and listed in Layers', async () => {
    await setup();
    const f = frame();
    f.connect();
    act(() => assistant.setProposal('card-1', GHOST));
    await waitFor(() => expect(proposals(f).at(-1)).toMatchObject({ ops: GHOST.ops }));
    // The page drew it and says it shows it.
    f.say({ type: 'proposal', shown: true });
    f.geometry({
      ...GEOMETRY,
      blocks: [...GEOMETRY.blocks, { ref: ref('body[g1]'), rect: rect(42, 6) }],
    });
    const mark = document.querySelector('[data-ghost-outline="inserted"]');
    expect(mark?.textContent).toBe('Proposed');
    expect(screen.getByText(/Coworker’s proposal is on the page, marked Proposed/)).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Layers' }).click());
    const list = screen.getByRole('list', { name: 'Proposed for Main' });
    expect(within(list).getByText('Call to action')).toBeTruthy();
    expect(within(list).getByText('Proposed')).toBeTruthy();
    expect(within(list).getByText('After Hero')).toBeTruthy();
    // Not a block of the entry: no tree item, and the draft is unchanged.
    expect(document.querySelector('[data-layer="g1"]')).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('is taken off the page on Not now', async () => {
    await setup();
    const f = frame();
    f.connect();
    act(() => assistant.setProposal('card-1', GHOST));
    await waitFor(() => expect(proposals(f)).toHaveLength(1));
    act(() => assistant.setProposal('card-1', { ...GHOST, state: 'declined' }));
    await waitFor(() => expect(proposals(f).at(-1)).toMatchObject({ ops: null }));
    expect(screen.queryByText(/Coworker’s proposal is on the page/)).toBeNull();
  });

  it('is read again as the entry once its card saved it', async () => {
    await setup();
    const f = frame();
    f.connect();
    act(() => assistant.setProposal('card-1', GHOST));
    act(() => assistant.setProposal('card-1', { ...GHOST, state: 'saving' }));
    await waitFor(() => expect(proposals(f)).toHaveLength(1));
    // Confirmed: the line says it is saving, never that nothing is saved yet.
    expect(screen.getByText(/Saving Coworker’s proposal/)).toBeTruthy();
    expect(screen.queryByText(/Nothing is saved until you confirm/)).toBeNull();
    const saved = pageFields();
    (saved.body as Record<string, unknown[]>)['en-US']?.splice(1, 0, {
      _type: 'cta',
      _key: 'k9',
      label: 'Proposed by Coworker',
    });
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'page',
      status: 'draft',
      version: 4,
      fields: saved,
    });
    act(() => assistant.setProposal('card-1', { ...GHOST, state: 'saved' }));
    await waitFor(() => expect(proposals(f).at(-1)).toMatchObject({ ops: null }));
    await screen.findByText('v4');
    expect(screen.getByText('Saved Coworker’s change')).toBeTruthy();
    // The saved block is the entry's now: in Layers as a block, not as a proposal.
    act(() => screen.getByRole('button', { name: 'Layers' }).click());
    expect(document.querySelector('[data-layer="k9"]')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Proposed for Main' })).toBeNull();
  });

  it('says so when the page’s SDK can’t show proposals, and leaves another entry’s alone', async () => {
    await setup();
    const f = frame();
    f.connect(['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout']);
    act(() => assistant.setProposal('card-2', { ...GHOST, entryId: 'other' }));
    expect(screen.queryByText(/proposal/i)).toBeNull();
    act(() => assistant.setProposal('card-1', GHOST));
    expect(await screen.findByText(/doesn’t show proposals on the page/)).toBeTruthy();
  });
});

describe('a proposal saved while the canvas holds edits of its own', () => {
  it('keeps the edits, says the newer draft is there, and reads nothing over them', async () => {
    await setup();
    const f = frame();
    f.connect();
    f.geometry(GEOMETRY);
    act(() => assistant.setProposal('card-1', GHOST));
    // An edit by hand meanwhile.
    act(() => seam('body#1').click());
    act(() => screen.getByRole('button', { name: /^Call to action/ }).click());
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    act(() => assistant.setProposal('card-1', { ...GHOST, state: 'saved' }));
    expect(
      await screen.findByText(/Saved Coworker’s change\. Your unsaved edits are kept/),
    ).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
  });
});
