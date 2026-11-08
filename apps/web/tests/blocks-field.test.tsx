// @vitest-environment jsdom
import {
  type BlockCatalog,
  type BlockConfig,
  type ComponentVariant,
  type ContentType,
  type EntryFields,
  effectiveBlockRules,
  type FieldDefinition,
} from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { EntryForm } from '~/cms/components/EntryForm';
import { EntryPreview } from '~/cms/components/EntryPreview';

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

const HERO: ComponentVariant = {
  apiId: 'hero',
  name: 'Hero',
  fields: [field({ apiId: 'heading', name: 'Heading', required: true })],
};
const CTA: ComponentVariant = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [
    field({ apiId: 'label', name: 'Label', required: true }),
    field({ apiId: 'style', name: 'Style', position: 1, defaultValue: 'primary' }),
  ],
};

const blocksField = (variants: ComponentVariant[], over: Partial<FieldDefinition> = {}) =>
  field({
    apiId: 'body',
    name: 'Body',
    type: 'Array',
    position: 1,
    items: { type: 'Component', variants },
    ...over,
  });

const typeWith = (fields: FieldDefinition[]): ContentType => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'name',
  version: 1,
  status: 'published',
  fields: [field({ apiId: 'name', name: 'Name' }), ...fields],
});

const PAGE = typeWith([blocksField([HERO, CTA])]);

function renderForm(contentType: ContentType, initial = {}, onSave = vi.fn()) {
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

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
const savedBody = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls[0]?.[0].body['en-US'];

/** Opens the "Add block" menu (Radix opens on pointerdown) and picks a block type. */
async function addBlock(name: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Add block to Body' }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

describe('editing a blocks field', () => {
  it('says when there are no blocks yet', () => {
    renderForm(PAGE);
    expect(screen.getByText('No blocks yet.')).toBeTruthy();
  });

  it('adds a block of the type picked, starting from its defaults, keyed as it is added', async () => {
    const onSave = renderForm(PAGE);
    await addBlock('Call to action');
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Go' } });
    save();
    // The key is minted in the form, so live preview can address the block before it is saved.
    expect(savedBody(onSave)).toEqual([
      {
        _type: 'cta',
        _key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        style: 'primary',
        label: 'Go',
      },
    ]);
  });

  it('keys each block it adds apart, and names each item by its block', async () => {
    const onSave = renderForm(PAGE);
    await addBlock('Call to action');
    await addBlock('Call to action');
    for (const label of screen.getAllByLabelText(/^Label/)) {
      fireEvent.change(label, { target: { value: 'Go' } });
    }
    save();
    const keys = savedBody(onSave).map((b: { _key: string }) => b._key);
    expect(new Set(keys).size).toBe(2);
    expect(screen.getByRole('group', { name: 'Call to action block 2' })).toBeTruthy();
  });

  it("edits each block with its own type's fields and keeps _type and _key", () => {
    const onSave = renderForm(PAGE, {
      body: {
        'en-US': [
          { _type: 'hero', _key: 'k1', heading: 'Hi' },
          { _type: 'cta', _key: 'k2', label: 'Go' },
        ],
      },
    });
    expect(screen.getByLabelText(/^Heading/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Read more' } });
    save();
    expect(savedBody(onSave)).toEqual([
      { _type: 'hero', _key: 'k1', heading: 'Hi' },
      { _type: 'cta', _key: 'k2', label: 'Read more' },
    ]);
  });

  it('reorders and removes the block each control names', () => {
    const onSave = renderForm(PAGE, {
      body: {
        'en-US': [
          { _type: 'hero', _key: 'k1', heading: 'Hi' },
          { _type: 'cta', _key: 'k2', label: 'Go' },
          { _type: 'cta', _key: 'k3', label: 'More' },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move Call to action block 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Call to action block 3' }));
    save();
    expect(savedBody(onSave).map((b: { _key: string }) => b._key)).toEqual(['k2', 'k1']);
  });

  it('names the block, by type, in the error summary', () => {
    const onSave = renderForm(PAGE, {
      name: { 'en-US': 'Home' },
      body: { 'en-US': [{ _type: 'cta', label: 'Go' }, { _type: 'hero' }] },
    });
    save();
    expect(onSave).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/Body 2 \(Hero\) › Heading/)).toBeTruthy();
  });

  it('shows a block of an unknown type without an editor, and lets it be removed', () => {
    const onSave = renderForm(PAGE, {
      name: { 'en-US': 'Home' },
      body: {
        'en-US': [
          { _type: 'quote', _key: 'q', text: 'x' },
          { _type: 'hero', heading: 'Hi' },
        ],
      },
    });
    expect(screen.getByText(/type “quote” is not in the content model/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Unknown block 1' }));
    save();
    expect(savedBody(onSave)).toEqual([{ _type: 'hero', heading: 'Hi' }]);
  });

  it('turns adding off at size.max, and offers a single type as a plain button', () => {
    renderForm(typeWith([blocksField([HERO], { validations: { size: { max: 1 } } })]), {
      body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] },
    });
    const add = screen.getByRole('button', { name: 'Add hero' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText('Holds one block.')).toBeTruthy();
  });
});

describe('a blocks field under the block config', () => {
  const QUOTE: ComponentVariant = {
    apiId: 'quote',
    name: 'Quote',
    fields: [field({ apiId: 'text', name: 'Text' })],
  };
  const CARD: ComponentVariant = {
    apiId: 'card',
    name: 'Card',
    fields: [field({ apiId: 'title', name: 'Title' })],
  };
  const SECTION: ComponentVariant = {
    apiId: 'section',
    name: 'Section',
    fields: [
      field({
        apiId: 'items',
        name: 'Items',
        type: 'Array',
        items: { type: 'Component', variants: [CARD] },
      }),
    ],
  };
  const TYPE = typeWith([blocksField([HERO, CTA, QUOTE, SECTION])]);
  const catalog = {
    version: 3,
    hash: 'h',
    pushedAt: '2026-11-01T00:00:00Z',
    pushedBy: null,
    changes: { added: [], changed: [], removed: [], renamed: [] },
    targets: [{ contentTypeApiId: 'page', field: 'body' }],
    blocks: [
      { id: 'hero', name: 'Hero', fields: [] },
      { id: 'cta', name: 'Call to action', fields: [] },
      { id: 'quote', name: 'Quote', fields: [] },
      {
        id: 'section',
        name: 'Section',
        fields: [],
        slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'] }],
      },
      { id: 'card', name: 'Card', allowedParents: ['section'], fields: [] },
    ],
  } as unknown as BlockCatalog;
  const rulesOf = (over: Partial<BlockConfig>) =>
    effectiveBlockRules(catalog, { version: 1, targets: [], blocks: [], ...over });
  const STORED: EntryFields = {
    body: {
      'en-US': [
        { _type: 'cta', _key: 'a1', label: 'Start' },
        { _type: 'section', _key: 's1', items: [{ _type: 'card', _key: 'c1', title: 'One' }] },
      ],
    },
  };

  function renderUnder(
    over: Partial<BlockConfig>,
    opts: {
      stored?: EntryFields;
      onSave?: (fields: EntryFields) => void;
      serverIssues?: Parameters<typeof EntryForm>[0]['serverIssues'];
    } = {},
  ) {
    const onSave = opts.onSave ?? vi.fn<(fields: EntryFields) => void>();
    const props = {
      contentType: TYPE,
      initial: opts.stored ?? {},
      locales: ['en-US'],
      defaultLocale: 'en-US',
      pickers: { entries: [], assets: [] },
      blockRules: { rules: rulesOf(over), catalog, stored: opts.stored },
      onSave,
      onCancel: () => {},
    };
    const view = render(<EntryForm {...props} serverIssues={opts.serverIssues ?? null} />);
    return {
      onSave,
      rerender: (serverIssues: Parameters<typeof EntryForm>[0]['serverIssues']) =>
        view.rerender(<EntryForm {...props} serverIssues={serverIssues} />),
    };
  }

  it('offers in Add only the blocks the narrowed rule takes, and keeps a stored one editable', async () => {
    renderUnder(
      { targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'quote'] }] },
      { stored: STORED },
    );
    // The stored call to action is still there, editable, and can be moved or removed.
    expect((screen.getByLabelText(/^Label/) as HTMLInputElement).value).toBe('Start');
    expect(screen.getByRole('button', { name: 'Remove Call to action block 1' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add block to Body' }), {
      button: 0,
      ctrlKey: false,
    });
    const offered = (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
    expect(offered).toEqual(['Hero', 'Quote']);
  });

  it('offers a single allowed block as a plain button, capped at the config’s most', () => {
    renderUnder(
      {
        targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['cta', 'section'], max: 2 }],
      },
      { stored: STORED },
    );
    // The section's slot takes cards only.
    expect(screen.getByRole('button', { name: 'Add card' })).toBeTruthy();
    // Two of two: full.
    expect(
      (screen.getByRole('button', { name: 'Add block to Body' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Holds up to 2 blocks.')).toBeTruthy();
  });

  it('keeps a locked field’s blocks in place, and what’s inside them editable', () => {
    const onSave = vi.fn();
    renderUnder(
      { targets: [{ contentTypeApiId: 'page', field: 'body', locked: true }] },
      { stored: STORED, onSave },
    );
    expect(screen.getByText(/Body is locked: its blocks stay as they are/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add block to Body' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove Call to action/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move Call to action/ })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: 'Begin' } });
    save();
    expect(onSave).toHaveBeenCalled();
  });

  it('locks a block’s slot only once it is stored', () => {
    const lock = { blocks: [{ block: 'section', slots: { items: { locked: true } } }] };
    renderUnder(lock, { stored: STORED });
    expect(screen.getByText(/Items is locked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add card' })).toBeNull();
    cleanup();
    // A new entry has nothing stored: its section's items are filled as they come.
    renderUnder(lock, { stored: undefined });
    expect(screen.queryByText(/is locked/)).toBeNull();
  });

  it('refuses before saving what the config won’t take, on the field', () => {
    const onSave = vi.fn();
    renderUnder(
      { targets: [{ contentTypeApiId: 'page', field: 'body', min: 2 }] },
      {
        stored: STORED,
        onSave,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Call to action block 1' }));
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText('This slot holds at least 2 blocks').length).toBeGreaterThan(0);
  });

  it('shows the server’s refusal on the field it names', () => {
    const { rerender } = renderUnder({}, { stored: STORED });
    rerender({
      seq: 1,
      issues: [
        {
          field: 'body',
          locale: 'en-US',
          message:
            'This slot is locked: its blocks can’t be added, removed, moved, reordered or swapped',
        },
      ],
    });
    expect(
      screen.getAllByText(/This slot is locked: its blocks can’t be added/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('Body (en-US)');
  });
});

describe('previewing blocks', () => {
  it('draws each block under its type name', () => {
    render(
      <EntryPreview
        contentType={PAGE}
        fields={{
          name: { 'en-US': 'Home' },
          body: {
            'en-US': [
              { _type: 'hero', heading: 'Big news' },
              { _type: 'cta', label: 'Go' },
            ],
          },
        }}
        locale="en-US"
        localeConfig={{ defaultLocale: 'en-US', locales: ['en-US'] }}
        pickers={{ entries: [], assets: [] }}
      />,
    );
    expect(screen.getByText('Hero')).toBeTruthy();
    expect(screen.getByText('Big news')).toBeTruthy();
    expect(screen.getByText('Call to action')).toBeTruthy();
  });
});

describe('authoring block types in the content type dialog', () => {
  const renderDialog = (initial: ContentType, onSave = vi.fn(async () => {})) => {
    render(<ContentTypeDialog open onOpenChange={() => {}} initial={initial} onSave={onSave} />);
    return onSave;
  };
  const saved = async (onSave: ReturnType<typeof vi.fn>) => {
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return (onSave.mock.calls[0]?.[0] as { fields: FieldDefinition[] } | undefined)?.fields ?? [];
  };

  it('loads the block types and saves them back unchanged', async () => {
    const onSave = renderDialog(PAGE);
    expect(screen.getByDisplayValue('Call to action')).toBeTruthy();
    const body = (await saved(onSave)).find((f) => f.apiId === 'body');
    expect(body?.items?.variants?.map((v) => v.apiId)).toEqual(['hero', 'cta']);
    expect(body?.items?.fields).toBeUndefined();
    // What the editor doesn't show rides along.
    expect(body?.items?.variants?.[1]?.fields[1]?.defaultValue).toBe('primary');
  });

  it('adds a block type with a field', async () => {
    const onSave = renderDialog(PAGE);
    fireEvent.click(screen.getByRole('button', { name: /add block type/i }));
    fireEvent.change(screen.getByLabelText('Name for block type 3 of Body'), {
      target: { value: 'Quote' },
    });
    fireEvent.change(screen.getByLabelText('Name for field 1 of Quote'), {
      target: { value: 'Text' },
    });
    fireEvent.change(screen.getByLabelText('Type for Text in Quote'), {
      target: { value: 'Text' },
    });
    const body = (await saved(onSave)).find((f) => f.apiId === 'body');
    expect(body?.items?.variants?.[2]).toEqual({
      apiId: 'quote',
      name: 'Quote',
      fields: [
        {
          apiId: 'text',
          name: 'Text',
          type: 'Text',
          localized: false,
          required: false,
          position: 0,
        },
      ],
    });
  });

  it('gives a link field in a block its target', async () => {
    const onSave = renderDialog(PAGE);
    fireEvent.click(screen.getByRole('button', { name: /add field to call to action/i }));
    fireEvent.change(screen.getByLabelText('Name for field 3 of Call to action'), {
      target: { value: 'Target' },
    });
    fireEvent.change(screen.getByLabelText('Type for Target in Call to action'), {
      target: { value: 'Link' },
    });
    fireEvent.change(screen.getByLabelText('Link target for Target in Call to action'), {
      target: { value: 'Asset' },
    });
    const cta = (await saved(onSave)).find((f) => f.apiId === 'body')?.items?.variants?.[1];
    expect(cta?.fields[2]).toMatchObject({ apiId: 'target', type: 'Link', linkType: 'Asset' });
  });

  it('refuses to save a block type with no fields, saying which', async () => {
    const onSave = renderDialog(PAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Heading from Hero' }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Body › Hero: add at least one field.')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('offers Blocks as a field type', async () => {
    renderDialog(typeWith([]));
    fireEvent.click(screen.getAllByRole('combobox', { name: /^Type for/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Blocks');
  });
});
