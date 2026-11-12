// @vitest-environment jsdom
// Settings → AI projects: the list (the default first, its references, what uses it), the editor
// sheet (parts, the instructions' count, references with every text status the API reports), the
// default's rules (space:admin's to set, read-only for others), a refused delete naming what to
// repoint, and a stale save that keeps the edits and offers to load the latest.
import { type AiReferenceStatus, type Asset, DEFAULT_AI_SETTINGS } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProjectView, ManagementClient } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let current: Record<string, unknown> = {};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client: current,
    conn: { space: 'blog', environment: 'main', locale: 'en-US' },
  }),
}));

const { AiProjects } = await import('~/cms/components/AiProjects');
const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError } = await import('~/cms/lib/management');

afterEach(cleanup);

const NOW = '2026-11-10T12:00:00.000Z';

const asset = (id: string, fileName: string, contentType: string, version = 1): Asset =>
  ({
    id,
    status: 'published',
    file: { fileName, contentType, size: 2048 },
    title: { 'en-US': fileName.replace(/\..*/, '') },
    description: {},
    metadata: {},
    version,
  }) as unknown as Asset;

const ASSETS = [
  asset('a-guide', 'brand-guide.pdf', 'application/pdf'),
  asset('a-sheet', 'spec-sheet.pdf', 'application/pdf', 2),
  asset('a-talk', 'interview.mp3', 'audio/mpeg'),
  asset('a-scan', 'scan.pdf', 'application/pdf'),
  asset('a-big', 'manual.pdf', 'application/pdf'),
  asset('a-new', 'press-kit.pdf', 'application/pdf'),
];

function project(over: Partial<AiProjectView> = {}): AiProjectView {
  return {
    id: 'p-brand',
    name: 'Brand voice',
    description: 'How we sound everywhere',
    instructions: 'Say “spec sheet”, never “datasheet”.',
    writer: { name: 'Northwind team', description: 'Plain and warm.' },
    reader: null,
    references: [],
    isDefault: false,
    version: 3,
    createdAt: NOW,
    createdBy: 'ada@example.com',
    updatedAt: NOW,
    updatedBy: 'ada@example.com',
    ...over,
  };
}

const ref = (assetId: string, over: Partial<AiReferenceStatus> = {}): AiReferenceStatus => ({
  assetId,
  version: 1,
  text: 'ready',
  updateAvailable: false,
  ...over,
});

function fakeClient(
  start: AiProjectView[],
  scopes: string[] = ['space:admin', 'content:manage', 'content:write', 'preview:read'],
  opts: { media?: boolean } = {},
) {
  let stored = start;
  const client = {
    getSpaceAccess: vi.fn(async () => ({
      spaceId: 'blog',
      kind: 'user',
      subject: 'u-me',
      scopes,
    })),
    getTeam: vi.fn(async () => ({
      people: [{ id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com' }],
    })),
    getAiSettings: vi.fn(async () => ({
      ...DEFAULT_AI_SETTINGS,
      capabilities: {
        ...DEFAULT_AI_SETTINGS.capabilities,
        media: { enabled: opts.media ?? true, tier: null, guidance: null },
      },
    })),
    listAiProjects: vi.fn(async () =>
      stored.map((p) => ({
        ...p,
        references: p.references.map((r) => ({ assetId: r.assetId, version: r.version })),
      })),
    ),
    getAiProject: vi.fn(async (id: string) => {
      const p = stored.find((x) => x.id === id);
      if (!p) throw new ApiError(404, 'gone');
      return p;
    }),
    listAIActions: vi.fn(async () => [
      { id: 'act-seo', name: 'SEO title', projectId: 'p-brand', variables: [], tier: 'fast' },
    ]),
    listAgentSchedules: vi.fn(async () => [
      { id: 'sch-1', workflow: 'enrich', cron: '0 3 * * *', enabled: true, projectId: 'p-brand' },
    ]),
    listAssets: vi.fn(async (q: { ids?: string[]; kind?: string }) => ({
      items: q.ids
        ? ASSETS.filter((a) => q.ids?.includes(a.id))
        : ASSETS.filter((a) =>
            q.kind === 'audio'
              ? a.file.contentType.startsWith('audio/')
              : !a.file.contentType.startsWith('audio/'),
          ),
    })),
    searchAssets: vi.fn(async () => ({ items: [], total: 0, facets: {} })),
    createAiProject: vi.fn(async (input: Record<string, unknown>) => {
      const created = project({
        ...(input as Partial<AiProjectView>),
        id: 'p-new',
        version: 1,
        references: ((input.references as { assetId: string }[]) ?? []).map((r) =>
          ref(r.assetId, { text: 'none', reason: 'not_extracted' }),
        ),
      });
      stored = [...stored, created];
      return created;
    }),
    updateAiProject: vi.fn(
      async (id: string, input: Record<string, unknown> & { expectedVersion: number }) => {
        const p = stored.find((x) => x.id === id) as AiProjectView;
        if (input.expectedVersion !== p.version) {
          throw new ApiError(409, 'stale', {
            error: { code: 'conflict', message: 'stale', details: { version: p.version } },
          });
        }
        const next = { ...p, ...(input as Partial<AiProjectView>), version: p.version + 1 };
        next.references = p.references;
        stored = stored.map((x) => (x.id === id ? next : x));
        return { project: next, unchanged: false };
      },
    ),
    deleteAiProject: vi.fn(async (_id: string) => {
      throw new ApiError(409, 'in use', {
        error: {
          code: 'project_in_use',
          message: 'in use',
          aiActions: ['act-seo'],
          agentSchedules: ['sch-1'],
        },
      });
    }),
    setDefaultAiProject: vi.fn(async (projectId: string | null) => {
      stored = stored.map((p) => ({ ...p, isDefault: p.id === projectId }));
      return { projectId, unchanged: false };
    }),
    extractAiProjectReference: vi.fn(async (_id: string, assetId: string) => ({
      assetId,
      version: 1,
      outcome: 'started',
      status: ref(assetId, { text: 'pending' }),
    })),
    /** Someone else saves meanwhile. */
    theirs(id: string) {
      stored = stored.map((p) => (p.id === id ? { ...p, version: p.version + 1 } : p));
    },
  };
  current = client;
  return client;
}

const renderPage = (client: ReturnType<typeof fakeClient>) => {
  const router = createMemoryRouter(
    [
      {
        path: '/settings/ai-projects',
        element: <AiProjects client={client as unknown as ManagementClient} />,
      },
    ],
    { initialEntries: ['/settings/ai-projects'] },
  );
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
};

const rowNamed = async (name: string) =>
  (await screen.findByRole('button', { name: new RegExp(`^(Edit|View) ${name}$`) })).closest(
    'li',
  ) as HTMLElement;

describe('Settings → AI projects: the list', () => {
  it('lists the default first, with its references, what uses it and who changed it', async () => {
    renderPage(
      fakeClient([
        project({ id: 'p-alpha', name: 'Alpha campaign', references: [ref('a-guide')] }),
        project({ isDefault: true, references: [ref('a-guide'), ref('a-sheet')] }),
      ]),
    );
    const rows = await screen.findAllByRole('button', { name: /^Edit / });
    expect(rows.map((r) => r.textContent)).toEqual(['Brand voice', 'Alpha campaign']);
    const brand = await rowNamed('Brand voice');
    expect(within(brand).getByText('Default')).toBeTruthy();
    expect(within(brand).getByText('2 references')).toBeTruthy();
    await within(brand).findByText(/Used by 1 AI action and 1 agent schedule/);
    expect(within(brand).getByText(/Updated by ada@example.com/)).toBeTruthy();
    expect(within(await rowNamed('Alpha campaign')).getByText('1 reference')).toBeTruthy();
  });

  it('names who changed a project from the team, never by a raw id', async () => {
    renderPage(fakeClient([project({ updatedBy: 'u-ada' })]));
    await within(await rowNamed('Brand voice')).findByText(/Updated by Ada Lovelace/);
  });

  it('says there are none yet, and offers New project to content:manage', async () => {
    renderPage(fakeClient([]));
    await screen.findByText(/No AI projects yet/);
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
  });

  it('reads only without content:manage, and offers no Set as default without space:admin', async () => {
    renderPage(fakeClient([project()], ['content:write']));
    await screen.findByText(/Changing AI projects takes the content:manage scope/);
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Set as default:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
    expect(screen.getByRole('button', { name: 'View Brand voice' })).toBeTruthy();
  });

  it('sets the default for space:admin, confirming first, held to the version read', async () => {
    const client = fakeClient([project()]);
    renderPage(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Set as default: Brand voice' }));
    expect(screen.getByText('Make “Brand voice” the default project?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }));
    await waitFor(() => expect(client.setDefaultAiProject).toHaveBeenCalledWith('p-brand', 3));
    await within(await rowNamed('Brand voice')).findByText('Default');
  });

  it('gives content:manage no edits on the default, and says why in its sheet', async () => {
    renderPage(fakeClient([project({ isDefault: true })], ['content:manage', 'content:write']));
    expect(screen.queryByRole('button', { name: 'Delete Brand voice' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'View Brand voice' }));
    await screen.findByText(/only a space administrator \(space:admin\) can change it/);
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('names what to repoint when a delete is refused as in use', async () => {
    const client = fakeClient([project()]);
    renderPage(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Brand voice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    const alert = await screen.findByText('“Brand voice” is still in use');
    const box = alert.closest('[role="alert"]') as HTMLElement;
    expect(within(box).getByText(/AI action “SEO title”/)).toBeTruthy();
    expect(within(box).getByText(/Agent schedule enrich/)).toBeTruthy();
    expect(within(box).getByText('0 3 * * *')).toBeTruthy();
    expect(within(box).getByRole('link', { name: 'Open AI actions' })).toBeTruthy();
    expect(client.deleteAiProject).toHaveBeenCalledWith('p-brand', 3);
  });
});

describe('Settings → AI projects: the editor', () => {
  it('creates a project from its parts, counting the instructions as the API does', async () => {
    const client = fakeClient([]);
    renderPage(client);
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Northwind' } });
    const instructions = screen.getByLabelText('Instructions');
    fireEvent.change(instructions, { target: { value: 'Use metric units.' } });
    expect(screen.getByText('17 of 4,000 characters')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reader name'), {
      target: { value: 'Procurement lead' },
    });
    fireEvent.change(screen.getByLabelText('Reader description'), {
      target: { value: 'Busy; wants numbers.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(client.createAiProject).toHaveBeenCalledTimes(1));
    expect(client.createAiProject).toHaveBeenCalledWith({
      name: 'Northwind',
      description: null,
      instructions: 'Use metric units.',
      writer: null,
      reader: { name: 'Procurement lead', description: 'Busy; wants numbers.' },
      references: [],
    });
    await screen.findByText('Created “Northwind”');
  });

  it('holds Save while the instructions are over 4,000 characters', async () => {
    renderPage(fakeClient([project()]));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brand voice' }));
    const box = await screen.findByLabelText('Instructions');
    fireEvent.change(box, { target: { value: 'x'.repeat(4001) } });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/4,001 of 4,000 characters: shorten it to save/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows every reference status the API reports, with Retry and Use the new file', async () => {
    const client = fakeClient([
      project({
        references: [
          ref('a-guide', { textBytes: 12_288 }),
          ref('a-sheet', { updateAvailable: true }),
          ref('a-talk', { text: 'pending' }),
          // The API says Retry would be taken; the screen offers it from that alone.
          ref('a-scan', { text: 'none', reason: 'failed', retryable: true }),
          ref('a-big', { text: 'none', reason: 'too_large' }),
          ref('a-new', { text: 'none', reason: 'not_extracted' }),
        ],
      }),
    ]);
    renderPage(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brand voice' }));
    const list = await screen.findByRole('list', { name: 'References' });
    const item = (name: string) =>
      within(list)
        .getByText(new RegExp(`\\d\\. ${name}$`))
        .closest('li') as HTMLElement;
    await within(list).findByText('1. brand-guide');
    expect(within(item('brand-guide')).getByText('Ready')).toBeTruthy();
    expect(within(item('brand-guide')).getByText('12 KB of text')).toBeTruthy();
    expect(within(item('interview')).getByText('Being read')).toBeTruthy();
    expect(within(item('scan')).getByText('Reading its text failed.')).toBeTruthy();
    expect(within(item('manual')).getByText('The file is too large to read.')).toBeTruthy();
    // Final: no Retry for too large; nothing has asked yet: read the first time it's used.
    expect(within(item('manual')).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(
      within(item('press-kit')).getByText(/read by a model the first time the project is used/),
    ).toBeTruthy();
    expect(within(item('spec-sheet')).getByText('Update available')).toBeTruthy();

    fireEvent.click(within(item('scan')).getByRole('button', { name: 'Retry reading scan' }));
    await waitFor(() =>
      expect(client.extractAiProjectReference).toHaveBeenCalledWith('p-brand', 'a-scan'),
    );
    await within(item('scan')).findByText('Being read');

    // Moving the pin is an edit of the project, saved with it.
    fireEvent.click(
      within(item('spec-sheet')).getByRole('button', { name: 'Use the new file for spec-sheet' }),
    );
    expect(
      within(item('spec-sheet')).getByText('Moves to file version 2 when you save'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.updateAiProject).toHaveBeenCalledTimes(1));
    expect(client.updateAiProject.mock.calls[0]?.[1]?.references).toContainEqual({
      assetId: 'a-sheet',
      version: 2,
    });
  });

  it('offers no Retry for media_off while Media is off, and says where to turn it on', async () => {
    renderPage(
      fakeClient(
        [project({ references: [ref('a-scan', { text: 'none', reason: 'media_off' })] })],
        undefined,
        {
          media: false,
        },
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brand voice' }));
    await screen.findByText(/Turn Media on in Settings → AI/);
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(screen.getByText(/but Media is off in Settings → AI/)).toBeTruthy();
  });

  it('adds a document from the library, saying a model will read it', async () => {
    const client = fakeClient([project()]);
    renderPage(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brand voice' }));
    const picker = await screen.findByRole('combobox', { name: 'Add a reference' });
    expect(
      screen.getByText(/will be read by a model the first time the project is used/),
    ).toBeTruthy();
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: 'press-kit' }));
    const list = await screen.findByRole('list', { name: 'References' });
    await within(list).findByText('1. press-kit');
    expect(within(list).getByText(/Not saved yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.updateAiProject).toHaveBeenCalledTimes(1));
    expect(client.updateAiProject.mock.calls[0]?.[1]).toMatchObject({
      expectedVersion: 3,
      references: [{ assetId: 'a-new' }],
    });
  });

  it('keeps the edits on a stale save, and Load the latest brings theirs in', async () => {
    const client = fakeClient([project()]);
    renderPage(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brand voice' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Brand voice 2' } });
    client.theirs('p-brand');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('This project changed since you opened it');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Load the latest' })),
    );
    expect(screen.getByText(/saved it as v4, so your changes weren’t saved/)).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Brand voice 2');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Copy my version as JSON/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load the latest' }));
    await waitFor(() =>
      expect(screen.queryByText('This project changed since you opened it')).toBeNull(),
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Brand voice');
  });

  it('opens another project on its own loading state, never the last one’s form', async () => {
    const client = fakeClient([project(), project({ id: 'p-alpha', name: 'Alpha campaign' })]);
    renderPage(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brand voice' }));
    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('Brand voice');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
    // Alpha's read never answers: the sheet waits for it, showing nothing of Brand voice.
    client.getAiProject.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha campaign' }));
    await screen.findByText('Loading the project…');
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('asks before discarding unsaved edits', async () => {
    renderPage(fakeClient([project()]));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brand voice' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Discard your changes to it?')).toBeTruthy();
  });
});
