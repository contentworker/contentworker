// @vitest-environment jsdom
import type { ContentType } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJobSummary, ContentTypeDependents } from '~/cms/lib/management';

const client = {
  contentTypeDependents: vi.fn<(apiId: string) => Promise<ContentTypeDependents>>(),
  deleteContentType:
    vi.fn<
      (
        apiId: string,
        o: { purgeEntries?: boolean },
      ) => Promise<{ deleted: true } | { deleted: false; job: BulkJobSummary }>
    >(),
  cloneContentType:
    vi.fn<(apiId: string, to: { apiId: string; name: string }) => Promise<ContentType>>(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: async (fn: () => Promise<void>) => fn(),
  }),
}));

const { DeleteContentTypeDialog, CloneContentTypeDialog } = await import(
  '~/cms/components/ContentTypeActions'
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const note = {
  apiId: 'note',
  name: 'Note',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [],
} as unknown as ContentType;

const free: ContentTypeDependents = {
  contentType: 'note',
  entries: { live: 0, trashed: 0 },
  linkedFrom: [],
  menus: [],
  redirects: [],
};

function renderDelete(onDeleted = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DeleteContentTypeDialog type={note} open onOpenChange={() => {}} onDeleted={onDeleted} />
    </QueryClientProvider>,
  );
  return onDeleted;
}

const deleteButton = () =>
  screen.getByRole('button', { name: /^Delete (content type|type and entries)$/ });

describe('deleting a content type from the admin', () => {
  it('waits for the API ID to be typed, then deletes', async () => {
    client.contentTypeDependents.mockResolvedValue(free);
    client.deleteContentType.mockResolvedValue({ deleted: true });
    const onDeleted = renderDelete();
    const confirm = await screen.findByLabelText(/to confirm/);
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
    fireEvent.change(confirm, { target: { value: 'Note' } });
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
    fireEvent.change(confirm, { target: { value: 'note' } });
    fireEvent.click(deleteButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(null));
    expect(client.deleteContentType).toHaveBeenCalledWith('note', { purgeEntries: false });
  });

  it('names what blocks it, and offers no confirm then', async () => {
    client.contentTypeDependents.mockResolvedValue({
      ...free,
      linkedFrom: [{ contentType: 'post', field: 'body.byline.who' }],
      menus: [{ id: 'm', handle: 'main' }],
      urlPattern: '/notes/{id}',
    });
    renderDelete();
    expect(await screen.findByText('post.body.byline.who links to it')).toBeTruthy();
    expect(screen.getByText('The menu “main” links its entries')).toBeTruthy();
    expect(screen.getByText(/URL pattern \/notes\/\{id\}/)).toBeTruthy();
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
  });

  it('deletes the entries too only when asked to, as a job', async () => {
    client.contentTypeDependents.mockResolvedValue({ ...free, entries: { live: 3, trashed: 1 } });
    const job = { id: 'j1', action: 'content_type_delete', status: 'running' } as BulkJobSummary;
    client.deleteContentType.mockResolvedValue({ deleted: false, job });
    const onDeleted = renderDelete();
    fireEvent.change(await screen.findByLabelText(/to confirm/), { target: { value: 'note' } });
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Also delete its 4 entries \(1 in the trash\)/ }),
    );
    fireEvent.click(deleteButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(job));
    expect(client.deleteContentType).toHaveBeenCalledWith('note', { purgeEntries: true });
  });
});

describe('cloning a content type from the admin', () => {
  it('suggests a name and API ID, and sends what was typed', async () => {
    client.cloneContentType.mockResolvedValue({ ...note, apiId: 'memo', name: 'Memo' });
    const onCloned = vi.fn();
    render(
      <CloneContentTypeDialog source={note} open onOpenChange={() => {}} onCloned={onCloned} />,
    );
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Note copy');
    expect((screen.getByLabelText('API ID') as HTMLInputElement).value).toBe('noteCopy');
    fireEvent.change(name, { target: { value: 'Memo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clone content type' }));
    await waitFor(() => expect(onCloned).toHaveBeenCalled());
    expect(client.cloneContentType).toHaveBeenCalledWith('note', { apiId: 'memo', name: 'Memo' });
  });

  it('shows the API’s refusal', async () => {
    client.cloneContentType.mockRejectedValue(new Error('A content type "memo" already exists'));
    render(
      <CloneContentTypeDialog source={note} open onOpenChange={() => {}} onCloned={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clone content type' }));
    expect(await screen.findByText('A content type "memo" already exists')).toBeTruthy();
  });
});
