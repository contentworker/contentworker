// @vitest-environment jsdom
// What publishing would change, as the confirm card, the page's confirmation and the entries list's
// diff all read it: field names and link titles rather than API ids and JSON, each changed locale,
// unchanged fields behind a disclosure, and honest words when the diff can't be read.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryDiff, reviewFields } from '~/cms/components/entries/EntryReview';
import { PublishConfirm } from '~/cms/components/entries/PublishConfirm';
import { ApiError, type ManagementClient, type PreviewEntry } from '~/cms/lib/management';

const entry = { id: 'e1', contentType: 'article', status: 'changed', fields: {} } as PreviewEntry;
const field = (
  apiId: string,
  name: string | undefined,
  fieldType: string,
  before: unknown,
  after: unknown,
  locale = 'en-US',
) => ({
  field: apiId,
  ...(name ? { name } : {}),
  fieldType,
  kind: JSON.stringify(before) === JSON.stringify(after) ? 'unchanged' : 'changed',
  locales: [
    {
      locale,
      kind: JSON.stringify(before) === JSON.stringify(after) ? 'unchanged' : 'changed',
      before,
      after,
    },
  ],
});

const author = (id: string) => ({ id, linkType: 'Entry' });
const changes = [
  field('author', 'Written by', 'Link', author('a1'), author('a2')),
  field('hero', 'Hero image', 'Link', null, { id: 'as1', linkType: 'Asset' }),
  field('reviewers', 'Reviewers', 'Array', [author('a1')], [author('a1'), author('a3')]),
  field('seo', 'Search', 'Seo', { metaTitle: 'Old' }, { metaTitle: 'New', _key: 'x' }),
  field('data', 'Raw data', 'JSON', { a: 1 }, { a: 2 }),
  field('summary', 'Summary', 'Text', 'Same', 'Same'),
];

const client = {
  diffVersions: vi.fn(),
  getEntry: vi.fn(),
  listEntries: vi.fn(),
  listContentTypes: vi.fn(),
  getAsset: vi.fn(),
};
const asClient = client as unknown as ManagementClient;

beforeEach(() => {
  client.diffVersions.mockReset().mockResolvedValue({ changes });
  client.getEntry.mockReset();
  client.listContentTypes
    .mockReset()
    .mockResolvedValue([{ apiId: 'person', name: 'Person', displayField: 'name', fields: [] }]);
  client.listEntries.mockReset().mockResolvedValue([
    { id: 'a1', contentType: 'person', status: 'published', fields: { name: { 'en-US': 'Ada' } } },
    {
      id: 'a2',
      contentType: 'person',
      status: 'published',
      fields: { name: { 'en-US': 'Grace' } },
    },
  ]);
  client.getAsset.mockReset().mockResolvedValue({
    id: 'as1',
    title: { 'en-US': 'Harbour at dawn' },
    file: { fileName: 'harbour.jpg' },
  });
});

const diffOf = () => render(<EntryDiff client={asClient} entry={entry} locale="en-US" />);

describe('the diff', () => {
  it('counts only what changed, by the field’s name, with its links by title', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    const list = screen.getByRole('list', { name: 'Changes' });
    expect(within(list).getByText('Written by')).toBeTruthy();
    expect(within(list).queryByText('author')).toBeNull();
    expect(within(list).getAllByText('Ada').length).toBe(2);
    expect(within(list).getByText('Grace')).toBeTruthy();
    expect(within(list).getByText('Harbour at dawn')).toBeTruthy();
    expect(within(list).getByText('Ada, Linked entry')).toBeTruthy();
    expect(list.textContent).not.toContain('linkType');
    expect(list.textContent).not.toContain('a2');
    // One request for every linked entry, however many fields link them.
    expect(client.listEntries).toHaveBeenCalledOnce();
  });

  it('reads a group of fields line by line, and leaves a JSON field its JSON', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    expect(screen.getByText('Meta title: Old')).toBeTruthy();
    expect(screen.queryByText(/_key/)).toBeNull();
    expect(screen.getByText(/"a": 2/)).toBeTruthy();
  });

  it('labels every value, so stacked they still say which is which', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    const row = screen.getAllByRole('listitem')[0] as HTMLElement;
    expect(within(row).getByText('Published').nextSibling?.textContent).toBe('Ada');
    expect(within(row).getByText('Draft').nextSibling?.textContent).toBe('Grace');
  });

  it('keeps unchanged fields behind a disclosure', async () => {
    diffOf();
    await screen.findByText('5 fields changed');
    expect(screen.queryByText('Same')).toBeNull();
    const more = screen.getByRole('button', { name: 'Show 1 unchanged field' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'Unchanged fields' }).textContent).toContain('Same');
    expect(more.textContent).toBe('Hide unchanged fields');
  });

  it('says a link it couldn’t resolve is a link, never its id', async () => {
    client.listEntries.mockRejectedValue(new Error('down'));
    client.getAsset.mockRejectedValue(new Error('down'));
    diffOf();
    await screen.findByText('5 fields changed');
    expect(screen.getAllByText('Linked entry').length).toBe(3);
    expect(screen.getByText('Linked entry, Linked entry')).toBeTruthy();
    expect(screen.getByText('Linked asset')).toBeTruthy();
  });

  it('says an entry never published has nothing to compare', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(404, 'EntryVersion not found'));
    client.getEntry.mockResolvedValue({ ...entry, status: 'draft' });
    diffOf();
    await screen.findByText('No published version');
  });

  it('says a read that failed failed, not that nothing was published', async () => {
    client.diffVersions.mockRejectedValue(new ApiError(500, 'boom'));
    diffOf();
    await screen.findByText('Couldn’t load what changed');
    expect(screen.queryByText('No published version')).toBeNull();
  });
});

describe('reviewFields', () => {
  it('shows each locale that changed, and names it only when there are several', () => {
    const two = {
      field: 'title',
      name: 'Title',
      fieldType: 'Symbol',
      kind: 'changed',
      locales: [
        { locale: 'de-DE', kind: 'unchanged', before: 'Alt', after: 'Alt' },
        { locale: 'en-US', kind: 'changed', before: 'Old', after: 'New' },
      ],
    } as never;
    expect(reviewFields([two], 'en-US')[0]?.rows).toEqual([
      { locale: 'en-US', before: 'Old', after: 'New' },
    ]);
  });

  it('names a field the content type no longer declares by its humanized id', () => {
    const gone = field('old_note', undefined, 'Text', 'a', 'b') as never;
    expect(reviewFields([gone], 'en-US')[0]?.name).toBe('Old note');
  });

  it('treats a field added with nothing in it as unchanged', () => {
    const empty = {
      field: 'note',
      kind: 'added',
      locales: [{ locale: 'en-US', kind: 'unchanged', after: null }],
    } as never;
    expect(reviewFields([empty], 'en-US')[0]?.kind).toBe('unchanged');
  });
});

describe('the page’s confirmation', () => {
  const dialog = (props: Partial<Parameters<typeof PublishConfirm>[0]> = {}) =>
    render(
      <PublishConfirm
        open
        onOpenChange={vi.fn()}
        title="Pricing"
        status="changed"
        compare={{ client: asClient, entry, locale: 'en-US' }}
        busy={false}
        onConfirm={vi.fn()}
        {...props}
      />,
    );

  it('makes its scroller reachable by keyboard, with a name', async () => {
    dialog();
    await screen.findByText('5 fields changed');
    const region = screen.getByRole('region', { name: 'What changes' });
    expect(region.tabIndex).toBe(0);
    expect(within(region).getByText('Grace')).toBeTruthy();
  });

  it('reviews the editor’s own diff without reading it again', async () => {
    const known = [changes[0]] as never;
    dialog({ changes: known });
    await screen.findByText('Grace');
    expect(screen.getByText('1 field goes live:')).toBeTruthy();
    expect(screen.queryByText('1 field changed')).toBeNull();
    expect(client.diffVersions).not.toHaveBeenCalled();
  });

  it('shows no comparison for a first publish, or when nothing changed', () => {
    const first = dialog({ status: 'draft' });
    expect(screen.queryByRole('region', { name: 'What changes' })).toBeNull();
    expect(client.diffVersions).not.toHaveBeenCalled();
    first.unmount();
    dialog({ changes: [] });
    expect(screen.queryByRole('region', { name: 'What changes' })).toBeNull();
  });
});
