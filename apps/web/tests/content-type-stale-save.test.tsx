// @vitest-environment jsdom
import type { ContentType, ContentTypeDraft } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
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

/** The api's answer to a save held to a version someone has saved over. */
const stale = (version: number, expectedVersion: number) =>
  new ApiError(409, `Content type "event" is at version ${version}, not ${expectedVersion}`, {
    error: {
      code: 'conflict',
      message: `Content type "event" is at version ${version}, not ${expectedVersion}`,
      details: { version, expectedVersion },
    },
  });

describe('the content type dialog and a stale save', () => {
  it('sends the version it opened from, and 0 for a new type', async () => {
    const onSave = vi.fn(async (_d: ContentTypeDraft, _o: { expectedVersion: number }) => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={EVENT} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[1]).toEqual({ expectedVersion: 4 });
    cleanup();

    const onCreate = vi.fn(async (_d: ContentTypeDraft, _o: { expectedVersion: number }) => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} onSave={onCreate} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Venue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create content type' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[1]).toEqual({ expectedVersion: 0 });
  });

  it('on a 409 keeps the dialog open with the edits, says why, and offers copy and load', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onOpenChange = vi.fn();
    const onSave = vi.fn(async () => {
      throw stale(5, 4);
    });
    const onLoadLatest = vi.fn(async () => {});
    render(
      <ContentTypeDialog
        open
        onOpenChange={onOpenChange}
        initial={EVENT}
        onSave={onSave}
        onLoadLatest={onLoadLatest}
      />,
    );
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This content type changed since you opened it');
    expect(alert.textContent).toContain('v5');
    // Still open, the edit still there: nothing is thrown away until the editor says so.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Mine');

    fireEvent.click(screen.getByRole('button', { name: 'Copy my changes as JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(JSON.parse(String((writeText.mock.calls[0] as unknown[])[0]))).toMatchObject({
      apiId: 'event',
      description: 'Mine',
      group: 'Programme',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load the latest' }));
    await waitFor(() => expect(onLoadLatest).toHaveBeenCalledTimes(1));
  });

  it('shows another 409 (a field entries still hold) as the save’s error, not as stale', async () => {
    const onSave = vi.fn(async () => {
      throw new ApiError(409, 'Cannot remove fields that entries still hold values for', {
        error: {
          code: 'conflict',
          message: 'Cannot remove fields that entries still hold values for',
          details: { fieldsInUse: [] },
        },
      });
    });
    render(
      <ContentTypeDialog
        open
        onOpenChange={() => {}}
        initial={EVENT}
        onSave={onSave}
        onLoadLatest={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Cannot remove fields');
    expect(screen.queryByRole('button', { name: 'Load the latest' })).toBeNull();
  });
});
