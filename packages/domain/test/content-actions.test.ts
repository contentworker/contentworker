import { describe, expect, it } from 'vitest';
import {
  assertCanGrant,
  authorizeContent,
  authorizeTrash,
  blockLocksFor,
  CONTENT_ACTIONS,
  type ContentAction,
  type ContentTypeGrant,
  canAccessContentType,
  contentActionsFor,
  ENTRY_OPERATION_ACTIONS,
  fieldRulesFor,
  grantedActions,
  grantFor,
  grantsNoWider,
  type ListedContentAction,
  type Principal,
  ROLE_PRESET_DEFINITIONS,
  SCOPES,
} from '../src/index';

const roleWith = (...grants: ContentTypeGrant[]): Principal => ({
  spaceId: 's1',
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.spaceAdmin],
  contentGrants: grants,
});

const draft = { contentTypeApiId: 'post', publishedVersion: null };
const live = { contentTypeApiId: 'post', publishedVersion: 3 };

/** Every subset of the actions a grant could list before `delete` and `unpublish` existed. */
const LEGACY_LISTS: ListedContentAction[][] = [[], ['read'], ['write'], ['publish']]
  .flatMap((l) => [l, [...l, 'read']])
  .flatMap((l) => [l, [...l, 'write']])
  .flatMap((l) => [l, [...l, 'publish']])
  .map((l) => [...new Set(l)] as ListedContentAction[]);

/**
 * What each entry operation asked of a grant before this change: trashing was a write, purging and
 * unpublishing were publishes.
 */
const LEGACY_OPERATIONS: Record<string, (held: readonly ListedContentAction[]) => boolean> = {
  read: (h) => h.includes('read'),
  write: (h) => h.includes('write'),
  publish: (h) => h.includes('publish'),
  trash: (h) => h.includes('write'),
  purge: (h) => h.includes('publish'),
  unpublish: (h) => h.includes('publish'),
};

const NOW: Record<string, readonly ContentAction[]> = {
  read: ['read'],
  write: ['write'],
  publish: ['publish'],
  ...ENTRY_OPERATION_ACTIONS,
};

describe('finer content actions: delete and unpublish', () => {
  it('authorizes every operation exactly as before for a grant that withholds nothing', () => {
    for (const actions of LEGACY_LISTS) {
      const principal = roleWith({ contentTypeApiId: 'post', actions });
      for (const [operation, allowedBefore] of Object.entries(LEGACY_OPERATIONS)) {
        const needs = NOW[operation] as readonly ContentAction[];
        expect(
          canAccessContentType(principal, needs, 'post'),
          `${operation} with [${actions.join(', ')}]`,
        ).toBe(allowedBefore(actions));
      }
      // Trashing a live entry, too: no stored grant withholds unpublish.
      const trashLive = () => authorizeTrash(principal, live);
      if (LEGACY_OPERATIONS.trash?.(actions)) expect(trashLive).not.toThrow();
      else expect(trashLive).toThrow();
    }
  });

  it('gives every writing preset the five content actions on every type, and lock to managers up', () => {
    for (const def of ROLE_PRESET_DEFINITIONS) {
      const [grant] = def.contentGrants;
      expect(grant?.deniedActions).toBeUndefined();
      const held = grantedActions(grant as ContentTypeGrant);
      const locks = def.preset === 'manager' || def.preset === 'admin';
      const expected: ContentAction[] = def.contentGrants.some((g) => g.actions.includes('write'))
        ? CONTENT_ACTIONS.filter((a) => a !== 'lock' || locks)
        : ['read'];
      expect([...held].sort(), def.preset).toEqual([...expected].sort());
    }
  });

  it('never implies lock: a grant holds it only when it lists it', () => {
    const all: ContentTypeGrant = { contentTypeApiId: '*', actions: ['read', 'write', 'publish'] };
    expect(grantedActions(all).has('lock')).toBe(false);
    expect(grantedActions({ ...all, actions: [...all.actions, 'lock'] }).has('lock')).toBe(true);
  });

  it('implies delete from write or publish and unpublish from publish', () => {
    expect([...grantedActions({ contentTypeApiId: '*', actions: ['read'] })]).toEqual(['read']);
    expect(grantedActions({ contentTypeApiId: '*', actions: ['write'] })).toEqual(
      new Set(['write', 'delete']),
    );
    expect(grantedActions({ contentTypeApiId: '*', actions: ['publish'] })).toEqual(
      new Set(['publish', 'delete', 'unpublish']),
    );
  });

  it('lets a role write but not delete', () => {
    const writer = roleWith({
      contentTypeApiId: 'post',
      actions: ['read', 'write', 'publish'],
      deniedActions: ['delete'],
    });
    expect(() => authorizeContent(writer, 'write', 'post')).not.toThrow();
    expect(() => authorizeTrash(writer, draft)).toThrow(/content:delete:post/);
    expect(() => authorizeContent(writer, ENTRY_OPERATION_ACTIONS.purge, 'post')).toThrow(
      /content:delete:post/,
    );
    // Withholding delete leaves unpublish alone.
    expect(() => authorizeContent(writer, 'unpublish', 'post')).not.toThrow();
  });

  it('lets a role publish but not unpublish, including by trashing a live entry', () => {
    const publisher = roleWith({
      contentTypeApiId: 'post',
      actions: ['read', 'write', 'publish'],
      deniedActions: ['unpublish'],
    });
    expect(() => authorizeContent(publisher, 'publish', 'post')).not.toThrow();
    expect(() => authorizeContent(publisher, 'unpublish', 'post')).toThrow(
      /content:unpublish:post/,
    );
    // A draft is trashed as before; a live one would come down with it.
    expect(() => authorizeTrash(publisher, draft)).not.toThrow();
    expect(() => authorizeTrash(publisher, live)).toThrow(/content:unpublish:post/);
    expect(() => authorizeContent(publisher, ENTRY_OPERATION_ACTIONS.purge, 'post')).not.toThrow();
  });

  it('resolves the withhold on the grant that governs the type', () => {
    const principal = roleWith(
      { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
      { contentTypeApiId: '*', actions: ['read', 'write'] },
    );
    expect(canAccessContentType(principal, 'delete', 'post')).toBe(false);
    expect(canAccessContentType(principal, 'delete', 'page')).toBe(true);
  });

  it('passes unrestricted principals through every operation', () => {
    const root: Principal = { spaceId: '*', kind: 'admin', scopes: [] };
    for (const needs of Object.values(ENTRY_OPERATION_ACTIONS)) {
      expect(canAccessContentType(root, needs, 'post')).toBe(true);
    }
    expect(() => authorizeTrash(root, live)).not.toThrow();
  });

  it('keeps an inviter from handing out an action they withhold', () => {
    const inviter: Principal = {
      ...roleWith({
        contentTypeApiId: '*',
        actions: ['read', 'write', 'publish'],
        deniedActions: ['delete'],
      }),
      kind: 'user',
      subject: 'ada',
    };
    const grant = (contentGrants: ContentTypeGrant[]) => ({
      spaceId: 's1',
      scopes: [],
      contentGrants,
    });
    // Implies delete, which the inviter withholds.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]),
      ]),
    ).toThrow(/beyond your own/);
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([
          { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
        ]),
      ]),
    ).not.toThrow();
  });
  it('holds an inviter to the grant that governs each type, not any grant they hold', () => {
    const inviter: Principal = {
      ...roleWith(
        { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
        { contentTypeApiId: '*', actions: ['read', 'write'] },
      ),
      kind: 'user',
      subject: 'ada',
    };
    const grant = (contentGrants: ContentTypeGrant[]) => ({
      spaceId: 's1',
      scopes: [],
      contentGrants,
    });
    // Delete on post is withheld by the post grant; the wildcard's delete doesn't lend it.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]),
      ]),
    ).toThrow(/beyond your own/);
    // A wildcard would reach post too, where the inviter can't delete.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: '*', actions: ['read', 'write'] }]),
      ]),
    ).toThrow(/beyond your own/);
    // Within both: the wildcard everywhere but post, post as the inviter holds it.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([
          { contentTypeApiId: '*', actions: ['read', 'write'] },
          { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
        ]),
      ]),
    ).not.toThrow();
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: 'page', actions: ['read', 'write'] }]),
      ]),
    ).not.toThrow();
  });
});

describe('grantsNoWider', () => {
  const g = (actions: ListedContentAction[], rest: Partial<ContentTypeGrant> = {}) => ({
    contentTypeApiId: '*',
    actions,
    ...rest,
  });

  it('allows the same grants, and the same grants holding fewer actions', () => {
    expect(grantsNoWider([g(['read', 'write'])], [g(['read', 'write'])])).toBe(true);
    expect(grantsNoWider([g(['read', 'write'])], [g(['read', 'write', 'lock'])])).toBe(true);
    expect(grantsNoWider([g(['read'])], [g(['read', 'write', 'publish'])])).toBe(true);
    expect(grantsNoWider(undefined, [])).toBe(true);
  });

  it('refuses more actions, or an implied one a denial held back', () => {
    expect(grantsNoWider([g(['read', 'write', 'lock'])], [g(['read', 'write'])])).toBe(false);
    // Fewer listed, but no longer denying delete: write now deletes.
    expect(
      grantsNoWider(
        [g(['read', 'write'])],
        [g(['read', 'write', 'publish'], { deniedActions: ['delete'] })],
      ),
    ).toBe(false);
    expect(
      grantsNoWider(
        [g(['read', 'write'], { deniedActions: ['delete'] })],
        [g(['read', 'write', 'publish'], { deniedActions: ['delete'] })],
      ),
    ).toBe(true);
  });

  it('refuses dropping a denial the held grant names, even with publish gone', () => {
    expect(
      grantsNoWider(
        [g(['read', 'write'])],
        [g(['read', 'write', 'publish'], { deniedActions: ['unpublish'] })],
      ),
    ).toBe(false);
    expect(
      grantsNoWider(
        [g(['read', 'write'], { deniedActions: ['unpublish'] })],
        [g(['read', 'write', 'publish'], { deniedActions: ['unpublish'] })],
      ),
    ).toBe(true);
  });

  it('refuses fewer or more grants (no grants is unrestricted), another type, or other field rules', () => {
    expect(grantsNoWider([], [g(['read'])])).toBe(false);
    expect(
      grantsNoWider([g(['read']), g(['read'], { contentTypeApiId: 'post' })], [g(['read'])]),
    ).toBe(false);
    expect(grantsNoWider([g(['read'], { contentTypeApiId: 'post' })], [g(['read'])])).toBe(false);
    expect(grantsNoWider([g(['read'])], [g(['read'], { deniedFields: ['secret'] })])).toBe(false);
    expect(
      grantsNoWider([g(['read', 'write'])], [g(['read', 'write'], { readOnlyFields: ['slug'] })]),
    ).toBe(false);
    expect(
      grantsNoWider(
        [g(['read'], { deniedFields: ['b', 'a'] })],
        [g(['read', 'write'], { deniedFields: ['a', 'b'] })],
      ),
    ).toBe(true);
  });
});

describe('blockLocksFor', () => {
  const locks = [
    { field: 'body', keys: ['a'], lockedBy: 'user:1' },
    { field: 'secret', keys: ['b'], lockedBy: 'user:1' },
  ];
  it('keeps every lock, and who locked it, for a writer', () => {
    expect(blockLocksFor({ kind: 'key', scopes: [SCOPES.contentWrite] }, 'page', locks)).toEqual(
      locks,
    );
  });
  it('drops who locked it for a reader that doesn’t see who wrote what', () => {
    expect(blockLocksFor({ kind: 'key', scopes: [SCOPES.previewRead] }, 'page', locks)).toEqual([
      { field: 'body', keys: ['a'] },
      { field: 'secret', keys: ['b'] },
    ]);
  });
  it('drops the locks on a field the grant denies', () => {
    const principal = {
      kind: 'key' as const,
      scopes: [SCOPES.contentWrite],
      contentGrants: [
        { contentTypeApiId: 'page', actions: ['read' as const], deniedFields: ['secret'] },
      ],
    };
    expect(blockLocksFor(principal, 'page', locks)).toEqual([locks[0]]);
  });
});

describe('contentActionsFor', () => {
  it('holds every action on every type without grants', () => {
    expect(contentActionsFor({})).toEqual({ types: {}, others: CONTENT_ACTIONS });
  });
  it('resolves each type as authorizeContent does: its own grant, else the first `*`', () => {
    const grants: ContentTypeGrant[] = [
      { contentTypeApiId: 'page', actions: ['read', 'write', 'lock'] },
      {
        contentTypeApiId: '*',
        actions: ['read', 'write', 'publish'],
        deniedActions: ['unpublish'],
      },
      // A second grant for a type already named never applies.
      { contentTypeApiId: 'page', actions: ['read'] },
      { contentTypeApiId: '*', actions: ['read'] },
    ];
    const view = contentActionsFor({ contentGrants: grants });
    expect(view).toEqual({
      types: { page: ['read', 'write', 'lock', 'delete'] },
      others: ['read', 'write', 'publish', 'delete'],
    });
    const principal = roleWith(...grants);
    for (const type of ['page', 'post']) {
      for (const action of CONTENT_ACTIONS) {
        expect((view.types[type] ?? view.others).includes(action), `${type} ${action}`).toBe(
          canAccessContentType(principal, action, type),
        );
      }
    }
  });
  it('holds nothing on a type no grant names without a `*` grant', () => {
    expect(
      contentActionsFor({ contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }] }),
    ).toEqual({ types: { page: ['read'] }, others: [] });
  });
});

describe('fieldRulesFor', () => {
  it('restricts no field without grants', () => {
    expect(fieldRulesFor({})).toEqual({
      types: {},
      others: { deniedFields: [], readOnlyFields: [] },
    });
  });
  it('resolves each type as grantFor does: its own grant, else the first `*`', () => {
    const grants: ContentTypeGrant[] = [
      {
        contentTypeApiId: 'page',
        actions: ['read', 'write'],
        deniedFields: ['salary'],
        readOnlyFields: ['slug', 'slug'],
      },
      { contentTypeApiId: '*', actions: ['read', 'write'], readOnlyFields: ['owner'] },
      // A second grant for a type already named never applies.
      { contentTypeApiId: 'page', actions: ['read'], deniedFields: ['title'] },
      { contentTypeApiId: '*', actions: ['read'], deniedFields: ['title'] },
    ];
    const view = fieldRulesFor({ contentGrants: grants });
    expect(view).toEqual({
      types: { page: { deniedFields: ['salary'], readOnlyFields: ['slug'] } },
      others: { deniedFields: [], readOnlyFields: ['owner'] },
    });
    const principal = roleWith(...grants);
    for (const type of ['page', 'post']) {
      const grant = grantFor(principal, type);
      const rules = view.types[type] ?? view.others;
      expect(rules.deniedFields).toEqual(grant?.deniedFields ?? []);
      expect(new Set(rules.readOnlyFields)).toEqual(new Set(grant?.readOnlyFields ?? []));
    }
  });
  it('names a type a grant names even when it restricts no field there', () => {
    expect(
      fieldRulesFor({
        contentGrants: [
          { contentTypeApiId: 'page', actions: ['read', 'write'] },
          { contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] },
        ],
      }),
    ).toEqual({
      // The `*` grant's rules don't reach a type with a grant of its own.
      types: { page: { deniedFields: [], readOnlyFields: [] } },
      others: { deniedFields: ['salary'], readOnlyFields: [] },
    });
  });
});
