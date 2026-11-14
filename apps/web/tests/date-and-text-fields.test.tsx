// @vitest-environment jsdom
// A Date field shows what it stores, whatever ISO shape that is, and a save never clears or bends a
// date nobody touched; a long Text field grows with its text rather than cutting it off.
import type { ContentType, DateFormat, EntryFields, FieldDefinition } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dateFromInput, dateInputValue, EntryForm, textRows } from '~/cms/components/EntryForm';

afterEach(cleanup);

const typeWith = (over: Partial<FieldDefinition>): ContentType => ({
  apiId: 'event',
  name: 'Event',
  displayField: 'name',
  version: 1,
  status: 'published',
  fields: [
    { apiId: 'name', name: 'Name', type: 'Symbol', localized: false, required: false, position: 0 },
    {
      apiId: 'when',
      name: 'When',
      type: 'Date',
      localized: false,
      required: false,
      position: 1,
      ...over,
    },
  ],
});

function renderForm(contentType: ContentType, initial: EntryFields = {}) {
  const onSave = vi.fn();
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

const input = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
const saved = (onSave: ReturnType<typeof vi.fn>, apiId = 'when') =>
  onSave.mock.calls[0]?.[0][apiId]?.['en-US'];

describe('a Date field with no format', () => {
  const STORED = '2026-11-15T09:00:00.000Z';

  it('shows the day of a stored date and time, not an empty picker', () => {
    renderForm(typeWith({}), { when: { 'en-US': STORED } });
    expect(input(/When/).type).toBe('date');
    expect(input(/When/).value).toBe('2026-11-15');
  });

  it('saves an untouched date exactly as it was stored', () => {
    const onSave = renderForm(typeWith({}), {
      name: { 'en-US': 'Launch' },
      when: { 'en-US': STORED },
    });
    fireEvent.change(input(/Name/), { target: { value: 'Launch day' } });
    save();
    expect(saved(onSave)).toBe(STORED);
  });

  it('keeps the stored time when only the day is changed', () => {
    const onSave = renderForm(typeWith({}), { when: { 'en-US': STORED } });
    fireEvent.change(input(/When/), { target: { value: '2026-11-20' } });
    save();
    expect(saved(onSave)).toBe('2026-11-20T09:00:00.000Z');
  });

  it('stores a plain date when it held one, and nothing once emptied', () => {
    const onSave = renderForm(typeWith({}), { when: { 'en-US': '2026-11-15' } });
    expect(input(/When/).value).toBe('2026-11-15');
    fireEvent.change(input(/When/), { target: { value: '2026-12-01' } });
    save();
    expect(saved(onSave)).toBe('2026-12-01');
    cleanup();
    const cleared = renderForm(typeWith({}), { when: { 'en-US': STORED } });
    fireEvent.change(input(/When/), { target: { value: '' } });
    save();
    expect(saved(cleared)).toBeUndefined();
  });
});

describe('a Date field with a format', () => {
  it('shows a date and time to the minute, and stores what the input says once edited', () => {
    const onSave = renderForm(typeWith({ format: 'datetime' }), {
      when: { 'en-US': '2026-11-03T14:30:15Z' },
    });
    expect(input(/When/).type).toBe('datetime-local');
    expect(input(/When/).value).toBe('2026-11-03T14:30');
    fireEvent.change(input(/When/), { target: { value: '2026-11-04T08:00' } });
    save();
    expect(saved(onSave)).toBe('2026-11-04T08:00');
  });

  it('shows a time of day, seconds kept', () => {
    renderForm(typeWith({ format: 'time' }), { when: { 'en-US': '09:15:30' } });
    expect(input(/When/).type).toBe('time');
    expect(input(/When/).value).toBe('09:15:30');
  });

  it('saves an untouched date of each format as stored', () => {
    const onSave = renderForm(typeWith({ format: 'date' }), {
      name: { 'en-US': 'Launch' },
      when: { 'en-US': '2026-11-15' },
    });
    fireEvent.change(input(/Name/), { target: { value: 'Launch day' } });
    save();
    expect(saved(onSave)).toBe('2026-11-15');
  });
});

describe('what a date input shows of a stored value', () => {
  const cases: [unknown, DateFormat | undefined, string][] = [
    ['2026-11-15T09:00:00.000Z', undefined, '2026-11-15'],
    ['2026-11-15T23:30:00-05:00', undefined, '2026-11-15'],
    ['2026-11-15', 'date', '2026-11-15'],
    ['2026-11-15T09:00:00.000Z', 'datetime', '2026-11-15T09:00'],
    ['09:15', 'time', '09:15'],
    ['2026-11-15T09:15:30Z', 'time', '09:15:30'],
    ['not a date', undefined, ''],
    [42, undefined, ''],
  ];
  it.each(cases)('%j (%s) shows %j', (stored, format, shown) => {
    expect(dateInputValue(stored, format)).toBe(shown);
  });

  it('stores a picked day with the stored time only where the field takes any ISO date', () => {
    expect(dateFromInput('2026-11-20', '2026-11-15T09:00:00Z', undefined)).toBe(
      '2026-11-20T09:00:00Z',
    );
    expect(dateFromInput('2026-11-20', '2026-11-15', undefined)).toBe('2026-11-20');
    expect(dateFromInput('2026-11-20', undefined, undefined)).toBe('2026-11-20');
    expect(dateFromInput('2026-11-20', '2026-11-15', 'date')).toBe('2026-11-20');
    expect(dateFromInput('', '2026-11-15', undefined)).toBeUndefined();
  });
});

describe('a long Text field', () => {
  const ARTICLE: ContentType = {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    version: 1,
    status: 'published',
    fields: [
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 0 },
    ],
  };

  it('sizes to its text with a ceiling, so a long body is never cut off at a fixed height', () => {
    const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}.`).join('\n');
    renderForm(ARTICLE, { body: { 'en-US': body } });
    const box = screen.getByLabelText(/Body/) as HTMLTextAreaElement;
    expect(box.className).toContain('field-sizing-content');
    expect(box.className).toMatch(/max-h-/);
    expect(box.className).toContain('overflow-y-auto');
    // Where the browser can't size it: a row per line it holds, and one to type into.
    expect(box.rows).toBe(13);
  });

  it('falls back to between 4 and 20 rows', () => {
    expect(textRows('')).toBe(4);
    expect(textRows('one\ntwo\nthree\nfour\nfive')).toBe(6);
    expect(textRows('x\n'.repeat(50))).toBe(20);
  });
});
