// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom ships no ResizeObserver; radix's Checkbox measures itself through it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The TanStack cache scoping isn't under test here (see connected-apps.test.tsx).
const refetchers = new Set<() => void>();
vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(_segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    const load = useCallback(() => {
      queryFn().then(setData);
    }, [queryFn]);
    useEffect(() => {
      load();
      refetchers.add(load);
      return () => {
        refetchers.delete(load);
      };
    }, [load]);
    return { data };
  },
  useInvalidate: () => async () => {
    for (const r of refetchers) r();
  },
}));

const { Webhooks } = await import('~/cms/components/Settings');
const { WebhookDialog } = await import('~/cms/components/WebhookDialog');
const { ToastProvider } = await import('~/cms/lib/toast');
type ManagementClient = import('~/cms/lib/management').ManagementClient;
type WebhookSummary = import('~/cms/lib/management').WebhookSummary;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const scoped: WebhookSummary = {
  id: 'w1',
  url: 'https://hooks.example.com/staging',
  topics: ['*'],
  active: true,
  environmentId: 'staging',
};
const everywhere: WebhookSummary = {
  id: 'w2',
  url: 'https://hooks.example.com/all',
  topics: ['entry.published'],
  active: true,
  environmentId: null,
};

function fakeClient(hooks: WebhookSummary[]) {
  return {
    listWebhooks: vi.fn(async () => hooks),
    createWebhook: vi.fn(async (input: { url: string }) => ({ ...scoped, url: input.url })),
    updateWebhook: vi.fn(async () => scoped),
    deleteWebhook: vi.fn(async () => {}),
  };
}

const renderWebhooks = (client: ReturnType<typeof fakeClient>) =>
  render(
    <ToastProvider>
      <Webhooks client={client as unknown as ManagementClient} />
    </ToastProvider>,
  );

describe('Settings → Webhooks', () => {
  it("shows each hook's environments: its own, or all of them", async () => {
    renderWebhooks(fakeClient([scoped, everywhere]));
    const scopedRow = (await screen.findByText(scoped.url)).closest('tr') as HTMLElement;
    expect(within(scopedRow).getByText('staging')).toBeTruthy();
    const wideRow = screen.getByText(everywhere.url).closest('tr') as HTMLElement;
    expect(within(wideRow).getByText('All environments')).toBeTruthy();
  });

  it('creates a hook for the current environment unless every environment is ticked', async () => {
    const client = fakeClient([]);
    renderWebhooks(client);
    await screen.findByText('No webhooks yet.');
    const add = (url: string) => {
      fireEvent.change(screen.getByPlaceholderText('https://example.com/hooks/cms'), {
        target: { value: url },
      });
      fireEvent.change(screen.getByPlaceholderText('Signing secret'), {
        target: { value: 'shh' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }));
    };

    add('https://hooks.example.com/one');
    await waitFor(() => expect(client.createWebhook).toHaveBeenCalledTimes(1));
    // Left out, not false: the API scopes it to the environment (or, under an alias, the space).
    expect(client.createWebhook.mock.calls[0]?.[0]).not.toHaveProperty('allEnvironments');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Send events from every environment' }));
    add('https://hooks.example.com/two');
    await waitFor(() => expect(client.createWebhook).toHaveBeenCalledTimes(2));
    expect(client.createWebhook.mock.calls[1]?.[0]).toMatchObject({ allEnvironments: true });
  });
});

describe('Edit webhook dialog', () => {
  const open = (webhook: WebhookSummary) => {
    const onSave = vi.fn(async (_changes: Record<string, unknown>) => {});
    render(<WebhookDialog open onOpenChange={() => {}} webhook={webhook} onSave={onSave} />);
    return onSave;
  };
  const box = () => screen.getByRole('checkbox', { name: 'Send events from every environment' });

  it('reflects the scope, and sends allEnvironments only when it changes', async () => {
    const onSave = open(scoped);
    expect(box().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('allEnvironments');

    fireEvent.click(box());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ allEnvironments: true });
  });

  it('scopes a space-wide hook to this environment when unticked', async () => {
    const onSave = open(everywhere);
    expect(box().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ allEnvironments: false });
  });
});
