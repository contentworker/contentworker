// @vitest-environment jsdom
// Settings → AI: a row per capability (switch, tier, guidance with its count), one Save that sends
// only what changed against the version read, and a stale save that keeps the edits and offers to
// load the latest.
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_INFO,
  type AiSettings,
  DEFAULT_AI_SETTINGS,
} from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementClient } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let current: Record<string, unknown> = {};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client: current, conn: { space: 'blog', environment: 'main' } }),
}));

const { AiSettings: AiSettingsPage } = await import('~/cms/components/AiSettings');
const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError } = await import('~/cms/lib/management');

afterEach(cleanup);

function fakeClient(start: AiSettings = DEFAULT_AI_SETTINGS) {
  let stored = start;
  const client = {
    getAiSettings: vi.fn(async () => stored),
    setAiSettings: vi.fn(
      async (input: { expectedVersion: number; capabilities: Record<string, unknown> }) => {
        if (input.expectedVersion !== stored.version) {
          throw new ApiError(409, 'stale', {
            error: { code: 'conflict', message: 'stale', details: { version: stored.version } },
          });
        }
        stored = {
          ...stored,
          version: stored.version + 1,
          capabilities: { ...stored.capabilities, ...input.capabilities },
        } as AiSettings;
        return { settings: stored, unchanged: false };
      },
    ),
    /** Someone else saves meanwhile. */
    theirs(next: Partial<AiSettings['capabilities']>) {
      stored = {
        ...stored,
        version: stored.version + 1,
        capabilities: { ...stored.capabilities, ...next },
      };
    },
  };
  current = client;
  return client;
}

const renderPage = (client: ReturnType<typeof fakeClient>) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <AiSettingsPage client={client as unknown as ManagementClient} />
      </ToastProvider>
    </QueryClientProvider>,
  );

const rowOf = (label: string) =>
  screen.getByRole('heading', { level: 3, name: label }).closest('li') as HTMLElement;

describe('Settings → AI', () => {
  it('shows one row per capability, each switch on and named, with a tier and guidance', async () => {
    renderPage(fakeClient());
    for (const c of AI_CAPABILITIES) {
      const { label } = AI_CAPABILITY_INFO[c];
      const sw = await screen.findByRole('switch', { name: label });
      expect(sw.getAttribute('aria-checked')).toBe('true');
    }
    const drafting = rowOf('Drafting');
    expect(within(drafting).getByLabelText('Model tier')).toBeTruthy();
    expect(within(drafting).getByText('0 of 2,000 characters')).toBeTruthy();
    // Search has no prompt: no tier or guidance to set, and it says why.
    const search = rowOf('Semantic search');
    expect(within(search).queryByLabelText('Guidance')).toBeNull();
    expect(within(search).getByText(/no tier or guidance/)).toBeTruthy();
    // Nothing to save yet.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves only what changed, against the version read', async () => {
    const client = fakeClient();
    renderPage(client);
    fireEvent.click(await screen.findByRole('switch', { name: 'Translation' }));
    fireEvent.change(within(rowOf('Drafting')).getByLabelText('Guidance'), {
      target: { value: 'British English.' },
    });
    expect(within(rowOf('Drafting')).getByText('16 of 2,000 characters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.setAiSettings).toHaveBeenCalledTimes(1));
    expect(client.setAiSettings).toHaveBeenCalledWith({
      expectedVersion: 0,
      capabilities: {
        drafting: { enabled: true, tier: null, guidance: 'British English.' },
        translation: { enabled: false, tier: null, guidance: null },
      },
    });
    await screen.findByText('AI settings saved');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });

  it('holds Save while a guidance is over its length, and says so beside it', async () => {
    renderPage(fakeClient());
    const box = within(await waitFor(() => rowOf('Coworker'))).getByLabelText('Guidance');
    fireEvent.change(box, { target: { value: 'x'.repeat(2001) } });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/2,001 of 2,000 characters: shorten it to save/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the edits on a stale save, and Load the latest brings theirs in', async () => {
    const client = fakeClient();
    renderPage(client);
    fireEvent.click(await screen.findByRole('switch', { name: 'Media' }));
    client.theirs({ layout: { enabled: false, tier: null, guidance: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('The AI settings changed since you opened them');
    expect(screen.getByText(/saved them as v1, so your changes weren’t saved/)).toBeTruthy();
    // The edit is still on the form, and Save waits for a decision.
    expect(screen.getByRole('switch', { name: 'Media' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Copy my changes as JSON/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load the latest' }));
    await waitFor(() =>
      expect(screen.queryByText('The AI settings changed since you opened them')).toBeNull(),
    );
    expect(screen.getByRole('switch', { name: 'Page layouts' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Media' }).getAttribute('aria-checked')).toBe('true');
  });

  it('says a failed load as one, with Retry, never as settings that look on', async () => {
    const client = fakeClient();
    client.getAiSettings.mockRejectedValueOnce(new ApiError(500, 'The database is busy'));
    renderPage(client);
    await screen.findByText('The AI settings didn’t load');
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('switch', { name: 'Drafting' });
  });
});
