// What a slot offers under the block config, for the canvas and the form alike: the narrowed
// blocks, the tighter bounds, a lock that holds only what was stored, stale parts ignored, a
// former id followed; the config rebuilt from the rules judges a save as the server does; a
// refusal read from the api or from Coworker; and the canvas's tree, seams, dock and checks under it.
import {
  type BlockCatalog,
  type BlockConfig,
  blockConfigIssues,
  type ContentType,
  EMPTY_BLOCK_CONFIG,
  type EntryFields,
  effectiveBlockRules,
} from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  configIssues,
  configOf,
  configRefusal,
  NOTHING_STORED,
  ruleFor,
  slotPolicy,
  storedSlots,
  wasStored,
} from '~/cms/lib/block-rules';
import { canvasChecks } from '~/cms/lib/canvas/checks';
import { dockGroups } from '~/cms/lib/canvas/dock';
import {
  canDuplicate,
  canMove,
  canRemove,
  canvasTree,
  findBlock,
  findSlot,
  slotFill,
} from '~/cms/lib/canvas/model';
import { seamsFrom } from '~/cms/lib/canvas/seams';
import { ApiError } from '~/cms/lib/management';
import { pageFields, pageType, ref, refCtx } from './canvas-fixture';

/** The fixture's page, as a catalog push would have made it: the section's items are a slot. */
const catalog = {
  version: 2,
  hash: 'h',
  pushedAt: '2026-11-01T00:00:00Z',
  pushedBy: null,
  changes: { added: [], changed: [], removed: [], renamed: [] },
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  blocks: [
    { id: 'hero', name: 'Hero banner', group: 'Headers', aliases: ['banner'], fields: [] },
    { id: 'cta', name: 'Call to action', group: 'Actions', fields: [] },
    {
      id: 'section',
      name: 'Section',
      fields: [],
      slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], min: 1, max: 2 }],
    },
    { id: 'card', name: 'Card', allowedParents: ['section'], fields: [] },
  ],
} as unknown as BlockCatalog;

const config = (
  over: Partial<BlockConfig>,
): Pick<BlockConfig, 'version' | 'targets' | 'blocks'> => ({
  version: 3,
  targets: [],
  blocks: [],
  ...over,
});

/** The top level takes heroes and sections only, at most 4; the section's items are locked. */
const NARROWED = effectiveBlockRules(
  catalog,
  config({
    targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'section'], max: 4 }],
    blocks: [{ block: 'section', slots: { items: { locked: true } } }],
  }),
);

/** The page with a call to action added at the end and a second card in the section. */
function editedPage(): EntryFields {
  const fields = structuredClone(pageFields()) as EntryFields;
  const body = (fields.body as Record<string, Record<string, unknown>[]>)['en-US'] ?? [];
  body.push({ _type: 'cta', _key: 'a2', label: 'Again' });
  const items = body[1]?.items;
  if (Array.isArray(items)) items.push({ _type: 'card', _key: 'c2', title: 'Two' });
  return fields;
}

const variants = (pageType.fields[1]?.items?.variants ?? []) as NonNullable<
  NonNullable<ContentType['fields'][number]['items']>['variants']
>;

describe('the rule for a slot', () => {
  it('finds a target’s top level and a block’s slot, and nothing elsewhere', () => {
    expect(ruleFor(NARROWED, { contentType: 'page', field: 'body' })).toMatchObject({
      allowedChildren: ['hero', 'section'],
      max: 4,
      locked: false,
      narrowed: true,
    });
    expect(ruleFor(NARROWED, { block: 'section', slot: 'items' })).toMatchObject({
      allowedChildren: ['card'],
      min: 1,
      max: 2,
      locked: true,
    });
    expect(ruleFor(NARROWED, { contentType: 'post', field: 'body' })).toBeUndefined();
    expect(ruleFor(NARROWED, { block: 'hero', slot: 'items' })).toBeUndefined();
    expect(ruleFor(null, { contentType: 'page', field: 'body' })).toBeUndefined();
  });

  it('ignores the stale parts of a config: the code’s rule applies there', () => {
    const rules = effectiveBlockRules(
      catalog,
      config({
        targets: [
          { contentTypeApiId: 'page', field: 'body', blocks: ['gone'] },
          { contentTypeApiId: 'post', field: 'body', locked: true },
        ],
        blocks: [{ block: 'section', slots: { items: { max: 9 }, gone: { locked: true } } }],
      }),
    );
    expect(rules.stale.length).toBeGreaterThan(0);
    const top = slotPolicy(
      variants,
      undefined,
      ruleFor(rules, { contentType: 'page', field: 'body' }),
      true,
    );
    expect(top.offers.map((v) => v.apiId)).toEqual(['hero', 'cta', 'section']);
    expect(top.locked).toBe(false);
  });

  it('follows a block renamed since the config named it', () => {
    const rules = effectiveBlockRules(
      catalog,
      config({ targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['banner'] }] }),
    );
    // "banner" is the hero's former id: the narrowing holds, under the id the catalog has now.
    expect(ruleFor(rules, { contentType: 'page', field: 'body' })?.allowedChildren).toEqual([
      'hero',
    ]);
    expect(rules.stale).toEqual([]);
  });
});

describe('a slot’s policy', () => {
  const top = ruleFor(NARROWED, { contentType: 'page', field: 'body' });

  it('offers only the narrowed blocks, in the field’s order', () => {
    expect(slotPolicy(variants, undefined, top, true).offers.map((v) => v.apiId)).toEqual([
      'hero',
      'section',
    ]);
    // Without a rule, the field's own.
    expect(slotPolicy(variants, undefined, undefined, true).offers).toHaveLength(3);
  });

  it('takes the tighter of the field’s bounds and the config’s', () => {
    expect(slotPolicy(variants, { max: 8 }, top, true)).toMatchObject({ max: 4 });
    expect(slotPolicy(variants, { max: 3 }, top, true)).toMatchObject({ max: 3 });
    expect(slotPolicy(variants, { min: 2 }, top, true)).toMatchObject({ min: 2, max: 4 });
  });

  it('locks only a slot that was stored', () => {
    const items = ruleFor(NARROWED, { block: 'section', slot: 'items' });
    expect(slotPolicy(variants, undefined, items, true).locked).toBe(true);
    // One that comes into being in this edit (a section just placed) is filled as it comes.
    expect(slotPolicy(variants, undefined, items, false).locked).toBe(false);
  });
});

describe('the stored slots', () => {
  it('names the fields holding blocks and every stored block, nested ones too', () => {
    const stored = storedSlots(pageType, pageFields(), 'en-US', 'en-US');
    expect([...stored.fields]).toEqual(['body']);
    expect([...stored.blocks].sort()).toEqual(['a1', 'c1', 'h1', 's1']);
    expect(wasStored(stored, { field: 'body' })).toBe(true);
    expect(wasStored(stored, { field: 'body', parentKey: 's1' })).toBe(true);
    expect(wasStored(stored, { field: 'body', parentKey: 'new' })).toBe(false);
  });

  it('holds nothing for a new entry, or a field stored empty', () => {
    expect(storedSlots(pageType, undefined, 'en-US', 'en-US')).toBe(NOTHING_STORED);
    const empty = storedSlots(pageType, { body: { 'en-US': [] } }, 'en-US', 'en-US');
    expect(wasStored(empty, { field: 'body' })).toBe(false);
  });

  it('walks a block stored under a former id of its variant', () => {
    const renamed = {
      ...pageType,
      fields: pageType.fields.map((f) =>
        f.apiId === 'body' && f.items?.variants
          ? {
              ...f,
              items: {
                ...f.items,
                variants: f.items.variants.map((v) =>
                  v.apiId === 'section' ? { ...v, aliases: ['band'] } : v,
                ),
              },
            }
          : f,
      ),
    } as ContentType;
    const stored = storedSlots(
      renamed,
      {
        body: { 'en-US': [{ _type: 'band', _key: 'b1', items: [{ _type: 'card', _key: 'k1' }] }] },
      },
      'en-US',
      'en-US',
    );
    expect(stored.blocks.has('k1')).toBe(true);
  });
});

describe('judging a save as the server will', () => {
  it('rebuilds a config that lays out to the same rules', () => {
    const again = effectiveBlockRules(catalog, configOf(NARROWED));
    expect(again.targets).toEqual(NARROWED.targets);
    expect(again.blocks).toEqual(NARROWED.blocks);
    expect(configOf(effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG))).toMatchObject({
      targets: [],
      blocks: [],
    });
  });

  it('refuses what the server refuses, and lets stored content be', () => {
    const before = pageFields();
    // The stored call to action isn't allowed at the top level any more, but it stays saveable.
    expect(configIssues(pageType, catalog, NARROWED, before, before)).toEqual([]);
    const after = editedPage();
    const issues = configIssues(pageType, catalog, NARROWED, before, after);
    expect(issues.map((i) => i.code).sort()).toEqual(['block_not_allowed_here', 'slot_locked']);
    // Exactly the domain's judgement over the stored config.
    const stored = config({
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'section'], max: 4 }],
      blocks: [{ block: 'section', slots: { items: { locked: true } } }],
    });
    expect(issues).toEqual(blockConfigIssues(pageType, catalog, stored, before, after));
  });

  it('judges nothing over another catalog than the rules were read with', () => {
    const after = structuredClone(pageFields()) as EntryFields;
    ((after.body as Record<string, unknown[]>)['en-US'] as unknown[]).push({ _type: 'cta' });
    expect(
      configIssues(pageType, { ...catalog, version: 9 }, NARROWED, pageFields(), after),
    ).toEqual([]);
    expect(configIssues(pageType, null, NARROWED, pageFields(), after)).toEqual([]);
  });
});

describe('a refused save', () => {
  const body = {
    error: {
      code: 'validation_failed',
      message: 'Validation failed',
      issues: [
        {
          field: 'body[2]',
          locale: 'en-US',
          code: 'block_not_allowed_here',
          key: 'a1',
          message: 'no',
        },
        { field: 'title', message: 'is required' },
      ],
    },
  };

  it('reads the config’s issues from the api, and from Coworker’s tool error', () => {
    expect(configRefusal(new ApiError(422, 'Validation failed', body))).toEqual([
      body.error.issues[0],
    ]);
    expect(configRefusal(new Error(JSON.stringify(body)))).toEqual([body.error.issues[0]]);
  });

  it('reads nothing from any other failure', () => {
    expect(configRefusal(new ApiError(409, 'Conflict', body))).toEqual([]);
    expect(configRefusal(new Error('The network went away'))).toEqual([]);
    expect(configRefusal(new ApiError(422, 'Validation failed', { error: {} }))).toEqual([]);
  });
});

describe('the canvas under the config', () => {
  const under = { rules: NARROWED, stored: pageFields() };
  const slots = canvasTree(pageType, pageFields(), 'en-US', 'en-US', under);

  it('offers the narrowed blocks in the dock, a stored call to action staying put', () => {
    const main = slots[0];
    if (!main) throw new Error('no main slot');
    expect(main.offers.map((v) => v.apiId)).toEqual(['hero', 'section']);
    expect(main.max).toBe(4);
    expect(slotFill(main)).toBe('Main · 3 of 4');
    expect(main.blocks.map((b) => b.key)).toEqual(['h1', 's1', 'a1']);
    // Ungrouped first, then each group: the call to action's group isn't offered at all.
    expect(dockGroups(main, catalog).flatMap((g) => g.items.map((i) => i.variant.apiId))).toEqual([
      'section',
      'hero',
    ]);
    // The call to action stays editable, but no copy of it can go here.
    const cta = findBlock(slots, 'a1');
    expect(cta?.variant?.apiId).toBe('cta');
    expect(cta && canDuplicate(cta)).toBe(false);
    const hero = findBlock(slots, 'h1');
    expect(hero && canDuplicate(hero)).toBe(true);
  });

  it('locks the stored section’s items: no dock, no seams, no move, remove or duplicate', () => {
    const items = findSlot(slots, 'body[s1].items');
    if (!items) throw new Error('no items slot');
    expect(items.locked).toBe(true);
    expect(slotFill(items)).toBe('Items · 1 of 1–2 · locked');
    expect(dockGroups(items, catalog)).toEqual([]);
    const card = findBlock(slots, 'c1');
    if (!card) throw new Error('no card');
    expect([canMove(card, 1), canRemove(card), canDuplicate(card)]).toEqual([false, false, false]);
    const geometry = {
      truncated: false,
      blocks: [],
      slots: [
        {
          ref: ref('body'),
          rect: { x: 0, y: 0, w: 1, h: 1 },
          gaps: [{ index: 1, axis: 'y' as const, after: 'h1', rect: { x: 0, y: 0, w: 1, h: 1 } }],
        },
        {
          ref: ref('body[s1].items'),
          rect: { x: 0, y: 0, w: 1, h: 1 },
          gaps: [{ index: 1, axis: 'y' as const, after: 'c1', rect: { x: 0, y: 0, w: 1, h: 1 } }],
        },
      ],
    };
    expect(seamsFrom(geometry, slots, refCtx).map((s) => s.id)).toEqual(['body#1']);
  });

  it('leaves a section placed in this edit unlocked, to be filled as it comes', () => {
    const fields = structuredClone(pageFields()) as EntryFields;
    ((fields.body as Record<string, unknown[]>)['en-US'] as unknown[]).push({
      _type: 'section',
      _key: 's2',
      items: [],
    });
    const tree = canvasTree(pageType, fields, 'en-US', 'en-US', under);
    expect(findSlot(tree, 'body[s2].items')?.locked).toBe(false);
  });

  it('says in the checks what the config refuses, on the block or the slot', () => {
    const fields = editedPage();
    const tree = canvasTree(pageType, fields, 'en-US', 'en-US', under);
    const checks = canvasChecks(pageType, fields, tree, {
      locales: ['en-US'],
      defaultLocale: 'en-US',
      locale: 'en-US',
      previous: pageFields(),
      blocks: { catalog, rules: NARROWED },
    });
    expect(checks).toEqual([
      {
        id: 'config:block_not_allowed_here:body[3]:en-US',
        message: 'Call to action can’t go in Main: the block config doesn’t allow it there',
        blockKey: 'a2',
      },
      {
        id: 'config:slot_locked:body[1].items:en-US',
        message:
          'Items is locked: its blocks can’t be added, removed or moved. Undo the change to save',
        blockKey: 's1',
      },
    ]);
  });

  it('narrows the too-few check to the config’s least, for the slot an edit shrank', () => {
    const rules = effectiveBlockRules(
      catalog,
      config({ targets: [{ contentTypeApiId: 'page', field: 'body', min: 3 }] }),
    );
    const fields = structuredClone(pageFields()) as EntryFields;
    ((fields.body as Record<string, unknown[]>)['en-US'] as unknown[]).pop();
    const tree = canvasTree(pageType, fields, 'en-US', 'en-US', { rules, stored: pageFields() });
    const run = (refused?: Parameters<typeof canvasChecks>[3]['refused']) =>
      canvasChecks(pageType, fields, tree, {
        locales: ['en-US'],
        defaultLocale: 'en-US',
        locale: 'en-US',
        previous: pageFields(),
        blocks: { catalog, rules },
        ...(refused ? { refused } : {}),
      });
    expect(run()).toEqual([
      { id: 'config:slot_too_few:body:en-US', message: 'Main needs at least 3 blocks here' },
    ]);
    // The server's refusal of the same thing is said once.
    expect(
      run([{ field: 'body', locale: 'en-US', code: 'slot_too_few', message: 'at least 3' }]),
    ).toHaveLength(1);
    // Stored as it was, the slot isn't judged by the config's least: content may predate it.
    const unchanged = canvasTree(pageType, pageFields(), 'en-US', 'en-US', {
      rules: effectiveBlockRules(
        catalog,
        config({ targets: [{ contentTypeApiId: 'page', field: 'body', min: 4 }] }),
      ),
      stored: pageFields(),
    });
    expect(
      canvasChecks(pageType, pageFields(), unchanged, {
        locales: ['en-US'],
        defaultLocale: 'en-US',
        locale: 'en-US',
        previous: pageFields(),
        blocks: {
          catalog,
          rules: effectiveBlockRules(
            catalog,
            config({ targets: [{ contentTypeApiId: 'page', field: 'body', min: 4 }] }),
          ),
        },
      }),
    ).toEqual([]);
  });

  it('points a server refusal at the block it names', () => {
    const tree = canvasTree(pageType, pageFields(), 'en-US', 'en-US', under);
    const checks = canvasChecks(pageType, pageFields(), tree, {
      locales: ['en-US'],
      defaultLocale: 'en-US',
      locale: 'en-US',
      previous: pageFields(),
      refused: [
        {
          field: 'body[0]',
          locale: 'en-US',
          code: 'block_not_allowed_here',
          key: 'h1',
          message: '"Hero" can’t go here',
        },
        { field: '', code: 'more_issues', message: '…and 3 more the block config refuses' },
      ],
    });
    expect(checks).toEqual([
      {
        id: 'config:block_not_allowed_here:body[0]:en-US',
        message: 'Hero can’t go in Main: the block config doesn’t allow it there',
        blockKey: 'h1',
      },
      { id: 'config:more_issues::en-US', message: '…and 3 more the block config refuses' },
    ]);
  });
});
