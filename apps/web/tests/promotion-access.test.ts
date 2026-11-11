import { contentActionsFor, fieldRulesFor, type Promotion } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import type { PrincipalInfo } from '~/cms/lib/management';
import { promotionControls } from '~/cms/lib/promotion-access';

/**
 * Who sees Approve, Reject and Withdraw on a waiting promotion: what the api's
 * `approvePromotion` and `rejectPromotion` would let them do, read off `auth/me` as it resolves
 * a role's grants.
 */
type Grants = Parameters<typeof contentActionsFor>[0]['contentGrants'];
const access = (opts: {
  grants?: Grants;
  scopes?: string[];
  subject?: string;
  kind?: string;
}): PrincipalInfo => {
  const grants = { ...(opts.grants ? { contentGrants: opts.grants } : {}) };
  return {
    spaceId: 'space-1',
    kind: opts.kind ?? 'user',
    subject: opts.subject ?? 'usr_me',
    scopes: opts.scopes ?? ['content:publish', 'content:manage'],
    restricted: opts.grants !== undefined,
    contentActions: contentActionsFor(grants),
    fieldRules: fieldRulesFor(grants),
  };
};

const ALL = ['read', 'write', 'publish', 'lock'] as const;
const WRITES = ['read', 'write', 'publish'] as const;
const manager = [{ contentTypeApiId: '*', actions: ALL }];
const editor = [{ contentTypeApiId: '*', actions: WRITES }];

type Decided = Pick<Promotion, 'requestedBy' | 'contentTypes' | 'entries' | 'blocks'>;
const entry = { entryId: 'e1', contentTypeApiId: 'article', version: 2, publish: true };
const entriesOnly: Decided = { requestedBy: 'usr_other', contentTypes: [], entries: [entry] };
const withTypes: Decided = { ...entriesOnly, contentTypes: [{ apiId: 'article', version: 3 }] };
const typesOnly: Decided = { ...withTypes, entries: [] };

const offered = (a: PrincipalInfo | undefined, p: Decided) => {
  const c = promotionControls(a, p);
  return { approve: c.approve, reject: c.reject, withdraw: c.withdraw };
};

describe('who may decide a waiting promotion', () => {
  it('offers Approve and Reject to a manager who didn’t request it', () => {
    for (const p of [entriesOnly, withTypes, typesOnly]) {
      expect(promotionControls(access({ grants: manager }), p)).toEqual({
        approve: true,
        reject: true,
        withdraw: false,
      });
    }
    // No role at all (the deployment admin): every type, every action.
    expect(offered(access({ kind: 'admin' }), withTypes)).toEqual({
      approve: true,
      reject: true,
      withdraw: false,
    });
  });

  it('offers nothing to a role short of read, write and publish on every type', () => {
    const shortOf = [
      [{ contentTypeApiId: 'article', actions: ALL }],
      [...manager, { contentTypeApiId: 'post', actions: ['read'] as const }],
      [{ contentTypeApiId: '*', actions: ALL, deniedFields: ['salary'] }],
      [{ contentTypeApiId: '*', actions: ALL, readOnlyFields: ['slug'] }],
      [{ contentTypeApiId: '*', actions: ['read', 'write'] as const }],
    ];
    for (const grants of shortOf) {
      expect(promotionControls(access({ grants }), entriesOnly)).toEqual({
        approve: false,
        reject: false,
        withdraw: false,
        rejectGap: 'role',
      });
    }
  });

  it('offers only Reject on entries to a role without `lock` on every type', () => {
    expect(promotionControls(access({ grants: editor }), entriesOnly)).toEqual({
      approve: false,
      reject: true,
      withdraw: false,
      approveGap: 'lock',
    });
    // Without entries, approving asks no `lock`.
    expect(offered(access({ grants: editor }), typesOnly)).toEqual({
      approve: true,
      reject: true,
      withdraw: false,
    });
  });

  it('offers neither to a role without content:manage when it carries types or blocks', () => {
    const publisher = access({ grants: manager, scopes: ['content:publish'] });
    const blocks = { ...entriesOnly, blocks: { catalog: 1, config: 1 } } as unknown as Decided;
    for (const p of [withTypes, typesOnly, blocks]) {
      expect(promotionControls(publisher, p)).toEqual({
        approve: false,
        reject: false,
        withdraw: false,
        rejectGap: 'manage',
      });
    }
    expect(offered(publisher, entriesOnly)).toEqual({
      approve: true,
      reject: true,
      withdraw: false,
    });
  });

  it('offers nothing to a role without content:publish, which both routes take', () => {
    expect(promotionControls(access({ scopes: ['content:manage'] }), entriesOnly).rejectGap).toBe(
      'role',
    );
  });

  it('offers its requester only Withdraw, whatever their grants', () => {
    // Withdrawing asks no decide rights: a role narrowed to one type, without lock or manage.
    const narrow = access({
      grants: [{ contentTypeApiId: 'article', actions: ['read'] }],
      scopes: ['content:publish'],
      subject: 'usr_other',
    });
    expect(promotionControls(narrow, withTypes)).toEqual({
      approve: false,
      reject: false,
      withdraw: true,
    });
    expect(promotionControls(access({ grants: manager, subject: 'usr_other' }), withTypes)).toEqual(
      { approve: false, reject: false, withdraw: true },
    );
    // Both routes still take content:publish.
    const noPublish = access({ subject: 'usr_other', scopes: ['content:write'] });
    expect(offered(noPublish, withTypes)).toEqual({
      approve: false,
      reject: false,
      withdraw: false,
    });
  });

  it('offers nothing to a session that isn’t a person (an API key), requester or not', () => {
    for (const subject of ['usr_other', 'key_1']) {
      expect(offered(access({ kind: 'cma', subject }), entriesOnly)).toEqual({
        approve: false,
        reject: false,
        withdraw: false,
      });
    }
  });

  it('offers nothing until the access is read, or when it lacks the resolved grants', () => {
    expect(promotionControls(undefined, entriesOnly)).toEqual({
      approve: false,
      reject: false,
      withdraw: false,
    });
    const { contentActions: _, ...older } = access({ grants: manager });
    expect(offered(older, entriesOnly)).toEqual({ approve: false, reject: false, withdraw: false });
  });
});
