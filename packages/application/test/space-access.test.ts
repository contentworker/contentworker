import { ForbiddenError, type Principal, SCOPES } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { spaceAccessFor } from '../src/space-access';

const member: Principal = {
  spaceId: 's1',
  kind: 'user',
  subject: 'usr_1',
  scopes: [SCOPES.contentWrite, SCOPES.previewRead],
  contentGrants: [
    {
      contentTypeApiId: 'article',
      actions: ['read', 'write'],
      deniedFields: ['salary'],
      readOnlyFields: ['slug'],
    },
    { contentTypeApiId: '*', actions: ['read'] },
  ],
};

describe('spaceAccessFor', () => {
  it('names the fields each type hides or makes read-only, never their values', () => {
    const access = spaceAccessFor(member, 's1');
    expect(access).toMatchObject({
      spaceId: 's1',
      kind: 'user',
      subject: 'usr_1',
      restricted: true,
      bulkJobs: [],
      contentActions: { types: { article: ['read', 'write', 'delete'] }, others: ['read'] },
      fieldRules: {
        types: { article: { deniedFields: ['salary'], readOnlyFields: ['slug'] } },
        others: { deniedFields: [], readOnlyFields: [] },
      },
    });
  });

  it('restricts nothing for a principal without grants', () => {
    const admin: Principal = { spaceId: '*', kind: 'admin', scopes: [SCOPES.spaceAdmin] };
    expect(spaceAccessFor(admin, 's2')).toMatchObject({
      restricted: false,
      fieldRules: { types: {}, others: { deniedFields: [], readOnlyFields: [] } },
    });
  });

  it('refuses a caller with no standing in the space', () => {
    expect(() => spaceAccessFor(member, 's2')).toThrow(ForbiddenError);
  });
});
