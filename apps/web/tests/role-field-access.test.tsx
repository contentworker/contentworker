// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';
import {
  type FieldAccess,
  fieldAccessFor,
  OPEN_FIELDS,
  writableFields,
} from '~/cms/lib/field-access';
import type { PrincipalInfo } from '~/cms/lib/management';

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

const LISTING: ContentType = {
  apiId: 'listing',
  name: 'Listing',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Title', required: true }),
    field({ apiId: 'price', name: 'Price', type: 'Number', required: true, position: 1 }),
    field({ apiId: 'notes', name: 'Internal notes', required: true, position: 2 }),
    field({ apiId: 'summary', name: 'Summary', type: 'Text', position: 3 }),
  ],
};

// What the api's `auth/me` says of a role that may change the title and summary of a listing,
// read its price, and not read its notes. The form is handed the entry as the api masks it.
const ME: PrincipalInfo = {
  spaceId: 's1',
  kind: 'user',
  scopes: ['content:write', 'preview:read'],
  restricted: true,
  fieldRules: {
    types: { listing: { deniedFields: ['notes'], readOnlyFields: ['price'] } },
    others: { deniedFields: [], readOnlyFields: [] },
  },
};
const ACCESS = fieldAccessFor(ME, 'listing');
const MASKED = { title: { 'en-US': 'Loft' }, price: { 'en-US': 450000 } };

function renderForm(access: FieldAccess, initial: Record<string, unknown> = MASKED) {
  const onSave = vi.fn();
  render(
    <EntryForm
      contentType={LISTING}
      initial={initial as never}
      locales={['en-US']}
      defaultLocale="en-US"
      pickers={{ entries: [], assets: [] }}
      fieldAccess={access}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return onSave;
}

describe('fieldAccessFor', () => {
  it('reads the type’s own rules, else every other type’s, and is open until access is read', () => {
    expect(ACCESS).toEqual({ hidden: new Set(['notes']), readOnly: new Set(['price']) });
    expect(fieldAccessFor(ME, 'page')).toBe(OPEN_FIELDS);
    expect(fieldAccessFor(undefined, 'listing')).toBe(OPEN_FIELDS);
    // A type named for an Object.prototype member reads `others`, not the prototype.
    expect(fieldAccessFor(ME, 'constructor')).toBe(OPEN_FIELDS);
  });

  it('leaves the hidden and read-only fields out of what a save sends', () => {
    expect(writableFields({ ...MASKED, summary: { 'en-US': 'S' } }, ACCESS)).toEqual({
      title: { 'en-US': 'Loft' },
      summary: { 'en-US': 'S' },
    });
  });
});

describe('the entry form under a role’s field rules', () => {
  it('draws a read-only field read-only with its reason, and never draws a hidden one', () => {
    renderForm(ACCESS);
    const price = screen.getByLabelText(/^Price/) as HTMLInputElement;
    expect(price.readOnly).toBe(true);
    expect(price.getAttribute('aria-readonly')).toBe('true');
    expect(price.value).toBe('450000');
    // The reason is read on focus.
    const reason = screen.getByText('Your role can’t change this field');
    expect(price.getAttribute('aria-describedby')).toContain(reason.id);
    // Drawn read-only (app.css mutes a `data-readonly="role"` field), the lock before its reason
    // left out of what is read.
    expect(price.closest('[data-field="price"]')?.getAttribute('data-readonly')).toBe('role');
    expect(reason.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(reason.textContent).toBe('Your role can’t change this field');
    // Still focusable: it keeps its place in the tab order.
    price.focus();
    expect(document.activeElement).toBe(price);
    // An editable field isn't marked.
    const title = screen.getByLabelText(/^Title/);
    expect(title.closest('[data-field="title"]')?.hasAttribute('data-readonly')).toBe(false);
    expect(screen.queryByLabelText(/Internal notes/)).toBeNull();
    expect(screen.queryByText(/Internal notes/)).toBeNull();
  });

  it('saves an edit to an allowed field, without the read-only or the required hidden field', () => {
    const onSave = renderForm(ACCESS);
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Loft, renovated' } });
    // Typing at a read-only field changes nothing.
    fireEvent.change(screen.getByLabelText(/^Price/), { target: { value: '1' } });
    fireEvent.submit(screen.getByLabelText(/^Title/).closest('form') as HTMLFormElement);
    // No "Field is required" for the hidden notes the api masked, nor for the price it holds.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSave).toHaveBeenCalledWith({ title: { 'en-US': 'Loft, renovated' } });
  });

  it('keeps a read-only field at its stored value when a draft is merged in', () => {
    const { rerender } = render(
      <EntryForm
        contentType={LISTING}
        initial={MASKED as never}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        fieldAccess={ACCESS}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    rerender(
      <EntryForm
        contentType={LISTING}
        initial={MASKED as never}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        fieldAccess={ACCESS}
        mergePatch={{ seq: 1, fields: { price: { 'en-US': 1 }, title: { 'en-US': 'Drafted' } } }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Drafted');
    expect((screen.getByLabelText(/^Price/) as HTMLInputElement).value).toBe('450000');
  });

  it('says a required read-only field that holds nothing is one for someone else (the save would refuse it too)', () => {
    const onSave = renderForm(ACCESS, { title: { 'en-US': 'Loft' } });
    fireEvent.submit(screen.getByLabelText(/^Title/).closest('form') as HTMLFormElement);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Price');
    // Not "Field is required": the person can't fill it.
    expect(
      screen.getAllByText('Required, but your role can’t fill it: ask someone who can').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('Field is required')).toBeNull();
  });

  it('says the role is why a field its rules hide keeps its value', () => {
    const ruled: ContentType = {
      ...LISTING,
      fields: LISTING.fields.map((f) =>
        f.apiId === 'price'
          ? {
              ...f,
              rules: [{ action: 'hide', when: { field: 'title', operator: 'eq', value: 'Loft' } }],
            }
          : f,
      ),
    };
    render(
      <EntryForm
        contentType={ruled}
        initial={MASKED as never}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        fieldAccess={ACCESS}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    // Hidden by its rule while holding a value: no Clear (the save would keep it), and the reason.
    expect(screen.getByText(/keeps the value it holds/).textContent).toMatch(
      /it is read-only: your role can’t change it\.$/,
    );
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
  });

  it('says the same of a required read-only field when the server is the one refusing', () => {
    render(
      <EntryForm
        contentType={LISTING}
        initial={{ title: { 'en-US': 'Loft' } } as never}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        fieldAccess={ACCESS}
        serverIssues={{
          seq: 1,
          issues: [{ field: 'price', locale: 'en-US', message: 'Field is required' }],
        }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText('Field is required')).toBeNull();
    expect(
      screen.getAllByText('Required, but your role can’t fill it: ask someone who can').length,
    ).toBeGreaterThan(0);
  });

  it('keeps read-only rich text in the tab order, saying it is read-only', async () => {
    const withBody: ContentType = {
      ...LISTING,
      fields: [
        ...LISTING.fields,
        field({ apiId: 'body', name: 'Body', type: 'RichText', position: 4 }),
      ],
    };
    render(
      <EntryForm
        contentType={withBody}
        initial={MASKED as never}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        fieldAccess={{ hidden: new Set(['notes']), readOnly: new Set(['price', 'body']) }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const body = await screen.findByRole('textbox', { name: /^Body/ });
    expect(body.getAttribute('contenteditable')).toBe('false');
    expect(body.getAttribute('tabindex')).toBe('0');
    expect(body.getAttribute('aria-readonly')).toBe('true');
    expect(body.closest('[data-field="body"]')?.getAttribute('data-readonly')).toBe('role');
  });

  it('judges and sends every field for a role without field rules', () => {
    const onSave = renderForm(OPEN_FIELDS);
    expect(screen.getByLabelText(/^Internal notes/)).toBeTruthy();
    fireEvent.submit(screen.getByLabelText(/^Title/).closest('form') as HTMLFormElement);
    // The notes are required and empty: nothing masked them, so the form asks for them.
    expect(onSave).not.toHaveBeenCalled();
  });
});
