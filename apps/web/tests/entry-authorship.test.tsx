// @vitest-environment jsdom
// Who wrote an entry, in the editor's details: names when the team is known, "You" for the
// signed-in person, the kind of writer otherwise, and never a raw id.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryAuthorship } from '~/cms/components/entries/EntryAuthorship';
import { actorLabel } from '~/cms/lib/authorship';
import { entryQueryParams } from '~/cms/lib/management';

afterEach(cleanup);

const people = [
  { id: 'u-ada', email: 'ada@example.com', name: 'Ada Lovelace' },
  { id: 'u-grace', email: 'grace@example.com' },
];

describe('actorLabel', () => {
  it('reads every kind of writer as words', () => {
    const dir = { me: 'u-me', people };
    expect(actorLabel('u-me', dir)).toBe('You');
    expect(actorLabel('u-ada', dir)).toBe('Ada Lovelace');
    expect(actorLabel('u-grace', dir)).toBe('grace@example.com');
    expect(actorLabel('u-unknown', dir)).toBe('A teammate');
    expect(actorLabel('admin-token')).toBe('The admin token');
    expect(actorLabel('cma')).toBe('An API key');
    expect(actorLabel('agent:enrich')).toBe('The enrich agent');
    expect(actorLabel('workflow:0190-wf')).toBe('A workflow');
    expect(actorLabel('plugin:seo')).toBe('A plugin');
    expect(actorLabel('system')).toBe('A schedule');
    expect(actorLabel(null)).toBe('Unknown');
  });
});

describe('EntryAuthorship', () => {
  it('names who created the entry, when, and who changed it last', () => {
    render(
      <EntryAuthorship
        authorship={{
          createdAt: '2026-05-01T09:00:00.000Z',
          createdBy: 'u-ada',
          updatedBy: 'u-me',
        }}
        directory={{ me: 'u-me', people }}
      />,
    );
    const list = screen.getByText('Created by').closest('dl') as HTMLElement;
    expect(within(list).getByText('Created by').nextElementSibling?.textContent).toMatch(
      /^Ada Lovelace · /,
    );
    expect(within(list).getByText('2026', { exact: false }).tagName).toBe('TIME');
    expect(within(list).getByText('Last edited by').nextElementSibling?.textContent).toBe('You');
  });

  it('says Unknown for an entry from before authorship was recorded, with no date', () => {
    render(<EntryAuthorship authorship={{ createdAt: null, createdBy: null, updatedBy: null }} />);
    expect(screen.getByText('Created by').nextElementSibling?.textContent).toBe('Unknown');
    expect(screen.getByText('Last edited by').nextElementSibling?.textContent).toBe('Unknown');
    expect(document.querySelector('time')).toBeNull();
  });
});

describe('the Mine filter on the wire', () => {
  it('asks the api for sys.createdBy=me', () => {
    expect(entryQueryParams({ mine: true }).get('sys.createdBy')).toBe('me');
    expect(entryQueryParams({}).has('sys.createdBy')).toBe(false);
  });
});
