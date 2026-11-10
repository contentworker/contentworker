// @vitest-environment jsdom
// Build → Blocks' rules as code: the Rules card's view switch (Rules, Code, Narrowed from code), the
// config in force as the JSON a save sends, the draft shown and marked unsaved while there are
// edits (and sent exactly as shown), Copy and what it says, and the diff that lists only what the
// admin narrowed unless Show all is on. CodeMirror itself is mocked: jsdom can't lay it out, and the
// views only hand it text (the e2e specs drive the real editor).
import {
  type BlockCatalog,
  type BlockConfig,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The editor is a lazily fetched chunk: the first code view to open waits on it, and on a busy CI
 * runner that outlasts testing-library's default second. Wait on the editor, with room. */
configure({ asyncUtilTimeout: 5000 });

vi.mock('~/cms/components/block-config/codemirror', () => ({
  JsonCode: (p: { value: string; label: string; describedBy?: string }) => (
    <textarea readOnly aria-label={p.label} aria-describedby={p.describedBy} value={p.value} />
  ),
  JsonDiff: (p: { code: string; inForce: string; unifiedLabel: string }) => (
    <fieldset aria-label={p.unifiedLabel}>
      <pre data-side="code">{p.code}</pre>
      <pre data-side="in-force">{p.inForce}</pre>
    </fieldset>
  ),
}));

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
  getSpaceAccess: vi.fn(async () => ({
    subject: 'me',
    scopes: ['content:manage', 'content:write', 'preview:read'],
  })),
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

const writeText = vi.fn(async (_: string) => {});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  config = EMPTY_BLOCK_CONFIG;
  rules = effectiveBlockRules(CATALOG, config);
});

function inForce(next: BlockConfig) {
  config = next;
  rules = effectiveBlockRules(CATALOG, next);
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/blocks', element: <Blocks /> }], {
    initialEntries: ['/blocks'],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The view switch, once the rules are in (while they load it is drawn, but held). */
const views = async () => {
  await waitFor(() =>
    expect(
      screen.getByRole('radiogroup', { name: 'Show the rules as' }).hasAttribute('data-disabled'),
    ).toBe(false),
  );
  return screen.getByRole('radiogroup', { name: 'Show the rules as' });
};
const show = async (name: string) => {
  fireEvent.click(within(await views()).getByRole('radio', { name }));
};
const json = () =>
  screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Block config as JSON' });

describe('the rules as code', () => {
  it('opens on the rows, and switches between the three views', async () => {
    inForce(SET);
    setup();
    const group = await views();
    expect(within(group).getByRole('radio', { name: 'Rules' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByText('1 of 2 places narrowed')).toBeTruthy();
    await show('Code');
    expect(await json()).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Rules by place' })).toBeNull();
    // The version and who set it stay in the card's header.
    expect(screen.getByText('v2')).toBeTruthy();
    await show('Narrowed from code');
    expect(await screen.findByRole('list', { name: 'Places narrowed from code' })).toBeTruthy();
    await show('Rules');
    expect(await screen.findByRole('list', { name: 'Rules by place' })).toBeTruthy();
  });

  it('shows the config in force as the PUT body, in force and not marked unsaved', async () => {
    inForce(SET);
    setup();
    await show('Code');
    const code = await json();
    expect(JSON.parse(code.value)).toEqual({
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'] }],
      blocks: [],
    });
    const about = document.getElementById(code.getAttribute('aria-describedby') ?? '');
    expect(about?.textContent).toMatch(/^The rules in force, as PUT …\/block-config takes them\./);
    expect(screen.queryByText('Unsaved')).toBeNull();
  });

  it('shows the draft while there are edits, marked unsaved, and Save sends exactly that', async () => {
    setup();
    fireEvent.click(await screen.findByRole('switch', { name: 'Lock Grid › Items' }));
    await show('Code');
    const code = await json();
    const body = JSON.parse(code.value);
    expect(body).toEqual({
      targets: [],
      blocks: [{ block: 'grid', slots: { items: { locked: true } } }],
    });
    expect(screen.getByText('Unsaved')).toBeTruthy();
    const about = document.getElementById(code.getAttribute('aria-describedby') ?? '');
    expect(about?.textContent).toMatch(/^What Save rules would send.*expectedVersion 0\./);
    expect(screen.getByText('1 of 2 places narrowed (unsaved)')).toBeTruthy();

    const next: BlockConfig = { ...EMPTY_BLOCK_CONFIG, version: 1, ...body };
    client.setBlockConfig.mockImplementation(async () => {
      inForce(next);
      return { config: next, unchanged: false };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() =>
      expect(client.setBlockConfig).toHaveBeenCalledWith({ expectedVersion: 0, ...body }),
    );
    // Saved: the same JSON, now the rules in force.
    await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull());
    expect(JSON.parse((await json()).value)).toEqual(body);
  });

  it('copies the JSON and says so', async () => {
    inForce(SET);
    setup();
    await show('Code');
    const code = await json();
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code.value));
    const said = await screen.findByText('Copied');
    expect(said.getAttribute('aria-live')).toBe('polite');
  });

  it('diffs only the places narrowed, unless Show all is on', async () => {
    inForce(SET);
    setup();
    await show('Narrowed from code');
    const list = await screen.findByRole('list', { name: 'Places narrowed from code' });
    expect(within(list).getByRole('heading', { name: 'Page › Main' })).toBeTruthy();
    expect(within(list).queryByRole('heading', { name: 'Grid › Items' })).toBeNull();
    expect(within(list).getByText(/Narrowed: the blocks it takes/)).toBeTruthy();
    const diff = await within(list).findByRole('group', {
      name: 'The rule in force for Page › Main, with the code’s lines it replaces, as JSON',
    });
    const side = (s: string) =>
      JSON.parse(diff.querySelector(`[data-side="${s}"]`)?.textContent ?? '');
    expect(side('code')).toEqual({ blocks: ['banner', 'grid'], locked: false });
    expect(side('in-force')).toEqual({ blocks: ['grid'], locked: false });

    fireEvent.click(screen.getByRole('switch', { name: 'Show all' }));
    const every = await screen.findByRole('list', { name: 'Every place, code against in force' });
    expect(within(every).getByRole('heading', { name: 'Grid › Items' })).toBeTruthy();
    expect(within(every).getByText(/As the code allows/)).toBeTruthy();
  });

  it('says when nothing is narrowed, and lists the ignored parts of a stale config', async () => {
    setup();
    await show('Narrowed from code');
    expect(
      await screen.findByText(
        'Nothing is narrowed: everywhere, editors may place what the code allows.',
      ),
    ).toBeTruthy();
    cleanup();
    inForce({
      ...SET,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid', 'gone'] }],
      blocks: [{ block: 'old', slots: { items: { locked: true } } }],
    });
    setup();
    await show('Narrowed from code');
    const list = await screen.findByRole('list', { name: 'Places narrowed from code' });
    expect(
      within(list).getByText(/Ignored: The catalog no longer allows "gone" here/),
    ).toBeTruthy();
    expect(screen.getByText(/1 part the catalog no longer has a place for/)).toBeTruthy();
    await show('Code');
    expect(
      await screen.findByText(/The ignored parts aren’t in it: saving removes them\./),
    ).toBeTruthy();
  });

  it('goes back to the rows when a save is refused, so the refused controls show', async () => {
    setup();
    fireEvent.click(await screen.findByRole('switch', { name: 'Lock Grid › Items' }));
    await show('Code');
    const { ApiError } = await import('~/cms/lib/management');
    client.setBlockConfig.mockRejectedValue(
      new ApiError(422, 'Validation failed', {
        error: {
          code: 'validation_failed',
          message: 'Validation failed',
          issues: [{ field: 'blocks[grid].slots.items.max', message: 'cannot be above 4' }],
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByRole('group', { name: 'Rules for Grid › Items' })).toBeTruthy();
  });
});
