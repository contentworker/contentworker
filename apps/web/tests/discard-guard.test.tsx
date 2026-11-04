// A form with work in it asks before it goes: a press outside it, Escape, the close button and
// Cancel all reach the same question, in place of the form's buttons. An untouched form just closes.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { ImportRedirectsDialog } from '~/cms/components/Redirects';
import { TermEditor } from '~/cms/components/TermEditor';
import {
  createManagementClient,
  type ManagementClient,
  RequestTimeoutError,
} from '~/cms/lib/management';
import { CreateReleaseDialog } from '~/cms/routes/Releases';

function NewContentType({ onClosed }: { onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <ContentTypeDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) onClosed();
      }}
      onSave={async () => {
        setOpen(false);
      }}
    />
  );
}

const pressEscape = () =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
const pressOutside = () => {
  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
};
const typeName = (value: string) =>
  fireEvent.change(screen.getByLabelText('Name'), { target: { value } });
const question = () => screen.queryByRole('alertdialog', { name: /Discard this content type/ });

describe('discard guard', () => {
  it('closes an untouched form at once', async () => {
    const onClosed = vi.fn();
    render(<NewContentType onClosed={onClosed} />);
    await screen.findByRole('dialog');
    pressEscape();
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['Escape', pressEscape],
    ['a press outside', pressOutside],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
  ])('asks before %s throws away a typed form', async (_way, leave) => {
    const onClosed = vi.fn();
    render(<NewContentType onClosed={onClosed} />);
    await screen.findByRole('dialog');
    typeName('Blog Post');

    leave();

    const asked = await screen.findByRole('alertdialog', { name: /Discard this content type/ });
    expect(onClosed).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Blog Post');
    // The safe choice has focus, and it stands in for the buttons rather than beside them.
    expect(document.activeElement).toBe(
      within(asked).getByRole('button', { name: 'Keep editing' }),
    );
    expect(screen.queryByRole('button', { name: 'Create content type' })).toBeNull();
  });

  it('Keep editing goes back to the form with what was typed', async () => {
    const onClosed = vi.fn();
    render(<NewContentType onClosed={onClosed} />);
    await screen.findByRole('dialog');
    typeName('Blog Post');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    await screen.findByRole('alertdialog');

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(question()).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Blog Post');
    expect(screen.getByRole('button', { name: 'Create content type' })).toBeTruthy();
    // The form's first field took focus as it opened: that is what editing goes back to.
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('Keep editing goes back to the field, not to whatever asked', async () => {
    render(<NewContentType onClosed={vi.fn()} />);
    await screen.findByRole('dialog');
    const name = screen.getByLabelText('Name');
    name.focus();
    typeName('Blog Post');
    // As in WebKit: the press leaves focus on the dialog itself, not on the button.
    screen.getByRole('dialog').focus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('alertdialog');

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  });

  it('Escape from the question keeps the form rather than closing it', async () => {
    const onClosed = vi.fn();
    render(<NewContentType onClosed={onClosed} />);
    await screen.findByRole('dialog');
    typeName('Blog Post');
    pressOutside();
    await screen.findByRole('alertdialog');

    pressEscape();

    expect(question()).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Discard closes, and a question asked twice is one question', async () => {
    const onClosed = vi.fn();
    render(<NewContentType onClosed={onClosed} />);
    await screen.findByRole('dialog');
    typeName('Blog Post');
    pressOutside();
    pressOutside();
    expect(await screen.findAllByRole('alertdialog')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
  });

  it('saving closes without asking', async () => {
    const onSave = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    render(<ContentTypeDialog open onOpenChange={onOpenChange} onSave={onSave} />);
    typeName('Blog Post');
    fireEvent.click(screen.getByRole('button', { name: 'Create content type' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(question()).toBeNull();
  });

  it('waits for a save under way: nothing can be discarded once it has been sent', async () => {
    let finish: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    render(<ContentTypeDialog open onOpenChange={onOpenChange} onSave={onSave} />);
    typeName('Blog Post');
    fireEvent.click(screen.getByRole('button', { name: 'Create content type' }));
    await screen.findByRole('button', { name: 'Saving…' });

    // Cancel can't be pressed, and it says why rather than doing nothing.
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/Still saving/)).toBeNull();

    pressEscape();
    pressOutside();

    expect(question()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(
      'Still saving. This closes when it’s done.',
    );
    finish();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('asks again, and offers Cancel, once a refused save lets go', async () => {
    let refuse: (e: Error) => void = () => {};
    const onSave = () =>
      new Promise<void>((_, reject) => {
        refuse = reject;
      });
    render(<ContentTypeDialog open onOpenChange={() => {}} onSave={onSave} />);
    typeName('Blog Post');
    fireEvent.click(screen.getByRole('button', { name: 'Create content type' }));
    await screen.findByRole('button', { name: 'Saving…' });
    pressEscape();
    await screen.findByRole('status');

    refuse(new Error('Refused'));

    await screen.findByRole('alert');
    expect(screen.queryByText(/Still saving/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog', { name: /Discard this/ })).toBeTruthy();
  });

  it('stays closable during a dry run, a read, and drops its answer', async () => {
    let signal: AbortSignal | undefined;
    const importRedirects = vi.fn((_input: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const onOpenChange = vi.fn();
    const view = render(
      <ImportRedirectsDialog
        open
        onOpenChange={onOpenChange}
        client={{ importRedirects } as unknown as ManagementClient}
        onImported={async () => {}}
      />,
    );
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('CSV'), { target: { value: '/old,/new,301' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByRole('button', { name: 'Checking…' });

    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false);
    pressOutside();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The page mounts it only while open.
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('holds during the import itself, a write', async () => {
    const importRedirects = vi
      .fn()
      .mockResolvedValueOnce({ created: 1, updated: 0, unchanged: 0, chains: [] })
      .mockReturnValueOnce(new Promise(() => {}));
    render(
      <ImportRedirectsDialog
        open
        onOpenChange={() => {}}
        client={{ importRedirects } as unknown as ManagementClient}
        onImported={async () => {}}
      />,
    );
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('CSV'), { target: { value: '/old,/new,301' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
    await screen.findByRole('button', { name: 'Importing…' });

    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
  });

  describe('a save that never answers', () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const hung = () =>
      createManagementClient(
        { space: 's', environment: 'main', locale: 'en-US' },
        (() => new Promise(() => {})) as unknown as typeof fetch,
      );

    it('lets the form go, keeps what was typed and says it may have landed', async () => {
      vi.useFakeTimers();
      const client = hung();
      render(
        <ContentTypeDialog
          open
          onOpenChange={() => {}}
          onSave={async (draft) => {
            await client.saveContentType(draft);
          }}
        />,
      );
      typeName('Blog Post');
      fireEvent.click(screen.getByRole('button', { name: 'Create content type' }));
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(screen.getByRole('alert').textContent).toContain('didn’t confirm');
      expect(screen.getByRole('alert').className).toContain('text-destructive');
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Blog Post');
      expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false);
      expect(screen.getByRole('button', { name: 'Create content type' })).toBeTruthy();
    });

    it('never says an import that timed out imported nothing', async () => {
      const client = {
        importRedirects: vi
          .fn()
          .mockResolvedValueOnce({ created: 1, updated: 0, unchanged: 0, chains: [] })
          .mockRejectedValueOnce(new RequestTimeoutError(true)),
      };
      render(
        <ImportRedirectsDialog
          open
          onOpenChange={() => {}}
          client={client as unknown as ManagementClient}
          onImported={async () => {}}
        />,
      );
      await screen.findByRole('dialog');
      fireEvent.change(screen.getByLabelText('CSV'), { target: { value: '/old,/new,301' } });
      fireEvent.click(screen.getByRole('button', { name: 'Check' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Import' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('didn’t confirm');
      expect(alert.textContent).not.toContain('Nothing was imported');
    });

    it('makes a new release’s retry a choice: it has no key to refuse a second one', async () => {
      const onCreate = vi
        .fn()
        .mockRejectedValueOnce(new RequestTimeoutError(true))
        .mockResolvedValueOnce(undefined);
      render(<CreateReleaseDialog open busy={false} onOpenChange={() => {}} onCreate={onCreate} />);
      fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Spring' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect((await screen.findByRole('alert')).textContent).toContain('check before');
      expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Spring');

      fireEvent.click(screen.getByRole('button', { name: 'Create again' }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    });
  });

  it('a new release can be left while something else on the page works', async () => {
    const onOpenChange = vi.fn();
    render(<CreateReleaseDialog open busy onOpenChange={onOpenChange} onCreate={async () => {}} />);
    await screen.findByRole('dialog');
    pressEscape();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a new release waits for its own save', async () => {
    let finish: () => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    render(
      <CreateReleaseDialog open busy={false} onOpenChange={onOpenChange} onCreate={onCreate} />,
    );
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Spring' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true),
    );
    pressEscape();
    expect(onOpenChange).not.toHaveBeenCalled();
    await screen.findByRole('status');
    await act(async () => finish());
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false);
  });

  it('a term waits for its own save, not for the page being busy', async () => {
    let finish: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    const term = {
      label: 'News',
      slug: 'news',
      description: null,
      labels: {},
      usage: { count: 0, byContentType: {} },
    };
    const editor = (busy: boolean) => (
      <TermEditor
        kind="tag"
        term={term}
        locales={['en-US']}
        defaultLocale="en-US"
        busy={busy}
        onSave={onSave}
        onOpenChange={onOpenChange}
      />
    );
    const view = render(editor(true));
    await screen.findByRole('dialog');
    pressEscape();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();

    view.rerender(editor(false));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Newsroom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tag' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true),
    );
    pressEscape();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => finish());
  });

  it('holds a pasted redirect import', async () => {
    const onOpenChange = vi.fn();
    render(
      <ImportRedirectsDialog
        open
        onOpenChange={onOpenChange}
        client={{} as ManagementClient}
        onImported={async () => {}}
      />,
    );
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('CSV'), { target: { value: '/old,/new,301' } });

    pressOutside();

    await screen.findByRole('alertdialog', { name: /Discard this import/ });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
