import { describe, expect, it } from 'vitest';
import {
  applyDefaults,
  assignBlockKeys,
  type ComponentVariant,
  type ContentType,
  defineContentType,
  extractReferences,
  type FieldDefinition,
  MAX_BLOCK_DEPTH,
  MAX_COMPONENT_DEPTH,
  nestedFieldsFor,
  removedFields,
  removedFieldUses,
  removedVariants,
  removedVariantUses,
  ValidationError,
  validateEntryFields,
} from '../src/index';

const vctx = { defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const HERO: ComponentVariant = {
  apiId: 'hero',
  name: 'Hero',
  fields: [
    field({ apiId: 'heading', type: 'Symbol', required: true }),
    field({ apiId: 'image', type: 'Link', linkType: 'Asset', position: 1 }),
  ],
};
const CTA: ComponentVariant = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [
    field({ apiId: 'label', type: 'Symbol', required: true, defaultValue: 'Learn more' }),
    field({ apiId: 'target', type: 'Link', linkType: 'Entry', position: 1 }),
  ],
};

const blocksField = (variants: readonly ComponentVariant[] = [HERO, CTA], over = {}) =>
  field({ apiId: 'body', type: 'Array', items: { type: 'Component', variants }, ...over });

const typeWith = (fields: FieldDefinition[]): ContentType =>
  defineContentType({
    apiId: 'landing',
    name: 'Landing',
    displayField: 'title',
    fields: fields.some((f) => f.apiId === 'title')
      ? fields
      : [field({ apiId: 'title', type: 'Symbol', position: -1 }), ...fields],
  });

const LANDING = typeWith([field({ apiId: 'title', type: 'Symbol' }), blocksField()]);

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof ValidationError ? (err.issues[0]?.message ?? '') : String(err);
  }
  return '';
};

const body = (value: unknown) =>
  validateEntryFields(LANDING, { body: { 'en-US': value } }, vctx).map((i) => ({
    field: i.field,
    message: i.message,
  }));

describe('defining a blocks field', () => {
  it('accepts an Array of Component with named variants', () => {
    expect(() =>
      typeWith([field({ apiId: 'title', type: 'Symbol' }), blocksField()]),
    ).not.toThrow();
  });

  it('needs at least one variant', () => {
    expect(refusal(() => typeWith([blocksField([])]))).toMatch(/at least one variant/);
  });

  it('refuses a variant apiId that could not be a field apiId', () => {
    const bad = { ...HERO, apiId: '_hero' };
    expect(refusal(() => typeWith([blocksField([bad])]))).toMatch(/Invalid variant apiId "_hero"/);
  });

  it('refuses two variants with one apiId', () => {
    expect(refusal(() => typeWith([blocksField([HERO, { ...CTA, apiId: 'hero' }])]))).toMatch(
      /Duplicate variant apiId "hero"/,
    );
  });

  it('refuses a variant without fields', () => {
    expect(refusal(() => typeWith([blocksField([{ ...HERO, fields: [] }])]))).toMatch(
      /variant must define at least one field/,
    );
  });

  it('refuses items.fields and items.variants together', () => {
    const both = field({
      apiId: 'body',
      type: 'Array',
      items: { type: 'Component', fields: HERO.fields, variants: [HERO] },
    });
    expect(refusal(() => typeWith([both]))).toMatch(/not both/);
  });

  it('keeps variants off a single Component: a one-block slot is size.max 1', () => {
    const single = field({
      apiId: 'slot',
      type: 'Component',
      fields: HERO.fields,
      items: { type: 'Component', variants: [HERO] },
    });
    expect(refusal(() => typeWith([single]))).toMatch(/size.max of 1/);
  });

  it('refuses variants on an array of something else', () => {
    const links = field({
      apiId: 'links',
      type: 'Array',
      items: { type: 'Link', variants: [HERO] } as never,
    });
    expect(refusal(() => typeWith([links]))).toMatch(/cannot define nested fields/);
  });

  it("holds a variant's fields to the nested rules", () => {
    const localized = { ...HERO, fields: [field({ apiId: 'x', type: 'Symbol', localized: true })] };
    expect(refusal(() => typeWith([blocksField([localized])]))).toMatch(/cannot be localized/);
    const slug = { ...HERO, fields: [field({ apiId: 'x', type: 'Slug' })] };
    expect(refusal(() => typeWith([blocksField([slug])]))).toMatch(/Slug cannot live/);
    const unique = { ...HERO, fields: [field({ apiId: 'x', type: 'Symbol', unique: true })] };
    expect(refusal(() => typeWith([blocksField([unique])]))).toMatch(/cannot be unique/);
  });

  it('names the variant in the path of a nested refusal', () => {
    const slug = { ...HERO, fields: [field({ apiId: 'x', type: 'Slug' })] };
    try {
      typeWith([blocksField([slug])]);
    } catch (err) {
      expect((err as ValidationError).issues[0]?.field).toBe('body[hero].x');
    }
  });

  /** A blocks field `levels` deep: each level's one variant holds the next level as a slot. */
  const slots = (
    levels: number,
    leaf: FieldDefinition[] = [field({ apiId: 'x', type: 'Symbol' })],
  ) => {
    let inner: FieldDefinition | undefined;
    for (let d = levels; d >= 1; d--) {
      const fields = inner ? [field({ apiId: 'label', type: 'Symbol' }), inner] : leaf;
      inner = field({
        apiId: d === 1 ? 'body' : `slot${d}`,
        type: 'Array',
        items: { type: 'Component', variants: [{ apiId: `level${d}`, name: `L${d}`, fields }] },
      });
    }
    return inner as FieldDefinition;
  };
  const components = (n: number): FieldDefinition => {
    let inner: FieldDefinition = field({ apiId: 'leaf', type: 'Symbol' });
    for (let d = 1; d <= n; d++) {
      inner = field({ apiId: `c${d}`, type: 'Component', fields: [inner] });
    }
    return inner;
  };

  it(`nests slots ${MAX_BLOCK_DEPTH} deep, the blocks field counting as 1, and refuses a 7th`, () => {
    expect(() => typeWith([slots(MAX_BLOCK_DEPTH)])).not.toThrow();
    expect(refusal(() => typeWith([slots(MAX_BLOCK_DEPTH + 1)]))).toMatch(
      /nest 6 deep at most, a top-level field counting as 1/,
    );
  });

  it('counts a component prop of a block toward the overall cap', () => {
    // A component inside the deepest block is a 7th level: it doesn't escape both caps.
    expect(refusal(() => typeWith([slots(MAX_BLOCK_DEPTH, [components(1)])]))).toMatch(
      /nest 6 deep at most/,
    );
    expect(() => typeWith([slots(MAX_BLOCK_DEPTH - 1, [components(1)])])).not.toThrow();
  });

  it(`keeps plain components to ${MAX_COMPONENT_DEPTH} among themselves inside a block`, () => {
    // A block's slots don't count toward the plain cap; its component props do.
    const ok = blocksField([
      { apiId: 'deep', name: 'Deep', fields: [components(MAX_COMPONENT_DEPTH)] },
    ]);
    expect(() => typeWith([ok])).not.toThrow();
    const tooDeep = blocksField([
      { apiId: 'deep', name: 'Deep', fields: [components(MAX_COMPONENT_DEPTH + 1)] },
    ]);
    expect(refusal(() => typeWith([tooDeep]))).toMatch(/Components may nest 3 deep at most/);
    // Below two levels of slots, three components still fit (5 in all), a fourth doesn't.
    expect(() => typeWith([slots(2, [components(MAX_COMPONENT_DEPTH)])])).not.toThrow();
    expect(refusal(() => typeWith([slots(2, [components(MAX_COMPONENT_DEPTH + 1)])]))).toMatch(
      /Components may nest 3 deep at most/,
    );
  });

  it('validates a value six blocks deep against the deepest variant', () => {
    const ct = typeWith([slots(MAX_BLOCK_DEPTH)]);
    let value: Record<string, unknown> = { _type: `level${MAX_BLOCK_DEPTH}`, x: 1 };
    for (let d = MAX_BLOCK_DEPTH - 1; d >= 1; d--) {
      value = { _type: `level${d}`, label: 'ok', [`slot${d + 1}`]: [value] };
    }
    const issues = validateEntryFields(ct, { body: { 'en-US': [value] } }, vctx);
    // Only the wrong leaf value is reported, at its full path.
    expect(issues.map((i) => i.field)).toEqual([
      'body[0].slot2[0].slot3[0].slot4[0].slot5[0].slot6[0].x',
    ]);
  });
});

describe('validating blocks', () => {
  it('accepts blocks of any declared variant, in any order', () => {
    expect(
      body([
        { _type: 'cta', _key: 'a', label: 'Go' },
        { _type: 'hero', _key: 'b', heading: 'Hello' },
        { _type: 'cta', label: 'Again' },
      ]),
    ).toEqual([]);
  });

  it('reports a missing _type at the block', () => {
    expect(body([{ heading: 'x' }])).toEqual([
      { field: 'body[0]', message: 'Block is missing _type (one of: hero, cta)' },
    ]);
  });

  it('reports an unknown _type at the block', () => {
    expect(
      body([
        { _type: 'hero', heading: 'ok' },
        { _type: 'quote', text: 'x' },
      ]),
    ).toEqual([{ field: 'body[1]', message: 'Unknown block type "quote" (one of: hero, cta)' }]);
  });

  it("checks a block against its own variant's fields", () => {
    expect(body([{ _type: 'cta', heading: 'wrong shape' }])).toEqual([
      { field: 'body[0].heading', message: 'Unknown field "heading"' },
      { field: 'body[0].label', message: 'Field is required' },
    ]);
  });

  it('refuses a duplicate _key within one field value', () => {
    expect(
      body([
        { _type: 'hero', _key: 'k', heading: 'a' },
        { _type: 'hero', _key: 'k', heading: 'b' },
      ]),
    ).toEqual([{ field: 'body[1]', message: 'Duplicate _key "k"' }]);
  });

  it('refuses a _key that is not a non-empty string', () => {
    expect(body([{ _type: 'hero', _key: 7, heading: 'a' }])).toEqual([
      { field: 'body[0]', message: '_key must be a non-empty string' },
    ]);
  });

  it('applies size validations to the block count', () => {
    const slot = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      blocksField([HERO, CTA], { validations: { size: { max: 1 } } }),
    ]);
    const issues = validateEntryFields(
      slot,
      {
        body: {
          'en-US': [
            { _type: 'hero', heading: 'a' },
            { _type: 'cta', label: 'b' },
          ],
        },
      },
      vctx,
    );
    expect(issues.map((i) => i.message)).toEqual(['item count must be <= 1']);
  });

  it('leaves a variant-less repeater as it was: no _type, no _key', () => {
    const plain = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'cards', type: 'Array', items: { type: 'Component', fields: HERO.fields } }),
    ]);
    expect(validateEntryFields(plain, { cards: { 'en-US': [{ heading: 'a' }] } }, vctx)).toEqual(
      [],
    );
  });
});

describe('links inside blocks', () => {
  it('are references of the top-level field, found per variant', () => {
    const edges = extractReferences(
      'e1',
      {
        body: {
          'en-US': [
            { _type: 'hero', heading: 'h', image: { id: 'a1', linkType: 'Asset' } },
            { _type: 'cta', label: 'l', target: { id: 'e2', linkType: 'Entry' } },
            // An unknown variant contributes nothing: there is no definition to read it by.
            { _type: 'gone', target: { id: 'e3', linkType: 'Entry' } },
          ],
        },
      },
      LANDING,
    );
    expect(edges.map((e) => `${e.fromField}->${e.toType}:${e.toId}`).sort()).toEqual([
      'body->Asset:a1',
      'body->Entry:e2',
    ]);
  });

  it('resolves the definition a block is read by', () => {
    const f = LANDING.fields.find((x) => x.apiId === 'body') as FieldDefinition;
    expect(nestedFieldsFor(f, { _type: 'cta' })).toBe(CTA.fields);
    expect(nestedFieldsFor(f, { _type: 'nope' })).toBeUndefined();
  });
});

describe('defaults and keys', () => {
  it("fills each block from its own variant's defaults", () => {
    const out = applyDefaults(
      LANDING,
      { body: { 'en-US': [{ _type: 'cta' }, { _type: 'hero', heading: 'h' }] } },
      vctx.locales,
      vctx.defaultLocale,
    );
    expect(out.body?.['en-US']).toEqual([
      { _type: 'cta', label: 'Learn more' },
      { _type: 'hero', heading: 'h' },
    ]);
  });

  it('assigns a _key to each block without one and keeps the ones present', () => {
    let n = 0;
    const out = assignBlockKeys(
      LANDING,
      { body: { 'en-US': [{ _type: 'hero', _key: 'keep', heading: 'a' }, { _type: 'cta' }] } },
      () => `new-${++n}`,
    );
    expect(out.body?.['en-US']).toEqual([
      { _type: 'hero', _key: 'keep', heading: 'a' },
      { _type: 'cta', _key: 'new-1' },
    ]);
  });

  it('keys blocks nested inside a component and inside another block', () => {
    const inner = blocksField([CTA], { apiId: 'ctas' });
    const section: ComponentVariant = { apiId: 'section', name: 'Section', fields: [inner] };
    const ct = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      blocksField([section]),
      field({ apiId: 'meta', type: 'Component', fields: [inner] }),
    ]);
    let n = 0;
    const out = assignBlockKeys(
      ct,
      {
        body: { 'en-US': [{ _type: 'section', ctas: [{ _type: 'cta', label: 'x' }] }] },
        meta: { 'en-US': { ctas: [{ _type: 'cta', label: 'y' }] } },
      },
      () => `k${++n}`,
    );
    expect(out.body?.['en-US']).toEqual([
      { _type: 'section', _key: 'k2', ctas: [{ _type: 'cta', _key: 'k1', label: 'x' }] },
    ]);
    expect(out.meta?.['en-US']).toEqual({ ctas: [{ _type: 'cta', _key: 'k3', label: 'y' }] });
    expect(validateEntryFields(ct, out, vctx)).toEqual([]);
  });

  it('returns the fields untouched when the type has no blocks', () => {
    const plain = typeWith([field({ apiId: 'title', type: 'Symbol' })]);
    const fields = { title: { 'en-US': 'x' } };
    expect(assignBlockKeys(plain, fields, () => 'k')).toBe(fields);
  });
});

describe('removing a variant', () => {
  it('reports the variants a revision drops, by location', () => {
    const removed = removedVariants(LANDING.fields, [blocksField([HERO])]);
    expect([...removed].map(([at, set]) => [at, [...set]])).toEqual([['body', ['cta']]]);
  });

  it('reports nothing when variants or fields are only added', () => {
    const more = blocksField([
      { ...HERO, fields: [...HERO.fields, field({ apiId: 'kicker', type: 'Symbol' })] },
      CTA,
      { apiId: 'quote', name: 'Quote', fields: [field({ apiId: 'text', type: 'Text' })] },
    ]);
    expect(removedVariants(LANDING.fields, [more]).size).toBe(0);
  });

  it('finds the entries that still use a removed variant, nested ones too', () => {
    const inner = blocksField([HERO, CTA], { apiId: 'ctas' });
    const section: ComponentVariant = { apiId: 'section', name: 'Section', fields: [inner] };
    const before = [blocksField([section, CTA])];
    const after = [blocksField([{ ...section, fields: [blocksField([HERO], { apiId: 'ctas' })] }])];
    const removed = removedVariants(before, after);
    expect([...removed.keys()].sort()).toEqual(['body', 'body[section].ctas']);
    expect(
      removedVariantUses(
        before,
        { body: { 'en-US': [{ _type: 'section', ctas: [{ _type: 'cta', label: 'x' }] }] } },
        removed,
      ),
    ).toEqual(['body[section].ctas: cta']);
    expect(
      removedVariantUses(before, { body: { 'en-US': [{ _type: 'section', ctas: [] }] } }, removed),
    ).toEqual([]);
  });
});

describe('removing a field', () => {
  const seo = field({
    apiId: 'seo',
    type: 'Component',
    fields: [
      field({ apiId: 'description', type: 'Text' }),
      field({ apiId: 'noindex', type: 'Boolean' }),
    ],
  });

  it('reports the fields a revision drops at any depth, by location', () => {
    const before = [
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'teaser', type: 'Text' }),
      seo,
      blocksField(),
    ];
    const after = [
      field({ apiId: 'title', type: 'Symbol' }),
      { ...seo, fields: [field({ apiId: 'noindex', type: 'Boolean' })] },
      blocksField([{ ...HERO, fields: [HERO.fields[0] as FieldDefinition] }, CTA]),
    ];
    expect([...removedFields(before, after)].sort()).toEqual([
      'body[hero].image',
      'seo.description',
      'teaser',
    ]);
  });

  it('leaves a removed variant to removedVariants, and its fields unlisted', () => {
    expect([
      ...removedFields(LANDING.fields, [
        field({ apiId: 'title', type: 'Symbol' }),
        blocksField([HERO]),
      ]),
    ]).toEqual([]);
  });

  it('reports nothing when fields are only added', () => {
    const more = [...LANDING.fields, field({ apiId: 'kicker', type: 'Symbol' })];
    expect(removedFields(LANDING.fields, more).size).toBe(0);
  });

  it('finds the values an entry still holds for a removed field, nested ones too', () => {
    const before = [field({ apiId: 'teaser', type: 'Text' }), seo, blocksField()];
    const removed = new Set(['teaser', 'seo.description', 'body[hero].image']);
    expect(
      removedFieldUses(
        before,
        {
          teaser: { 'en-US': 'Short' },
          seo: { 'en-US': { description: 'About', noindex: false } },
          body: { 'en-US': [{ _type: 'hero', heading: 'Hi', image: { sys: { id: 'a1' } } }] },
        },
        removed,
      ).sort(),
    ).toEqual(['body[hero].image', 'seo.description', 'teaser']);
  });

  it('does not count an absent or null value as one held', () => {
    const before = [field({ apiId: 'teaser', type: 'Text' }), seo];
    const removed = new Set(['teaser', 'seo.description']);
    expect(
      removedFieldUses(
        before,
        { teaser: { 'en-US': null }, seo: { 'en-US': { noindex: true } } },
        removed,
      ),
    ).toEqual([]);
  });
});

describe('renaming a variant through aliases', () => {
  const BANNER: ComponentVariant = { ...HERO, apiId: 'banner', name: 'Banner', aliases: ['hero'] };
  const RENAMED = typeWith([field({ apiId: 'title', type: 'Symbol' }), blocksField([BANNER, CTA])]);

  it('reads a block stored under a former apiId as its variant', () => {
    const values = { body: { 'en-US': [{ _type: 'hero', heading: 'Old' }] } };
    expect(validateEntryFields(RENAMED, values, vctx)).toEqual([]);
    expect(nestedFieldsFor(RENAMED.fields[1] as FieldDefinition, { _type: 'hero' })).toBe(
      BANNER.fields,
    );
  });

  it('writes it under the current apiId on its next save', () => {
    const out = assignBlockKeys(
      RENAMED,
      { body: { 'en-US': [{ _type: 'hero', _key: 'k', heading: 'Old' }] } },
      () => 'new',
    );
    expect(out.body?.['en-US']).toEqual([{ _type: 'banner', _key: 'k', heading: 'Old' }]);
  });

  it('is not a removal of the former apiId, and still compares its fields', () => {
    expect(removedVariants(LANDING.fields, RENAMED.fields).size).toBe(0);
    const slimmer = blocksField([{ ...BANNER, fields: [HERO.fields[0] as FieldDefinition] }, CTA]);
    expect([
      ...removedFields(LANDING.fields, [field({ apiId: 'title', type: 'Symbol' }), slimmer]),
    ]).toEqual(['body[hero].image']);
  });

  it('reads dropping an alias later as removing that former apiId', () => {
    const forgotten = [
      field({ apiId: 'title', type: 'Symbol' }),
      blocksField([{ ...BANNER, aliases: undefined }, CTA]),
    ];
    const removed = removedVariants(RENAMED.fields, forgotten);
    expect([...removed].map(([at, set]) => [at, [...set]])).toEqual([['body', ['hero']]]);
    expect(
      removedVariantUses(
        RENAMED.fields,
        { body: { 'en-US': [{ _type: 'hero', heading: 'x' }] } },
        removed,
      ),
    ).toEqual(['body: hero']);
  });

  it('refuses an alias that is another variant’s apiId, or listed twice', () => {
    expect(refusal(() => typeWith([blocksField([{ ...HERO, aliases: ['cta'] }, CTA])]))).toMatch(
      /Alias "cta" is the apiId of a variant/,
    );
    expect(
      refusal(() =>
        typeWith([
          blocksField([
            { ...HERO, aliases: ['old'] },
            { ...CTA, aliases: ['old'] },
          ]),
        ]),
      ),
    ).toMatch(/Alias "old" is listed twice/);
    expect(refusal(() => typeWith([blocksField([{ ...HERO, aliases: ['_x'] }])]))).toMatch(
      /Invalid alias "_x"/,
    );
  });
});
