import { describe, expect, it } from 'vitest';
import {
  type ContentAction,
  type ContentTypeGrant,
  contentActionsFor,
  fieldRulesFor,
  holdsOnEveryContentType,
  holdsOnEveryResolvedType,
  PROMOTION_CONTENT_ACTIONS,
  type Principal,
  promotionChangesSchema,
  promotionContentActions,
  rolePresetDefinition,
  SCOPES,
} from '../src/index';

/**
 * What requesting and deciding a promotion ask of a role, and the resolved-grants form of "every
 * content type alike" the admin asks before offering Approve or Reject. The api decides with the
 * grants themselves; the admin holds only what `auth/me` resolves them to.
 */
const member = (contentGrants: readonly ContentTypeGrant[] | undefined): Principal => ({
  spaceId: 's1',
  kind: 'user',
  scopes: [SCOPES.contentPublish],
  ...(contentGrants ? { contentGrants } : {}),
});
const resolved = (p: Principal) => ({
  contentActions: contentActionsFor(p),
  fieldRules: fieldRulesFor(p),
});

const WRITES = ['read', 'write', 'publish'] as const;
const SHAPES: Record<string, readonly ContentTypeGrant[] | undefined> = {
  unrestricted: undefined,
  'no grants': [],
  viewer: rolePresetDefinition('viewer').contentGrants,
  editor: rolePresetDefinition('editor').contentGrants,
  manager: rolePresetDefinition('manager').contentGrants,
  'one type': [{ contentTypeApiId: 'post', actions: WRITES }],
  '`*` and a type': [
    { contentTypeApiId: '*', actions: [...WRITES, 'lock'] },
    { contentTypeApiId: 'post', actions: [...WRITES, 'lock'] },
  ],
  'a hidden field': [{ contentTypeApiId: '*', actions: WRITES, deniedFields: ['salary'] }],
  'a read-only field': [{ contentTypeApiId: '*', actions: WRITES, readOnlyFields: ['slug'] }],
  'a type named constructor': [{ contentTypeApiId: 'constructor', actions: WRITES }],
  'a type named __proto__': [{ contentTypeApiId: '__proto__', actions: WRITES }],
  'write withheld from delete': [
    { contentTypeApiId: '*', actions: WRITES, deniedActions: ['delete'] },
  ],
  'publish withheld from unpublish': [
    { contentTypeApiId: '*', actions: WRITES, deniedActions: ['unpublish'] },
  ],
};
const ASKS: readonly (readonly ContentAction[])[] = [
  PROMOTION_CONTENT_ACTIONS,
  [...PROMOTION_CONTENT_ACTIONS, 'lock'],
  ['unpublish'],
  ['write', 'delete'],
];

describe('every content type alike, over resolved grants', () => {
  it.each(Object.entries(SHAPES))('answers as the grants do for %s', (_, grants) => {
    const p = member(grants);
    for (const actions of ASKS) {
      expect(holdsOnEveryResolvedType(resolved(p), actions)).toBe(
        holdsOnEveryContentType(p, actions),
      );
    }
  });

  it('lets the presets that write decide, and only those that lock approve entries', () => {
    const editor = resolved(member(SHAPES.editor));
    const manager = resolved(member(SHAPES.manager));
    const entries = promotionContentActions({ entries: [{}] });
    expect(holdsOnEveryResolvedType(editor, PROMOTION_CONTENT_ACTIONS)).toBe(true);
    expect(holdsOnEveryResolvedType(editor, entries)).toBe(false);
    expect(holdsOnEveryResolvedType(manager, entries)).toBe(true);
  });

  it('can’t see a second `*` grant, which the api refuses', () => {
    const twice = member([
      { contentTypeApiId: '*', actions: WRITES },
      { contentTypeApiId: '*', actions: ['read'] },
    ]);
    expect(holdsOnEveryContentType(twice, WRITES)).toBe(false);
    expect(holdsOnEveryResolvedType(resolved(twice), WRITES)).toBe(true);
  });
});

describe('what a promotion asks of its approver', () => {
  it('asks `lock` too only when it carries entries', () => {
    expect(promotionContentActions({ entries: [] })).toEqual(['read', 'write', 'publish']);
    expect(promotionContentActions({ entries: [{}] })).toEqual([
      'read',
      'write',
      'publish',
      'lock',
    ]);
  });

  it('changes the schema when it carries content types or blocks', () => {
    const blocks = { catalog: 1, config: 1 } as never;
    expect(promotionChangesSchema({ contentTypes: [] })).toBe(false);
    expect(promotionChangesSchema({ contentTypes: [{ apiId: 'post', version: 1 }] })).toBe(true);
    expect(promotionChangesSchema({ contentTypes: [], blocks })).toBe(true);
  });
});
