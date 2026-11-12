// @vitest-environment jsdom
// AI projects where AI work is asked for: the project picker (hidden with no projects or with its
// capability off; the default first, then the others, then None), the provenance line a result
// carries from its `project`, and the production signal (accepted, edited by a size bucket, or
// discarded, per project, never with content).
import {
  type AiProject,
  type AiProjectUse,
  type ContentType,
  DEFAULT_AI_SETTINGS,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedDraft } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const NOW = '2026-11-10T12:00:00.000Z';
const project = (over: Partial<AiProject>): AiProject => ({
  id: 'p-brand',
  name: 'Brand voice',
  description: null,
  instructions: null,
  writer: null,
  reader: null,
  references: [],
  isDefault: false,
  version: 1,
  createdAt: NOW,
  createdBy: null,
  updatedAt: NOW,
  updatedBy: null,
  ...over,
});

let projects: AiProject[] = [];
let off: string[] = [];
const client = {
  listAiProjects: vi.fn(async () => projects),
  getAiSettings: vi.fn(async () => ({
    ...DEFAULT_AI_SETTINGS,
    capabilities: Object.fromEntries(
      Object.entries(DEFAULT_AI_SETTINGS.capabilities).map(([c, s]) => [
        c,
        { ...s, enabled: !off.includes(c) },
      ]),
    ),
  })),
  listTags: vi.fn(async () => []),
  summarizeEntry: vi.fn(async () => ({
    summary: 'A tight summary.',
    applied: false,
    project: USE,
  })),
  recordAiProjectOutcome: vi.fn(async () => undefined),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client, conn: { space: 'blog', environment: 'main', locale: 'en-US' } }),
}));

const { ProjectPicker } = await import('~/cms/components/ai/ProjectPicker');
const { ProjectUsed } = await import('~/cms/components/ai/ProjectUsed');
const { GenerateEntryDialog } = await import('~/cms/components/GenerateEntryDialog');
const { AiAssistPanel } = await import('~/cms/components/AiAssistPanel');
const { ToastProvider } = await import('~/cms/lib/toast');
const { outcomeOf, pickerOptions, projectOfOutput, provenanceLine } = await import(
  '~/cms/lib/ai-projects'
);

const USE: AiProjectUse = {
  id: 'p-brand',
  version: 4,
  references: [
    { assetId: 'a1', version: 2, used: true, ranges: [[0, 1200]] },
    { assetId: 'a2', version: 1, used: false, reason: 'forbidden' },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  projects = [];
  off = [];
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('the project picker', () => {
  it('orders the default first, then the others, then None', () => {
    const list = [
      project({ id: 'p-b', name: 'Beta' }),
      project({ id: 'p-brand', name: 'Brand voice', isDefault: true }),
      project({ id: 'p-a', name: 'Alpha' }),
    ];
    expect(pickerOptions(list).map((o) => [o.value, o.label])).toEqual([
      ['default', 'Default (Brand voice)'],
      ['p-b', 'Beta'],
      ['p-a', 'Alpha'],
      ['none', 'None'],
    ]);
    // No default: the default is no project, so None comes first and once.
    expect(pickerOptions(list.filter((p) => !p.isDefault)).map((o) => o.label)).toEqual([
      'None',
      'Beta',
      'Alpha',
    ]);
    // Stored on an action or a schedule: no None, the default at each run first.
    expect(pickerOptions(list, { stored: true }).map((o) => o.label)).toEqual([
      'The default at each run (now Brand voice)',
      'Beta',
      'Brand voice',
      'Alpha',
    ]);
  });

  it('is hidden when the environment has no projects', async () => {
    wrap(<ProjectPicker value="default" onChange={() => {}} capabilities={['drafting']} />);
    await waitFor(() => expect(client.listAiProjects).toHaveBeenCalled());
    expect(screen.queryByLabelText('Project')).toBeNull();
  });

  it('shows the default when there are projects, and hides where the capability is off', async () => {
    projects = [project({ isDefault: true })];
    const view = wrap(
      <ProjectPicker value="default" onChange={() => {}} capabilities={['drafting']} />,
    );
    expect((await screen.findByLabelText('Project')).textContent).toBe('Default (Brand voice)');
    view.unmount();
    off = ['drafting'];
    wrap(<ProjectPicker value="default" onChange={() => {}} capabilities={['drafting']} />);
    await waitFor(() => expect(client.getAiSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('Project')).toBeNull());
  });
});

describe('a picked project that is gone', () => {
  it('goes back to the default in the caller’s state too, so what shows is what is sent', async () => {
    projects = [project({ isDefault: true })];
    const onChange = vi.fn();
    wrap(<ProjectPicker value="p-deleted" onChange={onChange} capabilities={['drafting']} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('default'));
    expect((await screen.findByLabelText('Project')).textContent).toBe('Default (Brand voice)');
  });
});

describe('what a result used', () => {
  it('says the project and what was left out, quietly, and opens to each reference', async () => {
    projects = [project({})];
    expect(provenanceLine(USE, 'Brand voice')).toBe(
      'Used project: Brand voice · 2 references (1 left out: you can’t read it)',
    );
    wrap(<ProjectUsed use={USE} />);
    const line = await screen.findByText(
      'Used project: Brand voice · 2 references (1 left out: you can’t read it)',
    );
    fireEvent.click(line);
    expect(await screen.findByText(/Reference 1: used, 1,200 characters/)).toBeTruthy();
    // One the person can't read is named by its place only.
    expect(screen.getByText('Reference 2: left out, you can’t read it')).toBeTruthy();
  });

  it('says nothing for a call that took no project', () => {
    const view = wrap(<ProjectUsed use={null} />);
    expect(view.container.textContent).toBe('');
  });

  it('reads the project a Coworker call reported, streaming or kept', () => {
    const json = JSON.stringify({ fields: {}, project: USE });
    expect(projectOfOutput(`<user_content>\n${json}\n</user_content>`)?.id).toBe('p-brand');
    expect(
      projectOfOutput({ project: { id: 'p-brand', references: [{ assetId: 'a1', used: true }] } }),
    ).toMatchObject({ id: 'p-brand', references: [{ assetId: 'a1', used: true }] });
    expect(projectOfOutput({ project: null })).toBeNull();
    expect(projectOfOutput('not json')).toBeNull();
  });
});

describe('the production signal', () => {
  it('measures a kept proposal: accepted unchanged, else edited by how much', () => {
    const proposed = { title: { 'en-US': 'A launch post about realtime sync' } };
    expect(outcomeOf(proposed, proposed)).toEqual({ outcome: 'accepted' });
    expect(
      outcomeOf(proposed, { title: { 'en-US': 'A launch post about realtime sync!' } }),
    ).toEqual({ outcome: 'edited', edit: 'small' });
    expect(outcomeOf(proposed, { title: { 'en-US': 'Something else entirely' } })).toEqual({
      outcome: 'edited',
      edit: 'large',
    });
  });

  it('Generate sends the project picked and reports a discarded draft for it', async () => {
    projects = [project({ isDefault: true }), project({ id: 'p-alpha', name: 'Alpha' })];
    const draft: GeneratedDraft = {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
      usage: { inputTokens: 10, outputTokens: 5 },
      project: { ...USE, id: 'p-alpha' },
    };
    const onGenerate = vi.fn(async () => draft);
    const onDiscard = vi.fn();
    wrap(
      <GenerateEntryDialog
        open
        onOpenChange={() => {}}
        contentType={
          {
            apiId: 'article',
            name: 'Article',
            fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
          } as unknown as ContentType
        }
        onGenerate={onGenerate}
        onApply={() => {}}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.click(await screen.findByLabelText('Project'));
    fireEvent.click(await screen.findByRole('option', { name: 'Alpha' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Launch post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    await waitFor(() =>
      expect(onGenerate).toHaveBeenCalledWith(
        'Launch post',
        undefined,
        expect.any(AbortSignal),
        'p-alpha',
      ),
    );
    await screen.findByText(/^Used project: Alpha · 2 references/);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalledWith(draft);
  });

  it('AI assist works in the project picked, names it on the proposal, and reports a dismissal', async () => {
    projects = [project({ isDefault: true })];
    wrap(
      <AiAssistPanel
        entryId="e1"
        contentType={
          {
            apiId: 'article',
            name: 'Article',
            fields: [{ apiId: 'title', name: 'Title', type: 'Text' }],
          } as unknown as ContentType
        }
        locales={['en-US']}
        defaultLocale="en-US"
        onMergeFields={() => 1}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /AI assist/ }));
    await screen.findByLabelText('Project');
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    // The default goes unnamed: the API takes it.
    await waitFor(() =>
      expect(client.summarizeEntry).toHaveBeenCalledWith('e1', {
        targetField: 'title',
        apply: false,
      }),
    );
    await screen.findByText(/^Used project: Brand voice/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(client.recordAiProjectOutcome).toHaveBeenCalledWith('p-brand', {
        capability: 'field-assist',
        outcome: 'discarded',
      }),
    );
  });
});
