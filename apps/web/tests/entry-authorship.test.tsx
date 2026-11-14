// @vitest-environment jsdom
// Who wrote an entry, in the editor's details: names when the team is known, "You" for the
// signed-in person, the kind of writer otherwise, and never a raw id.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryAuthorship } from '~/cms/components/entries/EntryAuthorship';
import { entryQueryParams } from '~/cms/lib/management';

afterEach(cleanup);

const people = [
  { id: 'u-ada', email: 'ada@example.com', name: 'Ada Lovelace' },
  { id: 'u-grace', email: 'grace@example.com' },
];

describe('EntryAuthorship', () => {
  it('names who created the entry and when, and who changed it last and how long ago', () => {
    render(
      <EntryAuthorship
        authorship={{
          createdAt: '2026-05-01T09:00:00.000Z',
          createdBy: 'u-ada',
          updatedBy: 'u-me',
          updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        }}
        directory={{ me: 'u-me', people }}
      />,
    );
    const list = screen.getByText('Created by').closest('dl') as HTMLElement;
    const created = within(list).getByText('Created by').nextElementSibling as HTMLElement;
    expect(created.textContent).toMatch(/^Ada Lovelace · /);
    expect(created.querySelector('time')?.textContent).toContain('2026');
    const edited = within(list).getByText('Last edited by').nextElementSibling as HTMLElement;
    expect(edited.textContent).toMatch(/^You · 3h ago$/);
    expect(edited.querySelector('time')?.getAttribute('title')).toBeTruthy();
    // A long name wraps rather than being clipped.
    expect(list.querySelector('.truncate')).toBeNull();
    // Its own card, not a fold-away panel.
    expect(list.closest('[data-slot="card"]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says only when for a writer that wasn’t recorded (seeded, imported), never “Unknown”', () => {
    render(
      <EntryAuthorship
        authorship={{
          createdAt: '2026-05-01T09:00:00.000Z',
          createdBy: null,
          updatedBy: null,
          updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        }}
      />,
    );
    expect(screen.queryByText('Created by')).toBeNull();
    const created = screen.getByText('Created').nextElementSibling as HTMLElement;
    expect(created.querySelector('time')?.textContent).toContain('2026');
    expect(created.textContent).not.toContain('·');
    expect(screen.getByText('Last edited').nextElementSibling?.textContent).toBe('3h ago');
    expect(screen.queryByText(/Unknown/)).toBeNull();
  });

  it('keeps the line it knows and leaves out the one it doesn’t', () => {
    render(
      <EntryAuthorship
        authorship={{ createdAt: null, createdBy: null, updatedBy: 'u-me' }}
        directory={{ me: 'u-me' }}
      />,
    );
    expect(screen.queryByText(/^Created/)).toBeNull();
    expect(screen.getByText('Last edited by').nextElementSibling?.textContent).toBe('You');
  });

  it('draws nothing when neither writer nor date was recorded', () => {
    const { container } = render(
      <EntryAuthorship authorship={{ createdAt: null, createdBy: null, updatedBy: null }} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('the Mine filter on the wire', () => {
  it('asks the api for sys.createdBy=me', () => {
    expect(entryQueryParams({ mine: true }).get('sys.createdBy')).toBe('me');
    expect(entryQueryParams({}).has('sys.createdBy')).toBe(false);
  });
});
