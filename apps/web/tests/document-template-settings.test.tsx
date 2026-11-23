// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DocumentTemplateSettings } from '~/cms/components/assets/DocumentTemplateSettings';
import { ToastProvider } from '~/cms/lib/toast';

const saved = { version: 7, createMediaDrafts: true, suggestTags: false, describeDocument: true };
const client = {
  getSpaceAccess: vi.fn(),
  getDocumentTemplate: vi.fn(),
  setDocumentTemplate: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client, conn: { space: 'library', environment: 'staging' } }),
}));
function mount(scopes: string[]) {
  client.getSpaceAccess.mockResolvedValue({ scopes });
  client.getDocumentTemplate.mockResolvedValue(saved);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <DocumentTemplateSettings />
      </ToastProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ingestion settings' }));
  return within(screen.getByRole('dialog'));
}
it('reads the current revision and shows the settings to a read-only asset editor', async () => {
  const dialog = mount(['assets:read']);
  await dialog.findByText('Your role can view these settings.');
  const tags = dialog.getByRole('checkbox', { name: /Apply AI tags/ });
  expect(tags.getAttribute('aria-checked')).toBe('false');
  expect(tags).toHaveProperty('disabled', true);
  expect(dialog.queryByRole('button', { name: 'Save changes' })).toBeNull();
});
it('guards unsaved selections and keeps them when the editor cancels a discard', async () => {
  const dialog = mount(['assets:read', 'assets:write']);
  const tags = await dialog.findByRole('checkbox', { name: /Apply AI tags/ });
  fireEvent.click(tags);
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  await dialog.findByText('Discard your changes to document ingestion?');
  fireEvent.click(dialog.getByRole('button', { name: 'Keep editing' }));
  expect(tags.getAttribute('aria-checked')).toBe('true');
  expect(client.setDocumentTemplate).not.toHaveBeenCalled();
});
