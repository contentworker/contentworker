// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

/**
 * A blocks field a catalog push wrote carries what this dialog never edits: its breakpoints and
 * each block's `responsive` props and former ids. Saving the type here keeps them, so an edit in
 * the admin never strands the entries' per-breakpoint overrides.
 */
const prop = (apiId: string, over: Partial<FieldDefinition> = {}): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

const BREAKPOINTS = [
  { id: 'md', name: 'Tablet', minWidth: 768 },
  { id: 'lg', name: 'Desktop', minWidth: 1280 },
];

const PAGE: ContentType = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  version: 2,
  status: 'published',
  fields: [
    prop('title', { localized: true }),
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: false,
      required: false,
      position: 1,
      items: {
        type: 'Component',
        breakpoints: BREAKPOINTS,
        variants: [
          {
            apiId: 'hero',
            name: 'Hero',
            aliases: ['banner'],
            responsive: ['size'],
            fields: [prop('size', { validations: { in: ['sm', 'xl'] } }), prop('heading')],
          },
        ],
      },
    },
  ],
};

describe('saving a catalog-targeted type in the dialog', () => {
  it('keeps the field’s breakpoints and each block’s responsive props and aliases', async () => {
    const onSave = vi.fn(async () => {});
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={PAGE} onSave={onSave} />);
    // An edit the dialog does make, elsewhere in the type.
    fireEvent.change(screen.getByDisplayValue('Page'), { target: { value: 'Landing page' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const fields = (onSave.mock.calls[0] as unknown as [{ fields: FieldDefinition[] }])[0].fields;
    const body = fields.find((f) => f.apiId === 'body');
    expect(body?.items?.breakpoints).toEqual(BREAKPOINTS);
    expect(body?.items?.variants?.[0]).toMatchObject({
      apiId: 'hero',
      aliases: ['banner'],
      responsive: ['size'],
    });
  });
});
