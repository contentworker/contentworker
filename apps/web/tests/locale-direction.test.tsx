// @vitest-environment jsdom
// A locale's text direction in the editor: its values are written in it (`dir` around each
// input), while labels stay in the admin's own direction.
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';

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

const NOTE: ContentType = {
  apiId: 'note',
  name: 'Note',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Title', localized: true }),
    field({ apiId: 'code', name: 'Code', position: 1 }),
  ],
};

describe('EntryForm text direction', () => {
  it('writes each locale in its direction, and the shared fields in the default’s', () => {
    render(
      <EntryForm
        contentType={NOTE}
        initial={{ title: { en: 'Hello', ar: 'مرحبا' }, code: { en: 'A1' } }}
        locales={['en', 'ar']}
        defaultLocale="en"
        directions={{ en: 'ltr', ar: 'rtl' }}
        pickers={{ entries: [], assets: [] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const dirOf = (value: string) =>
      screen.getByDisplayValue(value).closest('[dir]')?.getAttribute('dir');
    expect(dirOf('Hello')).toBe('ltr');
    expect(dirOf('A1')).toBe('ltr');
    fireEvent.click(screen.getByRole('button', { name: 'ar' }));
    expect(dirOf('مرحبا')).toBe('rtl');
    // The label is the admin's, not the value's.
    expect(screen.getByText('Title').closest('[dir]')).toBeNull();
  });

  it('sets no direction while the space config hasn’t said', () => {
    render(
      <EntryForm
        contentType={NOTE}
        initial={{ title: { en: 'Hello' } }}
        locales={['en']}
        defaultLocale="en"
        pickers={{ entries: [], assets: [] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByDisplayValue('Hello').closest('[dir]')).toBeNull();
  });
});
