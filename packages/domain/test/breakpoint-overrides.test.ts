import { describe, expect, it } from 'vitest';
import {
  applyBlockPatch,
  assignBlockKeys,
  type BlockLock,
  blockLockIssues,
  type ContentType,
  checkBlockCatalog,
  defineContentType,
  diffBlockCatalogs,
  type EntryFields,
  invertBlockPatch,
  narrowsOverrides,
  planCatalogTypes,
  staleOverrideUses,
  undeclaredOverrides,
  ValidationError,
  validateEntryFields,
} from '../src/index';

/**
 * Per-breakpoint overrides (docs/specs/breakpoint-overrides.md): breakpoints and `responsive`
 * checked on the push and carried onto the target type, `_responsive` validated against them,
 * stale overrides passed over by validation and dropped by the save, the push's stale count, block
 * patches and frozen regions.
 */

const BREAKPOINTS = [
  { id: 'md', name: 'Tablet', minWidth: 768 },
  { id: 'lg', name: 'Desktop', minWidth: 1280 },
];

const HERO = {
  id: 'hero',
  name: 'Hero',
  responsive: ['size', 'hidden'],
  fields: [
    { apiId: 'heading', name: 'Heading', type: 'Symbol' },
    { apiId: 'size', name: 'Size', type: 'Symbol', validations: { in: ['sm', 'md', 'xl'] } },
    { apiId: 'columns', name: 'Columns', type: 'Integer', validations: { in: [1, 2, 3] } },
    { apiId: 'hidden', name: 'Hidden', type: 'Boolean' },
  ],
};
const SECTION = {
  id: 'section',
  name: 'Section',
  fields: [{ apiId: 'label', name: 'Label', type: 'Symbol' }],
  slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['hero'] }],
};
const TARGETS = [{ contentTypeApiId: 'page', field: 'body' }];

const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.issues;
    throw err;
  }
  return [];
};

const BARE_PAGE = defineContentType({
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 0,
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: false,
      required: false,
      position: 1,
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'x',
            name: 'X',
            fields: [
              {
                apiId: 'y',
                name: 'Y',
                type: 'Symbol',
                localized: false,
                required: false,
                position: 0,
              },
            ],
          },
        ],
      },
    },
  ],
});

/** The page as a push leaves it: the catalog's variants and breakpoints on `body`. */
function pushed(
  breakpoints = BREAKPOINTS,
  blocks: unknown[] = [HERO, SECTION],
  over: ContentType = BARE_PAGE,
): ContentType {
  const checked = checkBlockCatalog({ blocks, targets: TARGETS, breakpoints });
  const [plan] = planCatalogTypes(
    checked.blocks,
    checked.targets,
    new Map([['page', over]]),
    checked.breakpoints,
  );
  if (!plan) return over;
  return defineContentType({ ...over, fields: [...plan.fields] });
}

const VCTX = { defaultLocale: 'en-US', locales: ['en-US'] };
const body = (blocks: unknown[]): EntryFields => ({ body: { 'en-US': blocks } });

describe('breakpoints and responsive on the push', () => {
  it('normalizes a valid catalog and carries both onto the target field and variants', () => {
    const checked = checkBlockCatalog({
      blocks: [HERO, SECTION],
      targets: TARGETS,
      breakpoints: [{ ...BREAKPOINTS[0], extra: 1 }, BREAKPOINTS[1]],
    });
    expect(checked.breakpoints).toEqual(BREAKPOINTS);
    expect(checked.blocks[0]?.responsive).toEqual(['size', 'hidden']);
    const page = pushed();
    const field = page.fields[1];
    expect(field?.items?.breakpoints).toEqual(BREAKPOINTS);
    const hero = field?.items?.variants?.find((v) => v.apiId === 'hero');
    expect(hero?.responsive).toEqual(['size', 'hidden']);
    // A slot's blocks carry their responsive props too; the slot takes the target's breakpoints.
    const inner = field?.items?.variants
      ?.find((v) => v.apiId === 'section')
      ?.fields.find((f) => f.apiId === 'items');
    expect(inner?.items?.variants?.[0]?.responsive).toEqual(['size', 'hidden']);
    expect(inner?.items?.breakpoints).toBeUndefined();
  });

  it('defaults to no breakpoints, leaving an older catalog as it was', () => {
    const checked = checkBlockCatalog({ blocks: [HERO], targets: TARGETS });
    expect(checked.breakpoints).toEqual([]);
    const page = pushed([], [HERO]);
    expect(page.fields[1]?.items).not.toHaveProperty('breakpoints');
  });

  it('refuses bad breakpoints, naming each place', () => {
    const issues = issuesOf(() =>
      checkBlockCatalog({
        blocks: [SECTION],
        targets: TARGETS,
        breakpoints: [
          { id: 'base', name: 'Base', minWidth: 10 },
          { id: '2xl', name: 'Huge', minWidth: 2000 },
          { id: 'md', name: 'Tablet', minWidth: 768 },
          { id: 'sm', name: 'Small', minWidth: 400 },
          { id: 'xl', name: '', minWidth: 3000 },
          { id: 'xxl', name: 'Wide', minWidth: 10_001 },
          { id: 'md', name: 'Again', minWidth: 900 },
        ],
      }),
    );
    const at = issues.map((i) => i.field);
    expect(at).toEqual(
      expect.arrayContaining([
        'breakpoints',
        'breakpoints[0].id',
        'breakpoints[1].id',
        'breakpoints[3].minWidth',
        'breakpoints[4].name',
        'breakpoints[5].minWidth',
        'breakpoints[6].id',
      ]),
    );
    expect(issues.find((i) => i.field === 'breakpoints')?.message).toContain('at most 6');
    expect(
      issuesOf(() => checkBlockCatalog({ blocks: [SECTION], targets: TARGETS, breakpoints: {} })),
    ).toMatchObject([{ field: 'breakpoints' }]);
  });

  it('refuses a responsive prop that is not a top-level token or Boolean, by its place', () => {
    const issues = issuesOf(() =>
      checkBlockCatalog({
        blocks: [
          { ...HERO, responsive: ['size', 'heading', 'missing', 'size', 'columns'] },
          { ...SECTION, responsive: ['items'] },
        ],
        targets: TARGETS,
        breakpoints: BREAKPOINTS,
      }),
    );
    expect(issues.map((i) => i.field)).toEqual([
      'blocks[hero].responsive[1]',
      'blocks[hero].responsive[2]',
      'blocks[hero].responsive[3]',
      'blocks[section].responsive[0]',
    ]);
    expect(issues[0]?.message).toContain('must be a token');
  });

  it('refuses breakpoints below the top level and bad responsive on a hand-written type', () => {
    const field = BARE_PAGE.fields[1];
    const variant = field?.items?.variants?.[0];
    const withBody = (items: unknown) =>
      issuesOf(() =>
        defineContentType({
          ...BARE_PAGE,
          fields: [BARE_PAGE.fields[0] as never, { ...field, items } as never],
        }),
      );
    expect(withBody({ ...field?.items, variants: [{ ...variant, responsive: ['y'] }] })).toEqual([
      { field: 'body[x].responsive[0]', message: expect.stringContaining('must be a token') },
    ]);
    const nested = {
      ...variant,
      fields: [
        ...(variant?.fields ?? []),
        {
          apiId: 'inner',
          name: 'Inner',
          type: 'Array',
          localized: false,
          required: false,
          position: 1,
          items: { type: 'Component', variants: [variant], breakpoints: BREAKPOINTS },
        },
      ],
    };
    expect(withBody({ ...field?.items, variants: [nested] })).toEqual([
      { field: 'body[x].inner', message: expect.stringContaining('top-level blocks field') },
    ]);
    expect(
      withBody({ ...field?.items, breakpoints: [{ id: 'md', name: 'Tablet', minWidth: 0 }] }),
    ).toEqual([{ field: 'body.breakpoints[0].minWidth', message: expect.any(String) }]);
  });

  it('counts a changed breakpoints list as a catalog and a field change', () => {
    const checked = checkBlockCatalog({ blocks: [HERO], targets: TARGETS });
    expect(
      diffBlockCatalogs(checked.blocks, checked.blocks, { before: BREAKPOINTS, after: [] }),
    ).toMatchObject({ breakpoints: true, added: [], changed: [] });
    expect(
      diffBlockCatalogs(checked.blocks, checked.blocks, {
        before: BREAKPOINTS,
        after: BREAKPOINTS,
      }),
    ).not.toHaveProperty('breakpoints');
    const page = pushed();
    const [plan] = planCatalogTypes(
      checkBlockCatalog({ blocks: [HERO, SECTION], targets: TARGETS }).blocks,
      [TARGETS[0] as never],
      new Map([['page', page]]),
      [BREAKPOINTS[0] as never],
    );
    expect(plan?.changes).toEqual([
      { field: 'body', added: [], changed: [], removed: [], renamed: [], breakpoints: true },
    ]);
    expect(plan?.fields[1]?.items?.breakpoints).toEqual([BREAKPOINTS[0]]);
  });
});

describe('_responsive on a save', () => {
  const page = pushed();

  it('takes declared overrides, at any depth, and checks each value as its prop', () => {
    const value = body([
      { _type: 'hero', size: 'md', _responsive: { lg: { size: 'xl' }, md: { hidden: true } } },
      {
        _type: 'section',
        items: [{ _type: 'hero', _responsive: { md: { size: 'sm' } } }],
      },
    ]);
    expect(validateEntryFields(page, value, VCTX)).toEqual([]);
    const bad = body([
      { _type: 'hero', _responsive: { lg: { size: 'huge', hidden: 'yes' } } },
      { _type: 'section', items: [{ _type: 'hero', _responsive: { md: { size: null } } }] },
    ]);
    expect(validateEntryFields(page, bad, VCTX).map((i) => i.field)).toEqual([
      'body[0]._responsive.lg.size',
      'body[0]._responsive.lg.hidden',
      'body[1].items[0]._responsive.md.size',
    ]);
  });

  it('refuses what can never be an override, and any other _ key as before', () => {
    const issues = validateEntryFields(
      page,
      body([
        { _type: 'hero', _responsive: 'big' },
        { _type: 'hero', _responsive: { base: { size: 'sm' }, '2x': {}, md: 'sm' } },
        { _type: 'hero', _style: { color: 'red' } },
      ]),
      VCTX,
    );
    expect(issues.map((i) => i.field)).toEqual([
      'body[0]._responsive',
      'body[1]._responsive.base',
      'body[1]._responsive.2x',
      'body[1]._responsive.md',
      'body[2]._style',
    ]);
  });

  it('passes over stale overrides, and the save drops them with emptied maps', () => {
    const value = body([
      {
        _type: 'hero',
        _key: 'a',
        size: 'md',
        _responsive: { xl: { size: 'xl' }, lg: { columns: 2, size: 'xl' }, md: { columns: 1 } },
      },
      { _type: 'hero', _key: 'b', _responsive: { md: {} } },
      {
        _type: 'section',
        _key: 'c',
        _responsive: { md: { label: 'x' } },
        items: [{ _type: 'hero', _key: 'd', _responsive: { xl: { size: 'sm' } } }],
      },
    ]);
    expect(validateEntryFields(page, value, VCTX)).toEqual([]);
    const saved = assignBlockKeys(page, value, () => 'new');
    expect(saved.body?.['en-US']).toEqual([
      { _type: 'hero', _key: 'a', size: 'md', _responsive: { lg: { size: 'xl' } } },
      { _type: 'hero', _key: 'b' },
      { _type: 'section', _key: 'c', items: [{ _type: 'hero', _key: 'd' }] },
    ]);
    // Nothing stale: the overrides are kept as they are.
    const clean = body([{ _type: 'hero', _key: 'e', _responsive: { lg: { size: 'xl' } } }]);
    expect(assignBlockKeys(page, clean, () => 'new')).toEqual(clean);
  });

  it('keeps no override on a blocks field without breakpoints', () => {
    const plain = pushed([]);
    const value = body([{ _type: 'hero', _key: 'a', _responsive: { lg: { size: 'xl' } } }]);
    expect(validateEntryFields(plain, value, VCTX)).toEqual([]);
    expect(assignBlockKeys(plain, value, () => 'n').body?.['en-US']).toEqual([
      { _type: 'hero', _key: 'a' },
    ]);
  });
});

describe('an undeclared override in a new edit', () => {
  const page = pushed();
  const local = (locale: string, blocks: unknown[]): EntryFields => ({
    body: { [locale]: blocks },
  });

  it('is named by block and breakpoint, at any depth', () => {
    const after = body([
      { _type: 'hero', _key: 'a', _responsive: { xl: { size: 'sm' }, lg: { size: 'xl' } } },
      {
        _type: 'section',
        _key: 's',
        _responsive: { md: { label: 'x' } },
        items: [{ _type: 'hero', _key: 'c', _responsive: { lg: { heading: 'x' } } }],
      },
    ]);
    expect(undeclaredOverrides(page, after, undefined)).toMatchObject([
      { field: 'body[0]._responsive.xl', locale: 'en-US', code: 'override_undeclared', key: 'a' },
      { field: 'body[1]._responsive.md', key: 's', message: expect.stringContaining('"label"') },
      { field: 'body[1].items[0]._responsive.lg', key: 'c' },
    ]);
  });

  it('passes what the same block carried in the same field and locale, and nothing else', () => {
    const stale = [{ _type: 'hero', _key: 'a', _responsive: { xl: { size: 'sm' } } }];
    expect(undeclaredOverrides(page, body(stale), body(stale))).toEqual([]);
    // Another prop at the stale breakpoint, another block, another locale: all new.
    const before = body(stale);
    expect(
      undeclaredOverrides(
        page,
        body([{ _type: 'hero', _key: 'a', _responsive: { xl: { size: 'sm', hidden: true } } }]),
        before,
      ),
    ).toHaveLength(1);
    expect(undeclaredOverrides(page, body([{ ...stale[0], _key: 'b' }]), before)).toHaveLength(1);
    expect(undeclaredOverrides(page, local('de-DE', stale), before)).toHaveLength(1);
    // What validation refuses on its own isn't judged twice.
    expect(
      undeclaredOverrides(
        page,
        body([{ _type: 'hero', _responsive: { base: {}, '2x': {}, md: 'x' } }]),
        undefined,
      ),
    ).toEqual([]);
  });
});

describe('what a push makes stale', () => {
  const before = pushed();
  const values = body([
    { _type: 'hero', _responsive: { lg: { size: 'xl' }, md: { hidden: true } } },
    { _type: 'hero', _responsive: { lg: { size: 'sm', hidden: false } } },
    { _type: 'section', items: [{ _type: 'hero', _responsive: { lg: { hidden: true } } }] },
    // Already stale before the push: not this push's doing.
    { _type: 'hero', _responsive: { xl: { size: 'sm' } } },
  ]);

  it('counts each block, breakpoint and prop a removed breakpoint strands', () => {
    const after = pushed([BREAKPOINTS[0] as never]);
    expect(narrowsOverrides(before.fields, after.fields)).toBe(true);
    // One site per block: the first and second blocks, and the one in the section's slot.
    expect(staleOverrideUses(before.fields, after.fields, values).map((u) => u.site)).toEqual([
      0, 1, 1, 3,
    ]);
    expect(
      staleOverrideUses(before.fields, after.fields, values).map(({ site: _, ...use }) => use),
    ).toEqual([
      { block: 'hero', breakpoint: 'lg', prop: 'size' },
      { block: 'hero', breakpoint: 'lg', prop: 'size' },
      { block: 'hero', breakpoint: 'lg', prop: 'hidden' },
      { block: 'hero', breakpoint: 'lg', prop: 'hidden' },
    ]);
  });

  it('counts a prop dropped from responsive, and nothing for a push that narrows nothing', () => {
    const after = pushed(BREAKPOINTS, [{ ...HERO, responsive: ['size'] }, SECTION]);
    expect(
      staleOverrideUses(before.fields, after.fields, values).map(({ site: _, ...use }) => use),
    ).toEqual([
      { block: 'hero', breakpoint: 'md', prop: 'hidden' },
      { block: 'hero', breakpoint: 'lg', prop: 'hidden' },
      { block: 'hero', breakpoint: 'lg', prop: 'hidden' },
    ]);
    const wider = pushed([...BREAKPOINTS, { id: 'xl', name: 'Wide', minWidth: 1600 }]);
    expect(narrowsOverrides(before.fields, wider.fields)).toBe(false);
  });
});

describe('_responsive in a block patch and a frozen region', () => {
  const page = pushed();
  const fields = body([
    { _type: 'hero', _key: 'a', size: 'md', _responsive: { lg: { size: 'xl' } } },
    { _type: 'section', _key: 's', label: 'S', items: [] },
  ]);

  it('sets and unsets the map as a whole, and inverts to the old map', () => {
    const ops = [
      {
        op: 'update' as const,
        field: 'body',
        locale: 'en-US',
        key: 'a',
        set: { _responsive: { md: { size: 'sm' } } },
      },
    ];
    const done = applyBlockPatch(page, fields, ops, () => 'k');
    if (!done.ok) throw new Error(JSON.stringify(done.issues));
    expect(done.fields.body?.['en-US']?.[0]).toMatchObject({ _responsive: { md: { size: 'sm' } } });
    const inverse = invertBlockPatch(page, fields, done.applied);
    if (!inverse.ok) throw new Error('not invertible');
    expect(inverse.ops).toEqual([
      {
        op: 'update',
        field: 'body',
        locale: 'en-US',
        key: 'a',
        set: { _responsive: { lg: { size: 'xl' } } },
      },
    ]);
    const unset = applyBlockPatch(
      page,
      fields,
      [{ op: 'update', field: 'body', locale: 'en-US', key: 'a', unset: ['_responsive'] }],
      () => 'k',
    );
    if (!unset.ok) throw new Error('refused');
    expect(unset.fields.body?.['en-US']?.[0]).not.toHaveProperty('_responsive');
  });

  it('refuses _responsive on a block with no responsive props', () => {
    const done = applyBlockPatch(
      page,
      fields,
      [{ op: 'update', field: 'body', locale: 'en-US', key: 's', set: { _responsive: {} } }],
      () => 'k',
    );
    expect(done).toMatchObject({ ok: false, issues: [{ code: 'unknown_field', key: 's' }] });
  });

  const lock = (freeze: BlockLock['freeze']): BlockLock => ({
    field: 'body',
    keys: ['a'],
    depth: 'subtree',
    freeze,
    lockedBy: 'x',
    lockedAt: '2026-11-10T00:00:00.000Z',
  });
  const edited = body([
    { _type: 'hero', _key: 'a', size: 'md', _responsive: { lg: { size: 'sm' } } },
    { _type: 'section', _key: 's', label: 'S', items: [] },
  ]);

  it('is refused in a frozen region and open in a structure-only one', () => {
    expect(blockLockIssues(page, [lock('all')], fields, edited)).toMatchObject([
      { code: 'region_frozen', key: 'a' },
    ]);
    expect(blockLockIssues(page, [lock('structure')], fields, edited)).toEqual([]);
  });

  it('lets the save drop a stale override in a frozen region', () => {
    const stale = body([
      {
        _type: 'hero',
        _key: 'a',
        size: 'md',
        _responsive: { lg: { size: 'xl' }, xl: { size: 'sm' } },
      },
      { _type: 'section', _key: 's', label: 'S', items: [] },
    ]);
    const saved = assignBlockKeys(page, stale, () => 'n');
    expect(saved).toEqual(fields);
    expect(blockLockIssues(page, [lock('all')], stale, saved)).toEqual([]);
  });
});
