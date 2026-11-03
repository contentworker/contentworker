// @vitest-environment jsdom
// The assistant panel with its agent stood in for: a page's edits sent as one `act` each (a line at
// once, or a card the page waits on), cards answered through `resolve`, the page making the edit
// itself while the socket is down; and the parts a card and an edit line are drawn with.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const conn = { space: 'sp_1', environment: 'main', locale: 'en-US' };
vi.mock('~/cms/lib/client-context', () => ({ useClient: () => ({ conn }) }));
vi.mock('~/lib/use-me', () => ({ useMe: () => ({ kind: 'user', id: 'usr_1', role: 'admin' }) }));

type Handlers = {
  onOpen?: () => void;
  onClose?: (e?: { code: number }) => void;
  name?: string;
  agent?: string;
};
const socket = vi.hoisted(() => ({
  options: {} as Handlers,
  call: vi.fn<(method: string, args?: unknown[]) => Promise<unknown>>(),
  close: vi.fn(),
}));
vi.mock('agents/react', () => ({
  useAgent: (options: Handlers) => {
    socket.options = options;
    return socket;
  },
}));

const chat = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  addToolApprovalResponse: vi.fn(),
}));
vi.mock('@cloudflare/ai-chat/react', () => ({
  useAgentChat: () => ({
    messages: chat.messages,
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    status: 'ready',
    stop: vi.fn(),
    error: undefined,
    clearError: vi.fn(),
    addToolApprovalResponse: chat.addToolApprovalResponse,
    clearHistory: vi.fn(),
    isStreaming: false,
    isRecovering: false,
  }),
}));

const { AssistantProvider, useAssistantEdit } = await import('~/cms/lib/assistant');
const { AssistantPanel } = await import('~/cms/components/assistant/panel');
const { ActionCard, EditLine, entryHref } = await import('~/cms/components/assistant/parts');

type Edit = ReturnType<typeof useAssistantEdit>;
let edit!: Edit;
function Page() {
  edit = useAssistantEdit();
  return null;
}

const tree = () => (
  <MemoryRouter>
    <AssistantProvider>
      <Page />
      <AssistantPanel />
    </AssistantProvider>
  </MemoryRouter>
);
/** Renders the panel; `sync()` re-renders it with the conversation as `chat.messages` now holds. */
const renderPanel = () => {
  const view = render(tree());
  return { sync: () => view.rerender(tree()) };
};

const card = (over: Record<string, unknown> = {}) =>
  ({
    type: 'tool-entries_publish',
    toolCallId: 'direct_1',
    state: 'approval-requested',
    input: { id: 'e1', space: 'sp_1', environment: 'main' },
    approval: { id: 'direct_1' },
    toolMetadata: { direct: true, about: 'Spring launch notes' },
    ...over,
  }) as never;

beforeEach(() => {
  chat.messages = [];
  socket.call.mockReset();
  chat.addToolApprovalResponse.mockReset();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('a page’s edits through the panel', () => {
  it('connects to the person’s own agent', () => {
    renderPanel();
    expect(socket.options).toMatchObject({ agent: 'assistant-agent', name: 'usr_1' });
  });

  it('sends an instant edit as one act, with the scope and page, and hands the page its output', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    const view = { entry: { id: 'e1', contentTypeApiId: 'article' }, fields: {} };
    socket.call.mockResolvedValueOnce({ callId: 'direct_9', output: view });
    let saved!: Promise<unknown>;
    act(() => {
      saved = edit('entries_update', { id: 'e1', fields: {} }, 'Spring launch notes');
    });
    await expect(saved).resolves.toEqual({ output: view });
    expect(socket.call).toHaveBeenCalledExactlyOnceWith('act', [
      'entries_update',
      { space: 'sp_1', environment: 'main', id: 'e1', fields: {} },
      {
        scope: { spaceId: 'sp_1', environmentId: 'main', locale: 'en-US' },
        page: { kind: 'everything' },
      },
      'Spring launch notes',
    ]);
    // An instant edit leaves the panel as it was.
    expect(screen.getByRole('complementary', { name: 'Coworker' }).hasAttribute('inert')).toBe(
      true,
    );
  });

  it('opens at an action’s card, and the page waits until it is confirmed', async () => {
    const { sync } = renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockResolvedValueOnce({ callId: 'direct_1', waiting: true });
    let publishing!: Promise<unknown>;
    act(() => {
      publishing = edit('entries_publish', { id: 'e1' }, 'Spring launch notes');
    });
    const panel = screen.getByRole('complementary', { name: 'Coworker' });
    await waitFor(() => expect(panel.hasAttribute('inert')).toBe(false));

    let settled = false;
    void publishing.then(() => {
      settled = true;
    });
    // The card the agent wrote into the conversation arrives with the next sync.
    chat.messages = [{ id: 'm1', role: 'assistant', parts: [card()] }];
    sync();
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    expect(within(panel).getByRole('heading', { name: 'Publish this entry' })).toBeTruthy();
    expect(within(panel).getByText('Spring launch notes')).toBeTruthy();
    // The card a page asked for takes focus on its safe choice.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' }));
    expect(settled).toBe(false);

    const agg = { id: 'e1', contentTypeApiId: 'article', publishedVersion: 4 };
    socket.call.mockResolvedValueOnce({ output: agg });
    fireEvent.click(confirm);
    await expect(publishing).resolves.toEqual({ output: agg });
    expect(socket.call).toHaveBeenLastCalledWith('resolve', ['direct_1', true]);
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it('leaves everything as it was when the card is declined', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockResolvedValueOnce({ callId: 'direct_1', waiting: true });
    chat.messages = [{ id: 'm1', role: 'assistant', parts: [card()] }];
    let trashing!: Promise<unknown>;
    act(() => {
      trashing = edit('entries_publish', { id: 'e1' }, 'Spring launch notes');
    });
    socket.call.mockResolvedValueOnce({ done: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await expect(trashing).resolves.toEqual({ declined: true });
    expect(socket.call).toHaveBeenLastCalledWith('resolve', ['direct_1', false]);
  });

  it('settles the waiting page when its card was answered somewhere else', async () => {
    const { sync } = renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockResolvedValueOnce({ callId: 'direct_1', waiting: true });
    let publishing!: Promise<unknown>;
    act(() => {
      publishing = edit('entries_publish', { id: 'e1' });
    });
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Coworker' }).hasAttribute('inert')).toBe(
        false,
      ),
    );
    // Confirmed on the phone: the conversation syncs the card's outcome.
    const output = { id: 'e1', contentTypeApiId: 'article' };
    chat.messages = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          card({ state: 'output-available', output, approval: { id: 'direct_1', approved: true } }),
        ],
      },
    ];
    sync();
    await expect(publishing).resolves.toEqual({ output });
  });

  it('answers a card the model proposed through the AI SDK, not resolve', async () => {
    chat.messages = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [card({ toolCallId: 'call_7', approval: { id: 'ap_7' }, toolMetadata: undefined })],
      },
    ];
    renderPanel();
    act(() => socket.options.onOpen?.());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(chat.addToolApprovalResponse).toHaveBeenCalledExactlyOnceWith({
      id: 'ap_7',
      approved: true,
    });
    expect(socket.call).not.toHaveBeenCalled();
  });

  it('hands the edit back to the page while the socket is down, and says so quietly', async () => {
    renderPanel();
    act(() => socket.options.onClose?.());
    await expect(edit('entries_publish', { id: 'e1' })).resolves.toBeNull();
    expect(socket.call).not.toHaveBeenCalled();
    expect(await screen.findByText(/Can’t reach Coworker right now/)).toBeTruthy();
  });

  it('stops reconnecting and asks for a reload once the sign-in has ended', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    act(() => socket.options.onClose?.({ code: 4401 }));
    expect(socket.close).toHaveBeenCalled();
    expect(await screen.findByText(/Your sign-in has ended. Reload the page/)).toBeTruthy();
    // A later ordinary close (the socket shutting) doesn't turn it back into "trying again".
    act(() => socket.options.onClose?.({ code: 1006 }));
    expect(screen.queryByText(/trying again/)).toBeNull();
    await expect(edit('entries_publish', { id: 'e1' })).resolves.toBeNull();
  });

  it('passes a refusal on to the page', async () => {
    renderPanel();
    act(() => socket.options.onOpen?.());
    socket.call.mockRejectedValueOnce(new Error('You can’t publish in this space'));
    await expect(edit('entries_publish', { id: 'e1' })).rejects.toThrow(
      'You can’t publish in this space',
    );
  });
});

describe('a card', () => {
  const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('names the action and what it is about, and answers Confirm or Not now once', () => {
    const respond = vi.fn();
    inRouter(<ActionCard part={card()} respond={respond} actionKey="m1:0" direct />);
    const region = screen.getByRole('region', { name: 'Publish this entry' });
    expect(within(region).getByText('Spring launch notes')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Confirm' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith(expect.anything(), true);
    expect(
      (within(region).getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('counts a batch’s entries when the page gave no label', () => {
    inRouter(
      <ActionCard
        part={card({
          type: 'tool-entries_bulk_action',
          input: { action: 'publish', ids: ['a', 'b', 'c'] },
          toolMetadata: undefined,
        })}
        respond={vi.fn()}
        actionKey="m1:0"
        direct={false}
      />,
    );
    expect(screen.getByText('Change these entries')).toBeTruthy();
    expect(screen.getByText('3 entries')).toBeTruthy();
  });

  it('says what a bulk job does to how many entries, and marks a removal destructive', () => {
    const job = (action: string, n: number) =>
      card({
        type: 'tool-bulk_job_start',
        input: { action, entryIds: Array.from({ length: n }, (_, i) => `e${i}`) },
        toolMetadata: undefined,
      });
    const confirmOf = (action: string, n: number, about: string) => {
      const view = inRouter(
        <ActionCard part={job(action, n)} respond={vi.fn()} actionKey="m1:0" direct={false} />,
      );
      const region = screen.getByRole('region', { name: 'Run a job on these entries' });
      expect(within(region).getByText(about)).toBeTruthy();
      const variant = within(region)
        .getByRole('button', { name: 'Confirm' })
        .getAttribute('data-variant');
      view.unmount();
      return variant;
    };
    // A model's proposal to delete 500 entries says so, and its confirm reads as a removal.
    expect(confirmOf('purge', 500, 'Permanently delete 500 entries')).toBe('destructive');
    expect(confirmOf('trash', 12, 'Move 12 entries to the trash')).toBe('destructive');
    expect(confirmOf('unpublish', 1, 'Unpublish 1 entry')).toBe('destructive');
    expect(confirmOf('restore', 3, 'Restore 3 entries from the trash')).toBe('default');
    expect(confirmOf('publish', 2, 'Publish 2 entries')).toBe('default');
  });

  it('stops asking once a newer identical request replaced it', () => {
    inRouter(<ActionCard part={card()} respond={vi.fn()} actionKey="m1:0" direct replaced />);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByText(/replaced by the newer request/)).toBeTruthy();
  });

  it('reads as left as it was once declined', () => {
    inRouter(
      <ActionCard
        part={card({ state: 'output-denied', approval: { id: 'direct_1', approved: false } })}
        respond={vi.fn()}
        actionKey="m1:0"
        direct
      />,
    );
    expect(
      screen.getByText('Publish this entry · Spring launch notes: left as it was'),
    ).toBeTruthy();
  });
});

describe('an edit line', () => {
  const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('says what was done and to what, linking to the entry it changed', () => {
    inRouter(
      <EditLine
        part={card({
          state: 'output-available',
          output: { id: 'e1', contentTypeApiId: 'article', publishedVersion: 2 },
          approval: { id: 'direct_1', approved: true },
        })}
      />,
    );
    const link = screen.getByRole('link', { name: 'Published · Spring launch notes' });
    expect(link.getAttribute('href')).toBe('/content/article/e1');
  });

  it('links a saved draft through its view, and an edit without an entry not at all', () => {
    expect(entryHref({ entry: { id: 'e 2', contentTypeApiId: 'news' }, fields: {} })).toBe(
      '/content/news/e%202',
    );
    expect(entryHref({ total: 3, succeeded: 3, failed: 0, results: [] })).toBeNull();
    inRouter(
      <EditLine
        part={card({
          type: 'tool-entries_bulk_action',
          state: 'output-available',
          input: { action: 'publish', ids: ['a', 'b'] },
          output: { total: 2, succeeded: 2, failed: 0, results: [] },
          toolMetadata: { direct: true, about: 'Publish 2 entries' },
        })}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Changed entries')).toBeTruthy();
  });

  it('says why an edit didn’t go through', () => {
    inRouter(
      <EditLine
        part={card({
          state: 'output-error',
          errorText: 'Publish blocked by moderation',
          approval: { id: 'direct_1', approved: true },
        })}
      />,
    );
    expect(screen.getByText(/didn’t go through/)).toBeTruthy();
    expect(screen.getByText('Publish blocked by moderation')).toBeTruthy();
  });
});
