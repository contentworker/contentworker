// A form with work in it asks before it goes: a press outside it, Escape, the close button and
// Cancel all reach the same question, in place of the form's buttons. An untouched form just closes.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { ImportRedirectsDialog } from '~/cms/components/Redirects';
import type { ManagementClient } from '~/cms/lib/management';

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
    // The buttons came back as new elements: focus goes to one, not to <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
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
