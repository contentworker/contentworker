// @vitest-environment jsdom
// Settings → Connect a frontend: minting the keys shows their tokens once and fills them into the
// config; the preview URL rows save one type's template alone (checked before the save); and the
// live check frames the Site frame for an entry, out of sight, and says how its page answered.
import type { ContentType } from '@contentworker/domain';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_CHANNEL } from '~/cms/lib/live-preview/frame-channel';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let types: ContentType[] = [];
vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(_segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [state, setState] = useState<{ data?: T; isSuccess: boolean }>({ isSuccess: false });
    useEffect(() => {
      queryFn().then((data) => setState({ data, isSuccess: true }));
    }, [queryFn]);
    return state;
  },
  useContentTypesQuery: () => ({ data: types, isPending: false }),
  useSpaceConfigQuery: () => ({ data: { defaultLocale: 'en-US' } }),
  useInvalidate: () => async () => {},
}));
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ conn: { space: 'acme', environment: 'main', locale: 'en-US' } }),
}));

const { ConnectFrontend } = await import('~/cms/components/ConnectFrontend');
const { ToastProvider } = await import('~/cms/lib/toast');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

afterEach(() => {
  cleanup();
  types = [];
});

const field = (apiId: string, type: string) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position: 0,
});
const post = {
  apiId: 'post',
  name: 'Post',
  displayField: 'title',
  fields: [field('title', 'Symbol'), field('slug', 'Slug')],
  version: 1,
  status: 'published',
} as unknown as ContentType;
const settings = {
  ...post,
  apiId: 'settings',
  name: 'Settings',
  fields: [field('title', 'Symbol')],
} as unknown as ContentType;
const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';

function fakeClient() {
  return {
    listRoles: vi.fn(async () => []),
    listEntries: vi.fn(async () => [{ id: 'e1', contentType: 'post', status: 'published' }]),
    connectFrontend: vi.fn(async (input: { preview?: boolean }) => ({
      space: 'acme',
      environment: 'main',
      deliveryKey: { id: 'k1', token: 'cwk_cda_minted' },
      ...(input.preview ? { previewKey: { id: 'k2', token: 'cwk_cpa_minted' } } : {}),
      endpoints: {
        admin: 'https://cms.example.com',
        delivery: 'https://cdn.cms.example.com',
        preview: 'https://api.cms.example.com',
      },
      previewUrls: [],
    })),
    setContentTypePreview: vi.fn(async () => post),
  };
}

const open = (client: ReturnType<typeof fakeClient>) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ConnectFrontend client={client as unknown as ManagementClient} />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('Connect a frontend', () => {
  it('prints the config with placeholders, then the minted keys, shown once', async () => {
    const client = fakeClient();
    open(client);
    // Before minting: this admin's own origin gives the endpoints, and no token is anywhere.
    expect(await screen.findByLabelText('wrangler.jsonc')).toBeTruthy();
    expect(document.body.textContent).not.toContain('cwk_');

    // Ticking adds the Preview key's role on a line of its own: the row with Create stays as it was.
    const create = screen.getByRole('button', { name: 'Create key' });
    const row = create.parentElement;
    const before = row?.innerHTML;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also create a Preview key' }));
    const previewRole = screen.getByRole('combobox', { name: 'Preview key role' });
    expect(row?.contains(previewRole)).toBe(false);
    expect(row?.innerHTML.replace('Create keys', 'Create key')).toBe(before);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Marketing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create keys' }));
    await screen.findByText(/Copy these keys now/);
    expect(client.connectFrontend).toHaveBeenCalledWith({ name: 'Marketing', preview: true });
    expect(screen.getByRole('button', { name: 'Copy delivery key' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy preview key' })).toBeTruthy();
    // The runtime's vars name the backend from the answer's endpoints, never the token.
    expect(screen.getByLabelText('wrangler.jsonc').textContent).toContain(
      'https://cdn.cms.example.com/acme/main',
    );
    expect(screen.getByLabelText('wrangler.jsonc').textContent).not.toContain('cwk_');

    // Minting again would replace the keys on screen: asked first, and they stay until then.
    expect(screen.queryByRole('button', { name: /^Create key/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create other keys…' }));
    expect(screen.getByText('Create other keys?')).toBeTruthy();
    expect(screen.getByText('cwk_cda_minted')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create other keys' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create keys' }));
    await waitFor(() => expect(client.connectFrontend).toHaveBeenCalledTimes(2));
    expect(client.connectFrontend).toHaveBeenLastCalledWith({ preview: true });
  });

  it('saves one type’s preview URL, refusing a template without a token before it asks', async () => {
    types = [post, settings];
    const client = fakeClient();
    open(client);
    const input = screen.getByLabelText(/^Post/);
    // Every type gets a row, as the API lists them.
    expect(screen.getByLabelText(/^Settings/)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'https://site.example/p/{id}' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/token/i);
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(document.activeElement).toBe(input);
    expect(client.setContentTypePreview).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: TEMPLATE } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() =>
      expect(client.setContentTypePreview).toHaveBeenCalledWith('post', TEMPLATE),
    );
  });

  it('says beside the field why the server refused a preview URL', async () => {
    types = [post];
    const client = fakeClient();
    client.setContentTypePreview.mockRejectedValueOnce(
      new Error('changed while it was being saved'),
    );
    open(client);
    const input = screen.getByLabelText(/^Post/);
    fireEvent.change(input, { target: { value: TEMPLATE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'changed while it was being saved',
    );
    expect(document.activeElement).toBe(input);
  });

  it('checks the connection through the Site frame and says how the page answered', async () => {
    types = [{ ...post, preview: { urlTemplate: TEMPLATE } } as ContentType];
    const client = fakeClient();
    open(client);
    const check = await screen.findByRole('button', { name: 'Check connection' });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(check);
    const frame = (await screen.findByTitle('Connection check')) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('/preview-frame/acme/main/e1');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    const win = frame.contentWindow as Window;
    const spy = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    const say = (data: Record<string, unknown>, source: unknown = win) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { channel: FRAME_CHANNEL, ...data },
            origin: window.location.origin,
            source: source as Window,
          }),
        );
      });
    say({ type: 'ready', origin: 'https://site.example' });
    // The page may do nothing: its offer is answered with no capabilities.
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ type: 'view', allowed: [] });
    // Another window's word is never taken.
    say({ type: 'status', status: 'live' }, window);
    expect(screen.queryByText('Connected')).toBeNull();
    say({ type: 'status', status: 'live' });
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('https://site.example')).toBeTruthy();
    // Answered: the frame goes, so the site isn't left loaded behind the screen.
    expect(screen.queryByTitle('Connection check')).toBeNull();
  });

  it('says when the site’s SDK is too old, and when the page never connects', async () => {
    types = [{ ...post, preview: { urlTemplate: TEMPLATE } } as ContentType];
    open(fakeClient());
    const check = await screen.findByRole('button', { name: 'Check connection' });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    const answer = async (data: Record<string, unknown>) => {
      fireEvent.click(check);
      const frame = (await screen.findByTitle('Connection check')) as HTMLIFrameElement;
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { channel: FRAME_CHANNEL, ...data },
            origin: window.location.origin,
            source: frame.contentWindow as Window,
          }),
        );
      });
    };
    await answer({ type: 'status', status: 'unsupported', detail: 'old' });
    expect(await screen.findByText('The site’s SDK is too old')).toBeTruthy();
    await answer({ type: 'status', status: 'not-connected' });
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(screen.getByText(/didn’t offer to connect/)).toBeTruthy();
  });

  it('checks another type only when asked, not when it is picked', async () => {
    const framed = { ...post, preview: { urlTemplate: TEMPLATE } } as ContentType;
    types = [framed, { ...framed, apiId: 'page', name: 'Page' } as ContentType];
    const client = fakeClient();
    client.listEntries.mockImplementation(async (type?: string) => [
      { id: type === 'page' ? 'e2' : 'e1', contentType: type ?? 'post', status: 'published' },
    ]);
    open(client);
    const check = await screen.findByRole('button', { name: 'Check connection' });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(check);
    const frame = (await screen.findByTitle('Connection check')) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('/preview-frame/acme/main/e1');
    // Pick another type: the check stops, its frame goes, and nothing loads until asked.
    fireEvent.click(screen.getByRole('combobox', { name: 'Content type to check' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Page' }));
    await waitFor(() => expect(screen.queryByTitle('Connection check')).toBeNull());
    expect(screen.queryByText('Checking')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(
      ((await screen.findByTitle('Connection check')) as HTMLIFrameElement).getAttribute('src'),
    ).toBe('/preview-frame/acme/main/e2');
  });
});
