// @vitest-environment jsdom
import type { ContentType, ContentTypeDraft, FieldDefinition } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { EntryForm } from '~/cms/components/EntryForm';
import { ContentTypeIcon } from '~/cms/lib/content-type-icons';
import { groupContentTypes } from '~/cms/routes/ContentLayout';

// jsdom ships neither; radix's Select and Tabs reach for both.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

const field = (over: Partial<FieldDefinition>): FieldDefinition => ({
  apiId: 'x',
  name: 'X',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

const EVENT: ContentType = {
  apiId: 'event',
  name: 'Event',
  displayField: 'title',
  version: 1,
  status: 'published',
  group: 'Programme',
  description: 'Something on the calendar.',
  icon: 'calendar',
  layout: {
    tabs: [
      { apiId: 'main', name: 'Main', groups: [{ fields: ['title', 'day'] }] },
      {
        apiId: 'more',
        name: 'More',
        groups: [
          { name: 'Contact', fields: ['email'], collapsed: true },
          { name: 'Timing', fields: ['at', 'opens'] },
        ],
      },
    ],
  },
  fields: [
    field({ apiId: 'title', name: 'Title' }),
    field({ apiId: 'day', name: 'Day', type: 'Date', format: 'date', position: 1 }),
    field({ apiId: 'email', name: 'Email', position: 2, required: true }),
    field({ apiId: 'at', name: 'Starts', type: 'Date', format: 'datetime', position: 3 }),
    field({ apiId: 'opens', name: 'Doors', type: 'Date', format: 'time', position: 4 }),
    field({
      apiId: 'sizes',
      name: 'Sizes',
      type: 'Array',
      position: 5,
      items: { type: 'Integer' },
    }),
  ],
};

function renderForm(contentType = EVENT, initial = {}, onSave = vi.fn()) {
  render(
    <EntryForm
      contentType={contentType}
      initial={initial}
      locales={['en-US']}
      defaultLocale="en-US"
      pickers={{ entries: [], assets: [] }}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return onSave;
}

describe('the content nav', () => {
  it('lists ungrouped types first, then each group by name', () => {
    const sections = groupContentTypes([
      { apiId: 'b', group: 'Shop' },
      { apiId: 'a' },
      { apiId: 'c', group: 'Docs' },
      { apiId: 'd', group: 'Shop' },
    ]);
    expect(sections.map((s) => [s.group, s.types.map((t) => t.apiId)])).toEqual([
      [undefined, ['a']],
      ['Docs', ['c']],
      ['Shop', ['b', 'd']],
    ]);
  });

  it('draws a known icon, hidden from assistive tech, and nothing for an unknown one', () => {
    const { container } = render(
      <>
        <ContentTypeIcon name="calendar" />
        <ContentTypeIcon name="no-such-icon" />
        <ContentTypeIcon name="constructor" />
        <ContentTypeIcon name="to-string" />
      </>,
    );
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the entry form with a layout', () => {
  it('draws the tabs, a named group, and a collapsed group closed', () => {
    renderForm();
    expect(screen.getByRole('tab', { name: 'Main' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('Day').getAttribute('type')).toBe('date');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'More' }));
    fireEvent.click(screen.getByRole('tab', { name: 'More' }));
    expect(screen.getByRole('region', { name: 'Timing' })).toBeTruthy();
    const contact = screen.getByRole('button', { name: 'Contact' });
    expect(contact.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/Email/)).toBeNull();
    fireEvent.click(contact);
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
  });

  it('a field the layout does not place follows on the first tab', () => {
    renderForm();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('button', { name: 'Add item' })).toBeTruthy();
  });

  it('goes to the tab with an error on a rejected save, and opens its group', async () => {
    const onSave = renderForm();
    fireEvent.submit(screen.getByLabelText('Title').closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /More/ }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('takes a date and time, a time of day and a list of numbers, saved as numbers', () => {
    const onSave = renderForm(EVENT, { email: { 'en-US': 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-11-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.change(screen.getByLabelText('Sizes item 1'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.change(screen.getByLabelText('Sizes item 2'), { target: { value: '14' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'More' }));
    fireEvent.click(screen.getByRole('tab', { name: 'More' }));
    expect(screen.getByLabelText('Starts').getAttribute('type')).toBe('datetime-local');
    expect(screen.getByLabelText('Doors').getAttribute('type')).toBe('time');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-03T14:30' } });
    fireEvent.change(screen.getByLabelText('Doors'), { target: { value: '19:00' } });
    fireEvent.submit(screen.getByLabelText('Starts').closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        day: { 'en-US': '2026-11-03' },
        at: { 'en-US': '2026-11-03T14:30' },
        opens: { 'en-US': '19:00' },
        sizes: { 'en-US': [12, 14] },
      }),
    );
  });

  it('shows a stored date and time with an offset to the minute, and keeps it unless changed', () => {
    const onSave = renderForm(EVENT, {
      email: { 'en-US': 'a@b.co' },
      at: { 'en-US': '2026-11-03T14:30:00Z' },
    });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'More' }));
    fireEvent.click(screen.getByRole('tab', { name: 'More' }));
    expect((screen.getByLabelText('Starts') as HTMLInputElement).value).toBe('2026-11-03T14:30');
    fireEvent.submit(screen.getByLabelText('Starts').closest('form') as HTMLFormElement);
    expect(onSave.mock.calls[0]?.[0].at).toEqual({ 'en-US': '2026-11-03T14:30:00Z' });
  });
});

const ARTICLE: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({
      apiId: 'title',
      name: 'Title',
      validations: { regexp: { pattern: '^x' }, messages: { regexp: 'Start with x' } },
    }),
    field({ apiId: 'day', name: 'Day', type: 'Date', position: 1 }),
    field({
      apiId: 'poster',
      name: 'Poster',
      type: 'Link',
      linkType: 'Asset',
      position: 2,
      validations: { assetMimeTypes: ['image/*'], messages: { assetMimeTypes: 'Images only' } },
    }),
    field({
      apiId: 'sizes',
      name: 'Sizes',
      type: 'Array',
      position: 3,
      items: { type: 'Integer' },
    }),
    field({ apiId: 'opens', name: 'Opens', type: 'Date', format: 'time', position: 4 }),
  ],
};

async function saveDialog(initial: ContentType | undefined, act: () => void) {
  const onSave = vi.fn<(d: ContentTypeDraft) => Promise<void>>(async () => {});
  render(<ContentTypeDialog open onOpenChange={() => {}} initial={initial} onSave={onSave} />);
  act();
  fireEvent.click(screen.getByRole('button', { name: /Save changes|Create content type/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls[0]?.[0] as ContentTypeDraft;
}

const byId = (draft: ContentTypeDraft, apiId: string) =>
  draft.fields.find((f) => f.apiId === apiId) as FieldDefinition;

describe('the content type dialog', () => {
  it('round-trips a type untouched: no layout sent, list and time fields as stored', async () => {
    const draft = await saveDialog(ARTICLE, () => {});
    expect(draft).not.toHaveProperty('layout');
    expect(draft).toMatchObject({ group: null, description: null, icon: null });
    expect(byId(draft, 'sizes').items).toEqual({ type: 'Integer' });
    expect(byId(draft, 'opens').format).toBe('time');
    expect(byId(draft, 'title').validations).toEqual(ARTICLE.fields[0]?.validations);
  });

  it('keeps an icon name it cannot draw, an inherited key included', async () => {
    const draft = await saveDialog({ ...ARTICLE, icon: 'constructor' }, () => {
      expect(screen.getByRole('option', { name: 'constructor (not drawn here)' })).toBeTruthy();
    });
    expect(draft.icon).toBe('constructor');
  });

  it('saves a group, description and icon', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'Editorial' } });
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Long reads' } });
      fireEvent.change(screen.getByLabelText('Icon'), { target: { value: 'newspaper' } });
    });
    expect(draft).toMatchObject({
      group: 'Editorial',
      description: 'Long reads',
      icon: 'newspaper',
    });
  });

  it('builds a layout from tabs and each field’s tab and group', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
      fireEvent.change(screen.getByLabelText('Name of tab 2'), { target: { value: 'Media' } });
      fireEvent.change(screen.getByLabelText('Tab for Title'), { target: { value: 'content' } });
      fireEvent.change(screen.getByLabelText('Tab for Day'), { target: { value: 'content' } });
      fireEvent.change(screen.getByLabelText('Tab for Poster'), { target: { value: 'tab2' } });
      fireEvent.change(screen.getByLabelText('Group for Poster'), { target: { value: 'Art' } });
    });
    expect(draft.layout).toEqual({
      tabs: [
        { apiId: 'content', name: 'Content', groups: [{ fields: ['title', 'day'] }] },
        { apiId: 'tab2', name: 'Media', groups: [{ name: 'Art', fields: ['poster'] }] },
      ],
    });
  });

  it('clears the layout when its last tab goes', async () => {
    const draft = await saveDialog({ ...ARTICLE, layout: EVENT.layout }, () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove tab Main' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove tab More' }));
    });
    expect(draft.layout).toBeNull();
  });

  it('sets a Date format and range, a pattern preset and asset file types', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Day/ }));
      fireEvent.change(screen.getByLabelText('Format for Day'), { target: { value: 'date' } });
      fireEvent.change(screen.getByLabelText('Earliest value for Day'), {
        target: { value: '2026-01-01' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Title/ }));
      fireEvent.change(screen.getByLabelText('Pattern for Title'), { target: { value: 'email' } });
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Poster/ }));
      fireEvent.change(screen.getByLabelText('Allowed file types for Poster'), {
        target: { value: 'image/*, application/pdf' },
      });
    });
    expect(byId(draft, 'day')).toMatchObject({
      format: 'date',
      validations: { dateRange: { min: '2026-01-01' } },
    });
    // The preset replaces the custom pattern; its message stays, since the rule does.
    expect(byId(draft, 'title').validations).toEqual({
      regexp: { preset: 'email' },
      messages: { regexp: 'Start with x' },
    });
    expect(byId(draft, 'poster').validations).toEqual({
      assetMimeTypes: ['image/*', 'application/pdf'],
      messages: { assetMimeTypes: 'Images only' },
    });
  });

  it('drops the message of a rule it clears', async () => {
    const draft = await saveDialog(ARTICLE, () => {
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Title/ }));
      fireEvent.change(screen.getByLabelText('Pattern for Title'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: /^Settings for Poster/ }));
      fireEvent.change(screen.getByLabelText('Allowed file types for Poster'), {
        target: { value: '' },
      });
    });
    expect(byId(draft, 'title').validations).toBeUndefined();
    expect(byId(draft, 'poster').validations).toBeUndefined();
  });

  it('offers a time of day only where the field already holds one', () => {
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={ARTICLE} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Settings for Day/ }));
    const day = within(screen.getByLabelText('Format for Day'));
    expect(day.queryByRole('option', { name: 'Time of day' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Settings for Opens/ }));
    const opens = within(screen.getByLabelText('Format for Opens'));
    expect(opens.getByRole('option', { name: 'Time of day' })).toBeTruthy();
  });
});
