// @vitest-environment jsdom
// Per-breakpoint overrides in the admin: the canvas's widths from the catalog's breakpoints, the
// Look tab editing the breakpoint in view (inherit, set, reset, a prop that is the same at every
// width) through `update` ops that undo, the Layers mark, an override the server refused said on
// its block, and the entry form showing a block's overrides read-only and saving them as they are.
import {
  type BlockCatalog,
  type Breakpoint,
  type ContentType,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  type EntryFields,
  effectiveBlockRules,
  type FieldDefinition,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';
import { FRAME_CHANNEL } from '~/cms/lib/live-preview/frame-channel';
import { ApiError, type PreviewEntry } from '~/cms/lib/management';

const f = (
  d: Pick<FieldDefinition, 'apiId' | 'name' | 'type'> & Partial<FieldDefinition>,
): FieldDefinition => ({ localized: false, required: false, position: 0, ...d });

const BREAKPOINTS: Breakpoint[] = [
  { id: 'md', name: 'Tablet', minWidth: 768 },
  { id: 'lg', name: 'Desktop', minWidth: 1280 },
];

/** The page type, its blocks field holding `breakpoints` as a catalog push writes them. */
const typeWith = (breakpoints: readonly Breakpoint[]) =>
  ({
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    status: 'published',
    preview: { urlTemplate: 'https://site.example/{id}' },
    fields: [
      f({ apiId: 'title', name: 'Title', type: 'Symbol' }),
      f({
        apiId: 'body',
        name: 'Main',
        type: 'Array',
        position: 1,
        items: {
          type: 'Component',
          breakpoints,
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              responsive: ['tone', 'hidden'],
              fields: [
                f({ apiId: 'heading', name: 'Heading', type: 'Symbol' }),
                f({
                  apiId: 'tone',
                  name: 'Tone',
                  type: 'Symbol',
                  validations: { in: ['light', 'dark'] },
                }),
                f({
                  apiId: 'align',
                  name: 'Align',
                  type: 'Symbol',
                  validations: { in: ['left', 'center'] },
                }),
                f({ apiId: 'hidden', name: 'Hidden', type: 'Boolean' }),
              ],
            },
            {
              apiId: 'cta',
              name: 'Call to action',
              fields: [f({ apiId: 'label', name: 'Label', type: 'Symbol' })],
            },
          ],
        },
      }),
    ],
  }) as unknown as ContentType;
const pageType = typeWith(BREAKPOINTS);

const catalog = {
  version: 1,
  hash: 'h',
  pushedAt: '2026-11-10T00:00:00Z',
  pushedBy: null,
  changes: { added: [], changed: [], removed: [], renamed: [] },
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  breakpoints: BREAKPOINTS,
  blocks: [
    { id: 'hero', name: 'Hero', responsive: ['tone', 'hidden'], fields: [] },
    { id: 'cta', name: 'Call to action', fields: [] },
  ],
} as unknown as BlockCatalog;

function pageFields(): EntryFields {
  return {
    title: { 'en-US': 'Home' },
    body: {
      'en-US': [
        {
          _type: 'hero',
          _key: 'h1',
          heading: 'Welcome',
          tone: 'light',
          align: 'left',
          _responsive: { md: { tone: 'dark' } },
        },
        { _type: 'cta', _key: 'a1', label: 'Start' },
      ],
    },
  };
}

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
  client.updateEntry.mockReset();
  client.listContentTypes.mockImplementation(async () => [pageType]);
  client.getBlockCatalog.mockImplementation(async () => catalog);
  localStorage.clear();
});

async function canvas(opts: { fields?: EntryFields; first?: string; search?: string } = {}) {
  client.getEntry.mockResolvedValue({
    id: 'e1',
    contentType: 'page',
    status: 'draft',
    version: 3,
    fields: opts.fields ?? pageFields(),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/content/:typeId/:entryId/canvas', element: <EntryCanvas /> }],
    { initialEntries: [`/content/page/e1/canvas${opts.search ?? ''}`] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Home' });
  // The catalog (or the field's own) arrives with the canvas: its breakpoints are the widths.
  await screen.findByRole('radio', { name: opts.first ?? 'Tablet, 768 pixels' });
  const el = screen.getByTitle('Site preview') as HTMLIFrameElement;
  const posted: { type: string; [k: string]: unknown }[] = [];
  vi.spyOn(el.contentWindow as Window, 'postMessage').mockImplementation((m: unknown) => {
    posted.push(m as { type: string });
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
  say({ type: 'session', entries: ['e1'], capabilities: ['select', 'patch.blocks', 'layout'] });
  /** The block ops the page was last sent. */
  const lastOps = () => {
    const sent = posted.filter((m) => m.type === 'entry').at(-1) as
      | { edits: { blocks: { ops: unknown[] }[] } | null }
      | undefined;
    return sent?.edits?.blocks.flatMap((b) => b.ops) ?? [];
  };
  const lastWidth = () =>
    (posted.filter((m) => m.type === 'view').at(-1) as { width?: number }).width;
  return { posted, lastOps, lastWidth };
}

const layer = (key: string) => document.querySelector(`[data-layer="${key}"]`) as HTMLElement;
const width = (name: string) =>
  act(() => screen.getByRole('radio', { name: new RegExp(`^${name}, `) }).click());
async function openLook(key = 'h1') {
  act(() => screen.getByRole('button', { name: 'Layers' }).click());
  act(() => layer(key).click());
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Look' }));
  await screen.findByRole('radiogroup', { name: 'Tone' });
}
const tone = () => screen.getByRole('radiogroup', { name: 'Tone' });
/** What Tone's line under it says: where its value comes from at this width. */
const toneSays = () =>
  (tone().getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;

describe('the canvas’s widths', () => {
  it('are Base and the catalog’s breakpoints, by name, always opening on Base', async () => {
    // A breakpoint kept from before is never restored: a fresh canvas edits the bare props.
    localStorage.setItem('cw.entry-pane.device', 'lg');
    const page = await canvas();
    const radios = within(screen.getByRole('radiogroup', { name: 'Device width' })).getAllByRole(
      'radio',
    );
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Base, 390 pixels',
      'Tablet, 768 pixels',
      'Desktop, 1280 pixels',
    ]);
    expect(radios.map((r) => r.textContent)).toEqual(['Base', 'Tablet', 'Desktop']);
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    expect(page.lastWidth()).toBe(390);
    width('Tablet');
    expect(page.lastWidth()).toBe(768);
    // Chosen for this canvas only: the device remembered for a catalog without breakpoints stays.
    expect(localStorage.getItem('cw.entry-pane.device')).toBe('lg');
  });
});

describe('opening the canvas from the entry form', () => {
  it('opens on the linked block’s Look tab, at the linked width', async () => {
    const page = await canvas({ search: '?block=h1&width=md' });
    const radios = within(screen.getByRole('radiogroup', { name: 'Device width' }));
    expect(
      radios.getByRole('radio', { name: 'Tablet, 768 pixels' }).getAttribute('aria-checked'),
    ).toBe('true');
    await waitFor(() => expect(page.lastWidth()).toBe(768));
    expect(screen.getByRole('heading', { level: 2, name: 'Hero' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Look' }).getAttribute('aria-selected')).toBe('true');
    expect(checked(tone())).toBe('dark');
    expect(toneSays()).toBe('Set for Tablet');
    // Taken once: the canvas's own choice stands after it.
    width('Base');
    expect(page.lastWidth()).toBe(390);
  });

  it('opens as usual on a block or width it no longer has', async () => {
    const page = await canvas({ search: '?block=gone&width=xl' });
    expect(page.lastWidth()).toBe(390);
    expect(screen.queryByRole('heading', { level: 2, name: 'Hero' })).toBeNull();
  });
});

describe('the Look tab at a breakpoint', () => {
  it('shows what a responsive prop inherits and from where, and sets an override there', async () => {
    const page = await canvas();
    await openLook();
    width('Desktop');
    // Desktop inherits Tablet's override.
    expect(screen.getByText(/Editing/).textContent).toContain('Desktop, from 1280px up');
    expect(checked(tone())).toBe('dark');
    expect(toneSays()).toBe('From Tablet');

    act(() => within(tone()).getByRole('radio', { name: 'light' }).click());
    expect(page.lastOps().at(-1)).toEqual({
      op: 'update',
      field: 'body',
      locale: 'en-US',
      key: 'h1',
      set: { _responsive: { md: { tone: 'dark' }, lg: { tone: 'light' } } },
    });
    expect(checked(tone())).toBe('light');
    expect(toneSays()).toBe('Set for Desktop');

    // Reset inherits again: the emptied breakpoint goes.
    act(() => screen.getByRole('button', { name: 'Reset Tone at Desktop' }).click());
    // Reset goes with the override: focus lands on Tone's chosen segment, not the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(tone()).getByRole('radio', { name: 'dark' })),
    );
    expect(page.lastOps().at(-1)).toMatchObject({
      key: 'h1',
      set: { _responsive: { md: { tone: 'dark' } } },
    });
    expect(toneSays()).toBe('From Tablet');

    // At Tablet, its own override; Reset there empties the map, and the key is unset.
    width('Tablet');
    expect(toneSays()).toBe('Set for Tablet');
    act(() => screen.getByRole('button', { name: 'Reset Tone at Tablet' }).click());
    expect(page.lastOps().at(-1)).toMatchObject({ key: 'h1', unset: ['_responsive'] });
    expect(toneSays()).toBe('From Base');
    expect(checked(tone())).toBe('light');
    expect(within(layer('h1')).queryByRole('img', { name: /Has overrides/ })).toBeNull();

    // Undo puts the override back.
    act(() => screen.getByTitle(/^Undo: /).click());
    expect(toneSays()).toBe('Set for Tablet');
    expect(checked(tone())).toBe('dark');
  });

  it('keeps a prop that isn’t responsive the same at every width, editable at Base only', async () => {
    const page = await canvas();
    await openLook();
    width('Desktop');
    const align = screen.getByRole('radiogroup', { name: 'Align' });
    expect(align.getAttribute('data-disabled')).not.toBeNull();
    expect(screen.getByText('Same at every width: change it at Base.')).toBeTruthy();

    width('Base');
    expect(screen.getByText(/Editing/).textContent).toContain('Base');
    const atBase = screen.getByRole('radiogroup', { name: 'Align' });
    expect(atBase.getAttribute('data-disabled')).toBeNull();
    act(() => within(atBase).getByRole('radio', { name: 'center' }).click());
    expect(page.lastOps().at(-1)).toMatchObject({ key: 'h1', set: { align: 'center' } });
    // At Base a responsive prop sets the bare prop, and says where it changes.
    expect(screen.getByText('Changes at Tablet')).toBeTruthy();
    act(() => within(tone()).getByRole('radio', { name: 'dark' }).click());
    expect(page.lastOps().at(-1)).toMatchObject({ key: 'h1', set: { tone: 'dark' } });
  });

  it('puts a responsive Boolean on the Look tab, overridden like a token', async () => {
    const page = await canvas();
    await openLook();
    width('Desktop');
    const hidden = screen.getByLabelText(/^Hidden/);
    fireEvent.click(hidden);
    expect(page.lastOps().at(-1)).toMatchObject({
      key: 'h1',
      set: { _responsive: { md: { tone: 'dark' }, lg: { hidden: true } } },
    });
  });
});

describe('Layers', () => {
  it('marks a block that carries overrides, named for where', async () => {
    await canvas();
    act(() => screen.getByRole('button', { name: 'Layers' }).click());
    expect(within(layer('h1')).getByRole('img', { name: 'Has overrides at Tablet' })).toBeTruthy();
    expect(within(layer('a1')).queryByRole('img', { name: /Has overrides/ })).toBeNull();
  });
});

describe('an undo across several saves', () => {
  it('saves without the overrides a push made stale meanwhile, reading the type again', async () => {
    let version = 3;
    const sent: EntryFields[] = [];
    // As the server: an override at a breakpoint the type (after the push) doesn't declare is
    // refused unless the version before holds it; this one is two saves back.
    let pushed = false;
    client.updateEntry.mockImplementation(async (_id: string, fields: EntryFields) => {
      sent.push(fields);
      if (pushed && JSON.stringify(fields).includes('"lg"')) {
        throw new ApiError(422, 'Validation failed', {
          error: {
            code: 'validation_failed',
            issues: [
              {
                field: 'body[0]._responsive.lg',
                locale: 'en-US',
                key: 'h1',
                code: 'override_undeclared',
                message: 'No breakpoint "lg" (one of: md)',
              },
            ],
          },
        });
      }
      version += 1;
      return {
        entry: { id: 'e1', contentTypeApiId: 'page', status: 'draft', currentVersion: version },
        fields,
      };
    });
    const fields = pageFields();
    const body = fields.body?.['en-US'] as Record<string, unknown>[];
    (body[0] as Record<string, unknown>)._responsive = {
      lg: { tone: 'dark' },
      md: { tone: 'dark' },
    };
    client.getEntry.mockResolvedValue({
      id: 'e1',
      contentType: 'page',
      status: 'draft',
      version: 3,
      fields,
    });
    await canvas({ fields });
    act(() => screen.getByRole('button', { name: 'Layers' }).click());
    // Remove the hero, save; edit the call to action, save.
    act(() => layer('h1').click());
    act(() => screen.getByRole('button', { name: 'Remove Hero' }).click());
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    await screen.findByText('Draft updated');
    act(() => layer('a1').click());
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    await waitFor(() => expect(sent).toHaveLength(2));
    // A push removes lg; the canvas still holds the type it read.
    pushed = true;
    client.listContentTypes.mockResolvedValue([
      typeWith([{ id: 'md', name: 'Tablet', minWidth: 768 }]),
    ]);
    // Undo twice: the label, then the remove, which puts the hero back with its lg override.
    act(() => screen.getByTitle(/^Undo: /).click());
    act(() => screen.getByTitle(/^Undo: /).click());
    await waitFor(() => expect(layer('h1')).toBeTruthy());
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    await waitFor(() => expect(sent).toHaveLength(4));
    expect(screen.queryByText(/no longer takes an override/)).toBeNull();
    const last = sent.at(-1)?.body?.['en-US'] as Record<string, unknown>[];
    expect(last[0]).toMatchObject({ _key: 'h1', _responsive: { md: { tone: 'dark' } } });
    expect(JSON.stringify(last)).not.toContain('"lg"');
  });
});

describe('without the catalog', () => {
  it('takes its widths from the blocks field’s own breakpoints, so Base is always there', async () => {
    client.getBlockCatalog.mockResolvedValue(null as unknown as BlockCatalog);
    await canvas();
    const widths = within(screen.getByRole('radiogroup', { name: 'Device width' })).getAllByRole(
      'radio',
    );
    expect(widths.map((r) => r.textContent)).toEqual(['Base', 'Tablet', 'Desktop']);
    await openLook();
    const align = screen.getByRole('radiogroup', { name: 'Align' });
    expect(align.getAttribute('data-disabled')).toBeNull();
  });

  it('says no width shows Base when the first breakpoint starts at 1px, and still edits it', async () => {
    client.getBlockCatalog.mockResolvedValue(null as unknown as BlockCatalog);
    client.listContentTypes.mockResolvedValue([
      typeWith([{ id: 'sm', name: 'Small', minWidth: 1 }, ...BREAKPOINTS]),
    ]);
    const page = await canvas({ first: 'Small, 1 pixels' });
    expect(page.lastWidth()).toBe(390);
    await openLook();
    expect(screen.getByText(/no width shows it, as Small starts at 1px/)).toBeTruthy();
    act(() =>
      within(screen.getByRole('radiogroup', { name: 'Align' }))
        .getByRole('radio', { name: 'center' })
        .click(),
    );
    expect(page.lastOps().at(-1)).toMatchObject({ key: 'h1', set: { align: 'center' } });
  });
});

describe('a refused override', () => {
  it('is said on the block the server names, and selects it', async () => {
    client.updateEntry.mockRejectedValueOnce(
      new ApiError(422, 'Validation failed', {
        error: {
          code: 'validation_failed',
          message: 'Validation failed',
          issues: [
            {
              field: 'body[0]._responsive.xl',
              locale: 'en-US',
              key: 'h1',
              code: 'override_undeclared',
              message: 'No breakpoint "xl" (one of: md, lg)',
            },
          ],
        },
      }),
    );
    await canvas();
    act(() => screen.getByRole('button', { name: 'Layers' }).click());
    act(() => layer('a1').click());
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
    act(() => screen.getByRole('button', { name: 'Save draft' }).click());
    const check = await screen.findByRole('button', {
      name: 'Hero: No breakpoint "xl" (one of: md, lg). Undo the change to save',
    });
    expect(
      await screen.findByText('The site no longer takes an override in this draft: see the checks'),
    ).toBeTruthy();
    act(() => check.click());
    expect(screen.getByRole('heading', { level: 2, name: 'Hero' })).toBeTruthy();
  });
});

describe('the entry form', () => {
  function form(canvasPath?: string) {
    const onSave = vi.fn();
    render(
      <MemoryRouter>
        <EntryForm
          contentType={pageType}
          initial={pageFields()}
          locales={['en-US']}
          defaultLocale="en-US"
          pickers={{ entries: [], assets: [] }}
          onSave={onSave}
          onCancel={() => {}}
          {...(canvasPath ? { canvasPath } : {})}
        />
      </MemoryRouter>,
    );
    return onSave;
  }

  it('shows a block’s overrides read-only under its props, each width linking to the canvas', () => {
    form('/content/page/e1/canvas');
    const hero = screen.getByRole('group', { name: 'Hero block 1' });
    const shown = hero.querySelector('[data-block-overrides]') as HTMLElement;
    expect(shown.textContent).toContain('Tablet from 768px');
    expect(shown.textContent).toContain('Tone dark');
    // The canvas opens on this block, at the width the override applies from.
    // Named for its block too, after the visible words, so a list of links tells them apart.
    expect(
      within(shown)
        .getByRole('link', { name: 'Edit at Tablet: Hero block 1' })
        .getAttribute('href'),
    ).toBe('/content/page/e1/canvas?block=h1&width=md');
    // Only the widths that hold an override are listed, and linked.
    expect(within(shown).getAllByRole('link')).toHaveLength(1);
    expect(within(shown).queryByRole('radio')).toBeNull();
    // A block without overrides shows none.
    const cta = screen.getByRole('group', { name: 'Call to action block 2' });
    expect(cta.querySelector('[data-block-overrides]')).toBeNull();
  });

  it('keeps `_responsive` through an edit of the block and its save', async () => {
    const onSave = form();
    expect(document.querySelector('[data-block-overrides] a')).toBeNull();
    const hero = screen.getByRole('group', { name: 'Hero block 1' });
    fireEvent.change(within(hero).getByLabelText(/^Heading/), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0].body['en-US'][0]).toMatchObject({
      heading: 'Hello',
      _responsive: { md: { tone: 'dark' } },
    });
  });
});
