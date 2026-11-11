// @vitest-environment jsdom
import type { ContentType, ContentTypeDraft } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog, SavedNotPublishedError } from '~/cms/components/ContentTypeDialog';
import { ApiError } from '~/cms/lib/management';

// jsdom ships neither; radix's Select reaches for both.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

const EVENT: ContentType = {
  apiId: 'event',
  name: 'Event',
  displayField: 'title',
  version: 4,
  status: 'published',
  group: 'Programme',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
  ],
};

type Save = (draft: ContentTypeDraft, opts: { expectedVersion: number }) => Promise<void>;

/** The api's answer to a save held to a version that is no longer stored (0: none is). */
const stale = (version: number, expectedVersion: number) =>
  new ApiError(409, `Content type is at version ${version}, not ${expectedVersion}`, {
    error: {
      code: 'conflict',
      message: `Content type is at version ${version}, not ${expectedVersion}`,
      details: { version, expectedVersion },
    },
  });

const saveButton = () => screen.getByRole('button', { name: /Save changes|Create content type/ });
/** Every alert's words: the stale Alert, and a DialogError beside it. */
const alertText = () =>
  screen
    .getAllByRole('alert')
    .map((a) => a.textContent ?? '')
    .join('\n');

function editEvent(onSave: Save, onLoadLatest?: () => Promise<ContentType>) {
  const onOpenChange = vi.fn();
  render(
    <ContentTypeDialog
      open
      onOpenChange={onOpenChange}
      initial={EVENT}
      onSave={onSave}
      {...(onLoadLatest ? { onLoadLatest } : {})}
    />,
  );
  return onOpenChange;
}

describe('the content type dialog and a stale save', () => {
  it('sends the version it opened from, and 0 for a new type', async () => {
    const onSave = vi.fn<Save>(async () => {});
    editEvent(onSave);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[1]).toEqual({ expectedVersion: 4 });
    cleanup();

    const onCreate = vi.fn<Save>(async () => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} onSave={onCreate} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Venue' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[1]).toEqual({ expectedVersion: 0 });
  });

  it('on a 409 keeps the edits, says why, holds Save, copies, and loads the latest in place', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onSave = vi.fn<Save>(async () => {
      throw stale(5, 4);
    });
    const latest: ContentType = { ...EVENT, version: 5, description: 'Theirs' };
    const onLoadLatest = vi.fn(async () => latest);
    const onOpenChange = editEvent(onSave, onLoadLatest);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Mine' } });
    fireEvent.click(saveButton());

    await screen.findByRole('alert');
    expect(alertText()).toContain('This content type changed since you opened it');
    expect(alertText()).toContain('Someone else saved it as v5');
    // Still open, the edit still there: nothing is thrown away until the editor says so.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Mine');
    // Saving again would only be refused again.
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Copy my version as JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(JSON.parse(String(writeText.mock.calls[0]?.[0]))).toMatchObject({
      apiId: 'event',
      description: 'Mine',
      group: 'Programme',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load the latest' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Theirs'),
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    const said = screen.getByText('Loaded v5. Your edits here were discarded.');
    expect(said.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();
    // The next save goes over the version loaded.
    onSave.mockImplementation(async () => {});
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[1]).toEqual({ expectedVersion: 5 });
  });

  it('says a load that failed in the dialog’s error, keeping the form', async () => {
    editEvent(
      vi.fn<Save>(async () => {
        throw stale(5, 4);
      }),
      async () => {
        throw new ApiError(404, 'gone', { error: { code: 'not_found', message: 'Not found' } });
      },
    );
    fireEvent.click(saveButton());
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Load the latest' }));
    await waitFor(() =>
      expect(document.body.textContent).toContain('The latest version couldn’t be loaded'),
    );
    expect(alertText()).toContain('changed since you opened it');
  });

  it('allows that the newer version may be one’s own save that didn’t confirm', async () => {
    const onSave = vi
      .fn<Save>()
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockRejectedValueOnce(stale(5, 4));
    editEvent(onSave, async () => EVENT);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(alertText()).toContain('that may be your own save'));
  });

  it('says a type deleted while open, and creates it again held to none', async () => {
    const onSave = vi.fn<Save>().mockRejectedValueOnce(stale(0, 4)).mockResolvedValueOnce();
    editEvent(onSave, async () => EVENT);
    fireEvent.click(saveButton());
    await screen.findByRole('alert');
    expect(alertText()).toContain('This content type was deleted since you opened it');
    expect(screen.queryByRole('button', { name: 'Load the latest' })).toBeNull();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create it again' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[1]).toEqual({ expectedVersion: 0 });
  });

  it('a new type: a known clash is said beside API ID, one made meanwhile in the Alert', async () => {
    const onSave = vi.fn<Save>().mockRejectedValueOnce(stale(1, 0)).mockResolvedValueOnce();
    render(
      <ContentTypeDialog open onOpenChange={() => {}} onSave={onSave} takenApiIds={['event']} />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Event' } });
    expect(screen.getByText('Another content type has this API ID.')).toBeTruthy();
    expect(screen.getByLabelText('API ID').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();

    // One the list didn't know of yet: the api refuses it.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Venue' } });
    fireEvent.click(saveButton());
    await screen.findByRole('alert');
    expect(alertText()).toContain('There’s already a content type “venue”');
    expect(alertText()).toContain('Give yours another API ID, or copy your edits.');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('API ID'), { target: { value: 'venue2' } });
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0].apiId).toBe('venue2');
  });

  it('after a save that landed but didn’t publish, a retry goes over the version it stored', async () => {
    const onSave = vi
      .fn<Save>()
      .mockRejectedValueOnce(
        new SavedNotPublishedError(
          { ...EVENT, version: 5 },
          'The draft saved but wasn’t published: no',
        ),
      )
      .mockResolvedValueOnce();
    editEvent(onSave);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(document.body.textContent).toContain('The draft saved but wasn’t published'),
    );
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[1]).toEqual({ expectedVersion: 5 });
  });

  it('shows another 409 (a field entries still hold) as the save’s error, not as stale', async () => {
    const onSave = vi.fn<Save>(async () => {
      throw new ApiError(409, 'Cannot remove fields that entries still hold values for', {
        error: {
          code: 'conflict',
          message: 'Cannot remove fields that entries still hold values for',
          details: { fieldsInUse: [] },
        },
      });
    });
    editEvent(onSave, async () => EVENT);
    fireEvent.click(saveButton());
    await screen.findByRole('alert');
    expect(alertText()).toContain('Cannot remove fields');
    expect(screen.queryByRole('button', { name: 'Load the latest' })).toBeNull();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
