// @vitest-environment jsdom
// Build → Blocks' rules: each place with the code's rule beside the one in force, controls that
// can only narrow it, a save held to the version it was edited from (and what a 409 or a 422 does),
// the ignored parts of a stale config and how they go, and the read-only view without
// content:manage.
import {
  type BlockCatalog,
  type BlockConfig,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '~/cms/lib/management';

/** As in asset-library.test.tsx: a CI runner's first render can outlast the default second. */
configure({ asyncUtilTimeout: 5000 });

const CATALOG = {
  version: 4,
  hash: 'abc',
  pushedAt: '2026-11-07T10:00:00.000Z',
  pushedBy: 'dev@example.com',
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  changes: { added: [], changed: [], removed: [], renamed: [] },
  blocks: [
    { id: 'banner', name: 'Banner', fields: [] },
    {
      id: 'grid',
      name: 'Grid',
      fields: [],
      slots: [
        { apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'], min: 1, max: 6 },
      ],
    },
    { id: 'card', name: 'Card', allowedParents: ['grid'], fields: [] },
    { id: 'quote', name: 'Quote', allowedParents: ['grid'], fields: [] },
  ],
} as unknown as BlockCatalog;

const SET: BlockConfig = {
  version: 2,
  targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'] }],
  blocks: [],
  updatedAt: '2026-11-08T09:00:00.000Z',
  updatedBy: 'dev@example.com',
};

let config: BlockConfig = EMPTY_BLOCK_CONFIG;
let rules: EffectiveBlockRules = effectiveBlockRules(CATALOG, config);
let scopes = ['content:manage', 'content:write', 'preview:read'];

const client = {
  getBlockCatalog: vi.fn(async () => CATALOG),
  getBlockUsage: vi.fn(async () => ({ version: 4, scanned: 0, complete: true, blocks: [] })),
  listContentTypes: vi.fn(async () => [
    { apiId: 'page', name: 'Page', fields: [{ apiId: 'body', name: 'Main', type: 'Array' }] },
  ]),
  getTeam: vi.fn(async () => ({
    people: [{ id: 'dev@example.com', name: 'Dev Person', email: 'dev@example.com' }],
  })),
  getBlockConfig: vi.fn(async () => config),
  getEffectiveBlockRules: vi.fn(async () => rules),
  getSpaceAccess: vi.fn(async () => ({ subject: 'me', scopes })),
  setBlockConfig: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
}));

const { Blocks } = await import('~/cms/routes/Blocks');
const { ToastProvider } = await import('~/cms/lib/toast');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  config = EMPTY_BLOCK_CONFIG;
  rules = effectiveBlockRules(CATALOG, config);
  scopes = ['content:manage', 'content:write', 'preview:read'];
});

/** The config in force, as the api would answer for it. */
function inForce(next: BlockConfig) {
  config = next;
  rules = effectiveBlockRules(CATALOG, next);
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/blocks', element: <Blocks /> },
      { path: '/content', element: <p>Content</p> },
    ],
    { initialEntries: ['/blocks'] },
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

const rules$ = () => screen.getByRole('list', { name: 'Rules by place' });
const rowOf = async (name: string) => {
  await screen.findByRole('list', { name: 'Rules by place' });
  const row = within(rules$()).getByText(name).closest('li');
  if (!row) throw new Error(`no row for ${name}`);
  return within(row);
};
const open = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name: `Edit the rules for ${name}` }));
  return within(screen.getByRole('group', { name: `Rules for ${name}` }));
};
const saveButton = () => screen.getByRole('button', { name: 'Save rules' }) as HTMLButtonElement;

describe('the rules', () => {
  it('shows each place’s code rule beside the one in force, with the version and who set it', async () => {
    inForce(SET);
    setup();
    const top = await rowOf('Page › Main');
    expect(top.getByText('Code allows Banner, Grid · any number')).toBeTruthy();
    expect(top.getByText('Editors may place Grid · any number')).toBeTruthy();
    const items = await rowOf('Grid › Items');
    expect(items.getByText('Code allows Card, Quote · 1–6')).toBeTruthy();
    expect(items.getByText('Editors may place what the code allows')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(await screen.findByText(/by Dev Person/, { selector: 'span' })).toBeTruthy();
  });

  it('only narrows: the code’s blocks to choose from, at least one, bounds within the code’s', async () => {
    setup();
    const panel = await open('Grid › Items');
    const boxes = panel.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(panel.getByLabelText('Card')).toBeTruthy();
    expect(panel.getByLabelText('Quote')).toBeTruthy();
    expect(panel.queryByLabelText('Banner')).toBeNull();
    fireEvent.click(panel.getByLabelText('Quote'));
    // The last block can't be taken away: a place that takes nothing isn't a narrowing.
    const card = panel.getByLabelText('Card');
    expect(card.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(card);
    expect(card.getAttribute('aria-checked')).toBe('true');
    expect(panel.getByText('A place takes at least one block.')).toBeTruthy();

    const most = panel.getByLabelText('Most');
    expect(most.getAttribute('max')).toBe('6');
    fireEvent.change(most, { target: { value: '7' } });
    expect(panel.getByText('At most 6: the code’s limit.')).toBeTruthy();
    expect(most.getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Fewest'), { target: { value: '0' } });
    expect(panel.getByText('At least 1: the code’s limit.')).toBeTruthy();
    fireEvent.change(panel.getByLabelText('Fewest'), { target: { value: '' } });
    fireEvent.change(most, { target: { value: '3' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('saves the narrowing and the lock with the version it was edited from', async () => {
    setup();
    const panel = await open('Grid › Items');
    fireEvent.click(panel.getByLabelText('Quote'));
    fireEvent.change(panel.getByLabelText('Most'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Lock Grid › Items' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    const next: BlockConfig = {
      version: 1,
      targets: [],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3, locked: true } } },
      ],
      updatedAt: '2026-11-08T10:00:00.000Z',
      updatedBy: 'me',
    };
    client.setBlockConfig.mockImplementation(async () => {
      inForce(next);
      return { config: next, unchanged: false };
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(client.setBlockConfig).toHaveBeenCalled());
    expect(client.setBlockConfig).toHaveBeenCalledWith({
      expectedVersion: 0,
      targets: [],
      blocks: [
        { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3, locked: true } } },
      ],
    });
    // Read again, and shown as it now is.
    const items = await rowOf('Grid › Items');
    expect(await items.findByText('Editors may place Card · 1–3 · locked')).toBeTruthy();
    expect(await screen.findByText('Rules saved as v1')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('reads the rules again when someone else saved first, and says so', async () => {
    setup();
    fireEvent.click(await screen.findByRole('switch', { name: 'Lock Page › Main' }));
    client.setBlockConfig.mockImplementation(async () => {
      inForce(SET);
      throw new ApiError(409, 'The block config is at version 2, not 0', {
        error: { code: 'conflict', message: '…', details: { version: 2 } },
      });
    });
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Someone else changed the rules')).toBeTruthy();
    expect(screen.getByText(/They saved v2 first/)).toBeTruthy();
    // Theirs now, the lock that wasn't saved gone: made again over theirs.
    const top = await rowOf('Page › Main');
    expect(await top.findByText('Editors may place Grid · any number')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Lock Page › Main' }).getAttribute('aria-checked'),
      ).toBe('false'),
    );
    expect(saveButton().disabled).toBe(true);
  });

  it('shows a refusal’s issues against the controls they name', async () => {
    setup();
    const panel = await open('Grid › Items');
    fireEvent.change(panel.getByLabelText('Most'), { target: { value: '5' } });
    client.setBlockConfig.mockRejectedValue(
      new ApiError(422, 'Validation failed', {
        error: {
          code: 'validation_failed',
          message: 'Validation failed',
          issues: [
            {
              field: 'blocks[grid].slots.items.max',
              message: "cannot be above the code's max of 4",
            },
          ],
        },
      }),
    );
    fireEvent.click(saveButton());
    expect(await panel.findByText('At most 4: the code’s limit.')).toBeTruthy();
    expect(panel.getByLabelText('Most').getAttribute('aria-invalid')).toBe('true');
    // The next edit clears it.
    fireEvent.change(panel.getByLabelText('Most'), { target: { value: '4' } });
    expect(panel.queryByText('At most 4: the code’s limit.')).toBeNull();
  });

  it('lists the parts a newer catalog ignores, and a save removes them', async () => {
    inForce({
      ...SET,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid', 'gone'] }],
      blocks: [{ block: 'old', slots: { items: { locked: true } } }],
    });
    setup();
    expect(await screen.findByText('2 parts of the rules are ignored')).toBeTruthy();
    expect(screen.getByText('blocks[old]')).toBeTruthy();
    expect(screen.getByText('targets[page.body].blocks')).toBeTruthy();
    client.setBlockConfig.mockResolvedValue({ config: SET, unchanged: false });
    fireEvent.click(screen.getByRole('button', { name: 'Remove ignored parts' }));
    await waitFor(() =>
      expect(client.setBlockConfig).toHaveBeenCalledWith({
        expectedVersion: 2,
        targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'] }],
        blocks: [],
      }),
    );
  });

  it('asks before leaving with unsaved rules, and stays when asked to', async () => {
    const router = setup();
    fireEvent.click(await screen.findByRole('switch', { name: 'Lock Page › Main' }));
    await act(() => router.navigate('/content'));
    expect(
      screen.getByText('The rules have unsaved changes. Leave without saving them?'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(router.state.location.pathname).toBe('/blocks');
    expect(
      screen.getByRole('switch', { name: 'Lock Page › Main' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('reads only without content:manage', async () => {
    inForce({
      ...SET,
      blocks: [{ block: 'grid', slots: { items: { locked: true } } }],
    });
    scopes = ['content:write', 'preview:read'];
    setup();
    expect(await screen.findByText('Changing the rules takes content:manage.')).toBeTruthy();
    const items = await rowOf('Grid › Items');
    expect(items.getByText('Editors may place Card, Quote · 1–6 · locked')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit the rules/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save rules' })).toBeNull();
  });
});
