// @vitest-environment jsdom
// Locked regions on screen: the canvas draws no seams in a region and keeps its blocks in place,
// says who locked it in Layers and the inspector, offers Lock and Unlock only to someone with the
// `lock` action on the type (a lock is its own request, held to the canvas's version, waiting for
// unsaved block changes), says a refused lock in the inspector's words and reads the entry again
// after a 409, clears a stale lock from the Checks, and says a save a region refused on its block.
// The entry form shows the same lock on the blocks' cards and reads a frozen region's fields only.
import {
  type BlockCatalog,
  type ContentType,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';
import { FRAME_CHANNEL, type FrameGeometry } from '~/cms/lib/live-preview/frame-channel';
import {
  ApiError,
  type EntryBlockLock,
  type EntryBlockLocks,
  type PreviewEntry,
  type PrincipalInfo,
} from '~/cms/lib/management';
import { catalog, pageFields, pageType, ref } from './canvas-fixture';

const LOCKER: PrincipalInfo = {
  spaceId: 'sp',
  kind: 'user',
  subject: 'me',
  scopes: ['content:write'],
  contentActions: { types: {}, others: ['read', 'write', 'lock'] },
};
const EDITOR: PrincipalInfo = {
  ...LOCKER,
  contentActions: { types: { page: ['read', 'write'] }, others: ['read', 'write', 'lock'] },
};

const sectionLock: EntryBlockLock = {
  field: 'body',
  keys: ['s1'],
  depth: 'subtree',
  freeze: 'structure',
  lockedBy: 'me',
  lockedAt: '2026-11-09T10:00:00Z',
};

const locksOf = (
  locks: EntryBlockLock[],
  stale: EntryBlockLock[] = [],
  version = 3,
): EntryBlockLocks => ({ entryId: 'e1', contentTypeApiId: 'page', version, locks, stale });

const client = {
  listContentTypes: vi.fn(async (): Promise<ContentType[]> => [pageType]),
  getSpaceConfig: vi.fn(async () => ({ defaultLocale: 'en-US', locales: ['en-US'] })),
  getEntry: vi.fn<(id: string) => Promise<PreviewEntry>>(),
  getBlockCatalog: vi.fn(async (): Promise<BlockCatalog> => catalog),
  getEffectiveBlockRules: vi.fn(
    async (): Promise<EffectiveBlockRules> => effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG),
  ),
  getSpaceAccess: vi.fn(async (): Promise<PrincipalInfo> => LOCKER),
  getEntryBlockLocks: vi.fn(async (): Promise<EntryBlockLocks> => locksOf([])),
  setEntryBlockLocks: vi.fn(),
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
  client.getSpaceAccess.mockImplementation(async () => LOCKER);
  client.getEntryBlockLocks.mockImplementation(async () => locksOf([]));
  localStorage.clear();
});

async function setup() {
  client.getEntry.mockResolvedValue({
    id: 'e1',
    contentType: 'page',
    status: 'draft',
    version: 3,
    fields: pageFields(),
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

/** The page connects, reporting its blocks and seams. */
function connect() {
  const el = screen.getByTitle('Site preview') as HTMLIFrameElement;
  vi.spyOn(el.contentWindow as Window, 'postMessage').mockImplementation(() => {});
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
  const rect = (y: number, h = 10) => ({ x: 0, y, w: 100, h });
  const geometry: FrameGeometry = {
    truncated: false,
    blocks: [
      { ref: ref('body[h1]'), rect: rect(0, 40) },
      { ref: ref('body[s1]'), rect: rect(50, 100) },
      { ref: ref('body[a1]'), rect: rect(160, 40) },
    ],
    slots: [
      {
        ref: ref('body'),
        rect: rect(0, 300),
        gaps: [
          { index: 1, axis: 'y', after: 'h1', before: 's1', rect: rect(40) },
          { index: 2, axis: 'y', after: 's1', before: 'a1', rect: rect(150) },
        ],
      },
      {
        ref: ref('body[s1].items'),
        rect: rect(60, 80),
        gaps: [{ index: 1, axis: 'y', after: 'c1', rect: rect(130) }],
      },
    ],
  };
  say({ type: 'geometry', geometry });
}

const layer = (key: string) => document.querySelector(`[data-layer="${key}"]`) as HTMLElement;
const openLayers = () => act(() => screen.getByRole('button', { name: 'Layers' }).click());
const seams = () =>
  [...document.querySelectorAll('[data-seam]')].map((el) => el.getAttribute('data-seam'));

describe('a locked region on the canvas', () => {
  beforeEach(() => {
    client.getEntryBlockLocks.mockImplementation(async () => locksOf([sectionLock]));
  });

  it('draws no seams inside it, outlines it with a lock, and keeps its blocks in place', async () => {
    await setup();
    await waitFor(() => expect(client.getEntryBlockLocks).toHaveBeenCalledWith('e1'));
    connect();
    // Around the section, yes; inside it, no.
    await waitFor(() => expect(seams()).toEqual(['body#1', 'body#2']));
    expect(document.querySelectorAll('[data-region-outline]')).toHaveLength(1);

    openLayers();
    expect(layer('s1').textContent).toMatch(/Locked by you · Nov 9, 2026/);
    expect(screen.getByRole('group', { name: 'Items · 1 of 1–2 · locked' })).toBeTruthy();
    act(() => layer('s1').click());
    expect(
      screen.getByText(
        'Section is locked: it keeps its place, and so does everything inside it. Its settings can still be edited.',
      ),
    ).toBeTruthy();
    for (const name of [
      'Move Section up',
      'Move Section down',
      'Duplicate Section',
      'Remove Section',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Add to Items' })).toBeNull();
    // Nor do the keys move or remove it.
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'ArrowUp', metaKey: true });
    expect(layer('s1')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    // A block beside it still moves: past a one-block region it lands outside it, so the hero
    // may go below the section.
    act(() => layer('h1').click());
    expect(
      (screen.getByRole('button', { name: 'Move Hero down' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('unlocks for someone with `lock`, sending the list without it at the canvas’s version', async () => {
    client.setEntryBlockLocks.mockResolvedValue({ ...locksOf([]), unchanged: false });
    await setup();
    openLayers();
    await waitFor(() => expect(layer('s1').textContent).toMatch(/Locked/));
    act(() => layer('s1').click());
    act(() => screen.getByRole('button', { name: 'Unlock' }).click());
    await waitFor(() => expect(client.setEntryBlockLocks).toHaveBeenCalledWith('e1', [], 3));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Section up' })).toBeTruthy(),
    );
  });

  it('shows the lock without Unlock, or any Lock, to someone without the `lock` action', async () => {
    client.getSpaceAccess.mockImplementation(async () => EDITOR);
    await setup();
    openLayers();
    await waitFor(() => expect(layer('s1').textContent).toMatch(/Locked by you/));
    act(() => layer('s1').click());
    expect(screen.getByText(/Section is locked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
    act(() => layer('h1').click());
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Lock' })).toBeNull();
  });

  it('omits who locked it when the api doesn’t say', async () => {
    const { lockedBy: _who, ...anonymous } = sectionLock;
    client.getEntryBlockLocks.mockImplementation(async () => locksOf([anonymous]));
    await setup();
    openLayers();
    await waitFor(() => expect(layer('s1').textContent).toMatch(/Locked · Nov 9, 2026/));
    expect(layer('s1').textContent).not.toMatch(/Locked by/);
  });

  it('says a save a region refused on the block it names', async () => {
    client.updateEntry.mockRejectedValueOnce(
      new ApiError(422, 'Validation failed', {
        error: {
          code: 'validation_failed',
          issues: [
            { field: 'body', locale: 'en-US', code: 'region_locked', key: 's1', message: 'x' },
          ],
        },
      }),
    );
    // The canvas read no lock, so it lets the edit through; the server held one.
    client.getEntryBlockLocks.mockImplementation(async () => locksOf([]));
    await setup();
    openLayers();
    act(() => layer('s1').click());
    act(() => screen.getByRole('button', { name: 'Remove Section' }).click());
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    expect(
      await screen.findByText('A locked region refused a change: see the checks'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'A locked block is locked: its blocks can’t be added, removed or moved. Undo the change to save',
      ),
    ).toBeTruthy();
    // And the locks are read again, so the canvas holds what the server does.
    await waitFor(() => expect(client.getEntryBlockLocks).toHaveBeenCalledTimes(2));
  });
});

describe('locking from the inspector', () => {
  it('locks the selected block, everything inside by default, at the canvas’s version', async () => {
    client.setEntryBlockLocks.mockResolvedValue({ ...locksOf([sectionLock]), unchanged: false });
    await setup();
    openLayers();
    act(() => layer('s1').click());
    const lockButton = await screen.findByRole('button', { name: 'Lock' });
    expect(screen.getByRole('radio', { name: 'This block and everything inside' })).toHaveProperty(
      'ariaChecked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Also freeze the content' })).toHaveProperty(
      'ariaChecked',
      'false',
    );
    act(() => lockButton.click());
    await waitFor(() =>
      expect(client.setEntryBlockLocks).toHaveBeenCalledWith(
        'e1',
        [{ field: 'body', keys: ['s1'], depth: 'subtree', freeze: 'structure' }],
        3,
      ),
    );
    // The answer is the locks now: the section keeps its place.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove Section' })).toBeNull(),
    );
  });

  it('locks a run shift-selected in Layers, only those blocks, frozen when asked', async () => {
    client.setEntryBlockLocks.mockResolvedValue({ ...locksOf([]), unchanged: false });
    await setup();
    openLayers();
    act(() => layer('h1').click());
    fireEvent.click(layer('s1'), { shiftKey: true });
    expect(layer('h1').getAttribute('aria-selected')).toBe('true');
    expect(layer('s1').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('2 blocks together: Hero, Section.')).toBeTruthy();
    act(() => screen.getByRole('radio', { name: 'Only these blocks' }).click());
    act(() => screen.getByRole('checkbox', { name: 'Also freeze the content' }).click());
    act(() => screen.getByRole('button', { name: 'Lock 2 blocks' }).click());
    await waitFor(() =>
      expect(client.setEntryBlockLocks).toHaveBeenCalledWith(
        'e1',
        [{ field: 'body', keys: ['h1', 's1'], depth: 'self', freeze: 'all' }],
        3,
      ),
    );
  });

  it('takes a neighbour in with Shift and an arrow, within the slot only', async () => {
    await setup();
    openLayers();
    act(() => layer('s1').click());
    layer('s1').focus();
    fireEvent.keyDown(layer('s1'), { key: 'ArrowDown', shiftKey: true });
    expect(screen.getByText('2 blocks together: Section, Call to action.')).toBeTruthy();
  });

  it('keeps Shift with an arrow a plain move for someone without `lock`', async () => {
    client.getSpaceAccess.mockImplementation(async () => EDITOR);
    await setup();
    openLayers();
    await waitFor(() => expect(client.getSpaceAccess).toHaveBeenCalled());
    act(() => layer('s1').click());
    fireEvent.keyDown(layer('s1'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowDown', shiftKey: true });
    expect(screen.queryByText(/blocks together/)).toBeNull();
    expect(
      document.querySelectorAll('[role="treeitem"][aria-selected="true"]').length,
    ).toBeLessThanOrEqual(1);
    expect(
      screen.getByRole('tree', { name: 'Main blocks' }).hasAttribute('aria-multiselectable'),
    ).toBe(false);
  });

  it('waits for unsaved block changes, saying why', async () => {
    await setup();
    openLayers();
    act(() => layer('a1').click());
    act(() => screen.getByRole('button', { name: 'Move Call to action up' }).click());
    const lockButton = screen.getByRole('button', { name: 'Lock' }) as HTMLButtonElement;
    expect(lockButton.disabled).toBe(true);
    expect(
      screen.getByText('Save the draft first: a lock holds the blocks as they are saved.'),
    ).toBeTruthy();
  });

  it('says a refused lock in the inspector’s words', async () => {
    client.setEntryBlockLocks.mockRejectedValue(
      new ApiError(422, 'Validation failed', {
        error: { issues: [{ field: 'locks[0].keys', code: 'lock_overlaps', message: 'x' }] },
      }),
    );
    await setup();
    openLayers();
    act(() => layer('h1').click());
    act(() => screen.getByRole('button', { name: 'Lock' }).click());
    expect(
      await screen.findByText('Part of this is already in a locked region. Unlock that first.'),
    ).toBeTruthy();
  });

  it('reads the entry and its locks again when someone saved since (409)', async () => {
    client.setEntryBlockLocks.mockRejectedValue(
      new ApiError(409, 'stale', {
        error: { code: 'conflict', details: { currentVersion: 4, expectedVersion: 3 } },
      }),
    );
    await setup();
    const reads = client.getEntry.mock.calls.length;
    openLayers();
    act(() => layer('h1').click());
    act(() => screen.getByRole('button', { name: 'Lock' }).click());
    expect(
      await screen.findByText(/Someone changed this entry since the canvas opened it/),
    ).toBeTruthy();
    await waitFor(() => expect(client.getEntryBlockLocks).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.getEntry.mock.calls.length).toBeGreaterThan(reads));
  });

  it('lists a stale lock in the Checks, and clears it', async () => {
    const stale: EntryBlockLock = { ...sectionLock, keys: ['gone'] };
    client.getEntryBlockLocks.mockImplementation(async () => locksOf([stale], [stale]));
    client.setEntryBlockLocks.mockResolvedValue({ ...locksOf([]), unchanged: false });
    await setup();
    const list = await screen.findByRole('region', { name: 'Locks with nothing to hold' });
    expect(within(list).getByText('1 block in Main')).toBeTruthy();
    act(() =>
      within(list).getByRole('button', { name: 'Clear the lock on 1 block in Main' }).click(),
    );
    await waitFor(() => expect(client.setEntryBlockLocks).toHaveBeenCalledWith('e1', [], 3));
  });
});

describe('a locked region on the entry form', () => {
  function renderForm(lock: EntryBlockLock) {
    render(
      <EntryForm
        contentType={pageType}
        initial={pageFields()}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        blockLocks={[lock]}
        directory={{ me: 'me' }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
  }

  it('shows the lock on the card, with no move or remove, and nothing goes in its slots', () => {
    renderForm(sectionLock);
    const card = screen.getByRole('group', { name: 'Section block 2' });
    expect(within(card).getByText('Locked by you · Nov 9, 2026', { exact: false })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^Remove Section/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: /^Move Section/ })).toBeNull();
    expect(
      within(card).getByText(/Items is in a locked region: its blocks stay as they are/),
    ).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^Remove Card/ })).toBeNull();
    // The blocks around it move, but the content inside it still edits.
    expect(screen.getByRole('button', { name: 'Remove Hero block 1' })).toBeTruthy();
    expect((within(card).getByLabelText('Heading') as HTMLInputElement).readOnly).toBe(false);
  });

  it('reads a frozen region’s fields only, inside it too', () => {
    renderForm({ ...sectionLock, freeze: 'all' });
    const card = screen.getByRole('group', { name: 'Section block 2' });
    expect((within(card).getByLabelText('Heading') as HTMLInputElement).readOnly).toBe(true);
    expect((within(card).getByLabelText('Title') as HTMLInputElement).readOnly).toBe(true);
    // Outside it, nothing is frozen.
    const hero = screen.getByRole('group', { name: 'Hero block 1' });
    expect((within(hero).getByLabelText(/^Heading/) as HTMLInputElement).readOnly).toBe(false);
  });
});
