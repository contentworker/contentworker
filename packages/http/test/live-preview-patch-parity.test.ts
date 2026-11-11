/**
 * A live preview page applies the admin's block patches with sdk-core's loose applier, which has
 * no content type; the server applies them with the domain's `applyBlockPatch`, which does. Were
 * they to disagree on a patch the server accepts, the page would show the editor something other
 * than what saving gives them. This runs the same patches through both and compares the fields,
 * and the domain's applied form (what the admin sends a page) through the SDK once more.
 *
 * It lives here because this package is the one that may import both: the SDK never imports the
 * domain, and the domain imports nothing. It imports the applier's own module, not the
 * `live-preview` entry, whose page runtime needs the DOM this package doesn't compile against.
 */
import {
  applyBlockPatch,
  type BlockOp,
  type ComponentVariant,
  type ContentType,
  defineContentType,
  type EntryFields,
  type FieldDefinition,
} from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import type { LocalizedFields as LiveFields } from '../../sdk/core/src/live-preview/patch';
import {
  applyLivePatch,
  type LivePatchOp,
  type BlockOp as SdkBlockOp,
} from '../../sdk/core/src/live-preview/patch';

// The two op vocabularies are one: each side's ops are the other's.
const toSdk = (ops: readonly BlockOp[]): readonly LivePatchOp[] => ops;
const toDomain = (ops: readonly SdkBlockOp[]): readonly BlockOp[] => ops;

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;
const blocks = (apiId: string, variants: readonly ComponentVariant[], position = 0) =>
  field({ apiId, type: 'Array', position, items: { type: 'Component', variants } });

const HERO: ComponentVariant = {
  apiId: 'hero',
  name: 'Hero',
  fields: [
    field({ apiId: 'heading', type: 'Symbol' }),
    field({ apiId: 'tagline', type: 'Symbol', position: 1 }),
    field({ apiId: 'size', type: 'Symbol', position: 2, validations: { in: ['sm', 'xl'] } }),
  ],
  responsive: ['size'],
};
const CTA: ComponentVariant = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [field({ apiId: 'label', type: 'Symbol' })],
};
const SECTION: ComponentVariant = {
  apiId: 'section',
  name: 'Section',
  fields: [
    field({ apiId: 'title', type: 'Symbol' }),
    blocks('items', [HERO, CTA], 1),
    // Blocks under a plain component: carried along, not addressable.
    field({ apiId: 'aside', type: 'Component', position: 2, fields: [blocks('notes', [CTA])] }),
    // A repeater: components, not blocks, even when its items carry a `_key`.
    field({
      apiId: 'links',
      type: 'Array',
      position: 3,
      items: { type: 'Component', fields: [field({ apiId: 'label', type: 'Symbol' })] },
    }),
  ],
};
// A JSON value can hold anything, block-shaped objects included; the server never reads into it.
const EMBED: ComponentVariant = {
  apiId: 'embed',
  name: 'Embed',
  fields: [field({ apiId: 'data', type: 'JSON' })],
};
const LANDING: ContentType = defineContentType({
  apiId: 'landing',
  name: 'Landing',
  displayField: 'title',
  fields: [
    field({ apiId: 'title', type: 'Symbol' }),
    blocks('body', [HERO, CTA, SECTION, EMBED], 1),
  ],
});

const L = 'en-US';
const at = { field: 'body', locale: L } as const;

// Blocks list their properties in their variant's field order: both appliers mint keys for a
// block before the blocks inside it, the domain in field order, the SDK in property order.
const page = (): EntryFields => ({
  title: { [L]: 'Home' },
  body: {
    [L]: [
      { _type: 'hero', _key: 'h1', heading: 'Welcome' },
      {
        _type: 'section',
        _key: 's1',
        title: 'Features',
        items: [
          { _type: 'hero', _key: 'h2', heading: 'Fast' },
          { _type: 'cta', _key: 'c1', label: 'Try it' },
        ],
        aside: { notes: [{ _type: 'cta', _key: 'n1', label: 'Note' }] },
        links: [{ _key: 'r1', label: 'Docs' }],
      },
      { _type: 'cta', _key: 'c2', label: 'Sign up' },
      {
        _type: 'embed',
        _key: 'e1',
        data: { list: [{ _type: 'cta', _key: 'c1', label: 'not a block' }] },
      },
    ],
  },
});

/** A slot one of whose blocks lost its `_type`: the server still indexes it by its key. */
const untyped = (): EntryFields => ({
  body: {
    [L]: [
      {
        _type: 'section',
        _key: 's1',
        items: [
          { _type: 'hero', _key: 'h2', heading: 'Fast' },
          { _key: 'odd', label: 'no type' },
        ],
      },
    ],
  },
});

const minter = () => {
  let n = 0;
  return () => `k${++n}`;
};

interface Accepted {
  readonly ops: readonly BlockOp[];
  readonly fields?: () => EntryFields;
  /**
   * The raw ops mint keys for blocks under a plain component, which the server rekeys and the page
   * (unable to tell a component from a JSON value) leaves alone. Only the applied form, which
   * carries every key, is compared; the difference itself is pinned below.
   */
  readonly appliedOnly?: true;
}

const ACCEPTED: Record<string, Accepted> = {
  'an insert at the end, keyed here': {
    ops: [{ op: 'insert', ...at, block: { _type: 'cta', label: 'More' } }],
  },
  'an insert at an index, keeping its key': {
    ops: [
      { op: 'insert', ...at, index: 0, block: { _type: 'hero', _key: 'mine', heading: 'Top' } },
    ],
  },
  'an insert into a slot, before a sibling': {
    ops: [
      {
        op: 'insert',
        ...at,
        parent: { key: 's1', slot: 'items' },
        before: 'c1',
        block: { _type: 'cta', label: 'Between' },
      },
    ],
  },
  'an insert with blocks in its slots, all keyed here': {
    ops: [
      {
        op: 'insert',
        ...at,
        after: 'h1',
        block: {
          _type: 'section',
          title: 'New',
          items: [
            { _type: 'hero', heading: 'A' },
            { _type: 'cta', label: 'B' },
          ],
        },
      },
    ],
  },
  'an insert with blocks under a plain component': {
    ops: [
      {
        op: 'insert',
        ...at,
        block: { _type: 'section', title: 'New', aside: { notes: [{ _type: 'cta', label: 'C' }] } },
      },
    ],
    appliedOnly: true,
  },
  'a ref, used by later ops, into a slot that is not there yet': {
    ops: [
      { op: 'insert', ...at, ref: 'fresh', block: { _type: 'section', title: 'Empty' } },
      {
        op: 'insert',
        ...at,
        parent: { key: 'fresh', slot: 'items' },
        block: { _type: 'hero', heading: 'Inside' },
      },
      { op: 'update', ...at, key: 'fresh', set: { title: 'Filled' } },
      { op: 'move', ...at, key: 'fresh', to: { index: 0 } },
    ],
  },
  'an update that sets and unsets': {
    ops: [{ op: 'update', ...at, key: 'h2', set: { tagline: 'Really' }, unset: ['heading'] }],
  },
  'an update that sets a block’s per-breakpoint overrides, then unsets them': {
    ops: [
      { op: 'update', ...at, key: 'h2', set: { _responsive: { lg: { size: 'xl' } } } },
      { op: 'update', ...at, key: 'h1', set: { _responsive: { md: { size: 'sm' } } } },
      { op: 'update', ...at, key: 'h1', unset: ['_responsive'] },
    ],
  },
  'a move into a slot, and back out after a sibling': {
    ops: [
      { op: 'move', ...at, key: 'h1', to: { parent: { key: 's1', slot: 'items' }, index: 0 } },
      { op: 'move', ...at, key: 'c1', to: { after: 'c2' } },
    ],
  },
  'a move later in its own slot': { ops: [{ op: 'move', ...at, key: 'h1', to: { index: 2 } }] },
  'a remove with everything inside': { ops: [{ op: 'remove', ...at, key: 's1' }] },
  'a duplicate, rekeying the copy all the way down': {
    ops: [{ op: 'duplicate', ...at, key: 's1' }],
    appliedOnly: true,
  },
  'a duplicate with a ref, inserted into': {
    ops: [
      { op: 'duplicate', ...at, key: 's1', ref: 'copy' },
      {
        op: 'insert',
        ...at,
        parent: { key: 'copy', slot: 'items' },
        index: 0,
        block: { _type: 'cta', label: 'First' },
      },
    ],
    appliedOnly: true,
  },
  'a locale the field does not hold yet': {
    ops: [{ op: 'insert', field: 'body', locale: 'de-DE', block: { _type: 'cta', label: 'Mehr' } }],
  },
  // A repeater's keyed items are not blocks: a duplicate copies their keys as they are.
  'a duplicate of a block holding a repeater': {
    ops: [
      { op: 'duplicate', ...at, key: 'h1' },
      { op: 'remove', ...at, key: 's1' },
    ],
  },
  // A block missing its `_type` still holds its key, and its typed siblings stay addressable.
  'ops beside, and on, a block with no _type': {
    ops: [
      { op: 'update', ...at, key: 'h2', set: { heading: 'Faster' } },
      { op: 'move', ...at, key: 'h2', to: { parent: { key: 's1', slot: 'items' }, after: 'odd' } },
      { op: 'remove', ...at, key: 'odd' },
    ],
    fields: untyped,
  },
  // Keys inside a JSON value are not blocks' keys: nothing is minted there, nothing collides.
  'an insert whose JSON value holds block-shaped objects': {
    ops: [
      {
        op: 'insert',
        ...at,
        block: {
          _type: 'embed',
          data: {
            list: [
              { _type: 'cta', _key: 'c2' },
              { _type: 'cta', label: 'no key' },
            ],
          },
        },
      },
      { op: 'remove', ...at, key: 'c1' },
    ],
  },
};

const REFUSED: Record<string, { ops: readonly BlockOp[]; fields?: EntryFields }> = {
  'a key nobody holds': { ops: [{ op: 'remove', ...at, key: 'nope' }] },
  'a move into itself': {
    ops: [{ op: 'move', ...at, key: 's1', to: { parent: { key: 's1', slot: 'items' } } }],
  },
  'an index past the end': { ops: [{ op: 'move', ...at, key: 'h1', to: { index: 9 } }] },
  'a sibling in another slot': {
    ops: [{ op: 'insert', ...at, before: 'c1', block: { _type: 'cta', label: 'x' } }],
  },
  'a key already held': {
    ops: [{ op: 'insert', ...at, block: { _type: 'cta', _key: 'c2', label: 'x' } }],
  },
  'a ref used twice': {
    ops: [
      { op: 'duplicate', ...at, key: 'h1', ref: 'r' },
      { op: 'duplicate', ...at, key: 'c2', ref: 'r' },
    ],
  },
  'a key two blocks share': {
    ops: [{ op: 'remove', ...at, key: 'h2' }],
    fields: {
      body: {
        [L]: [
          { _type: 'hero', _key: 'h2', heading: 'One' },
          {
            _type: 'section',
            _key: 's1',
            items: [{ _type: 'hero', _key: 'h2', heading: 'Two' }],
          },
        ],
      },
    },
  },
  'both set and unset': {
    ops: [{ op: 'update', ...at, key: 'h1', set: { heading: 'x' }, unset: ['heading'] }],
  },
  'a repeater item’s key': { ops: [{ op: 'remove', ...at, key: 'r1' }] },
  'a key under a plain component': { ops: [{ op: 'remove', ...at, key: 'n1' }] },
};

const throwingMinter = () => {
  throw new Error('an applied patch has nothing to mint');
};

describe('live preview patches match the server’s', () => {
  it('speak one op vocabulary', () => {
    const op = { op: 'remove', ...at, key: 'h1' } as const;
    expect(toDomain(toSdk([op]) as readonly SdkBlockOp[])).toEqual([op]);
  });

  for (const [name, { ops, fields = page, appliedOnly }] of Object.entries(ACCEPTED)) {
    it(name, () => {
      const server = applyBlockPatch(LANDING, fields(), ops, minter());
      if (!server.ok) throw new Error(JSON.stringify(server.issues));
      if (!appliedOnly) {
        const sdk = applyLivePatch(fields() as LiveFields, toSdk(ops), { newKey: minter() });
        expect(sdk).toEqual({ ok: true, fields: server.fields });
      }
      // What the admin sends a page: the applied form, every key present, nothing to mint.
      const replay = applyLivePatch(fields() as LiveFields, toSdk(server.applied), {
        newKey: throwingMinter,
      });
      expect(replay).toEqual({ ok: true, fields: server.fields });
    });
  }

  for (const [name, { ops, fields }] of Object.entries(REFUSED)) {
    it(`both refuse ${name}, at the same op`, () => {
      const server = applyBlockPatch(LANDING, fields ?? page(), ops, minter());
      const sdk = applyLivePatch((fields ?? page()) as LiveFields, toSdk(ops), {
        newKey: minter(),
      });
      expect(server.ok).toBe(false);
      expect(sdk.ok).toBe(false);
      if (!server.ok && !sdk.ok) expect(sdk.op).toBe(server.issues[0]?.op);
    });
  }
});

describe('where the page, without the content type, reads differently', () => {
  it('leaves blocks under a plain component keyed as they were in a raw duplicate', () => {
    const ops: BlockOp[] = [{ op: 'duplicate', ...at, key: 's1' }];
    const server = applyBlockPatch(LANDING, page(), ops, minter());
    const sdk = applyLivePatch(page() as LiveFields, toSdk(ops), { newKey: minter() });
    if (!server.ok || !sdk.ok) throw new Error('expected both to apply');
    type Copy = { aside?: { notes: { _key: string }[] } };
    const notes = (fields: EntryFields) => {
      const copy = ((fields.body?.[L] ?? []) as Copy[])[2];
      return (copy?.aside?.notes ?? []).map((n) => n._key);
    };
    expect(notes(server.fields)).not.toEqual(['n1']);
    expect(notes(sdk.fields as EntryFields)).toEqual(['n1']);
  });

  it('reads keyed, typed objects in a JSON list as a slot, so a shared key is ambiguous', () => {
    // `e1.data` is an object, opaque to both; a JSON field holding a list directly is not.
    const fields: EntryFields = {
      body: {
        [L]: [
          { _type: 'embed', _key: 'e1', data: [{ _type: 'cta', _key: 'c2' }] },
          { _type: 'cta', _key: 'c2', label: 'Sign up' },
        ],
      },
    };
    const ops: BlockOp[] = [{ op: 'remove', ...at, key: 'c2' }];
    expect(applyBlockPatch(LANDING, fields, ops, minter()).ok).toBe(true);
    expect(applyLivePatch(fields as LiveFields, toSdk(ops)).ok).toBe(false);
    // The way out the admin takes after a second refusal: the field whole, which always applies.
    const whole = applyLivePatch(fields as LiveFields, [
      { op: 'setField', ...at, value: [{ _type: 'embed', _key: 'e1', data: [] }] },
    ]);
    expect(whole.ok).toBe(true);
  });
});
