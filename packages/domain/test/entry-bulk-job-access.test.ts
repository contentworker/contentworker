import { describe, expect, it } from 'vitest';
import {
  type ContentTypeGrant,
  canRunEntryBulkJob,
  ENTRY_BULK_JOB_KINDS,
  entryBulkJobsFor,
  type Principal,
  rolePresetDefinition,
  SCOPES,
} from '../src/index';

/**
 * Who may run a bulk job over entries: no per-type grants, or exactly one `*` grant holding every
 * action the job needs and restricting no field. A job can't be authorized entry by entry, and its
 * report names entries of every type.
 */
const member = (contentGrants: readonly ContentTypeGrant[] | undefined): Principal => ({
  spaceId: 's1',
  kind: 'user',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
  ...(contentGrants ? { contentGrants } : {}),
});
const preset = (name: 'viewer' | 'editor' | 'manager' | 'admin') =>
  member(rolePresetDefinition(name).contentGrants);

describe('who may run a bulk job over entries', () => {
  it('lets a principal with no per-type grants run every kind', () => {
    expect(entryBulkJobsFor(member(undefined))).toEqual(ENTRY_BULK_JOB_KINDS);
  });

  it('lets the Administrator, Manager and Editor presets run every kind', () => {
    for (const name of ['admin', 'manager', 'editor'] as const) {
      expect(entryBulkJobsFor(preset(name)), name).toEqual([
        'publish',
        'unpublish',
        'trash',
        'restore',
        'purge',
      ]);
    }
  });

  it('refuses the Viewer preset every kind', () => {
    expect(entryBulkJobsFor(preset('viewer'))).toEqual([]);
  });

  it('refuses trash and purge to a `*` grant that withholds delete', () => {
    const p = member([
      { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], deniedActions: ['delete'] },
    ]);
    expect(canRunEntryBulkJob(p, 'trash')).toBe(false);
    expect(canRunEntryBulkJob(p, 'purge')).toBe(false);
    expect(canRunEntryBulkJob(p, 'restore')).toBe(true);
    expect(canRunEntryBulkJob(p, 'publish')).toBe(true);
  });

  it('refuses unpublish to a `*` grant that withholds it, and everything but restore to a writer', () => {
    const noUnpublish = member([
      {
        contentTypeApiId: '*',
        actions: ['read', 'write', 'publish'],
        deniedActions: ['unpublish'],
      },
    ]);
    expect(canRunEntryBulkJob(noUnpublish, 'unpublish')).toBe(false);
    const writer = member([{ contentTypeApiId: '*', actions: ['read', 'write'] }]);
    // A writer holds delete with write, so it may trash, but not publish or purge.
    expect(entryBulkJobsFor(writer)).toEqual(['trash', 'restore']);
  });

  it('refuses any field rule, a type-specific grant, or a grant on one type alone', () => {
    const all = ['read', 'write', 'publish'] as const;
    expect(
      entryBulkJobsFor(
        member([{ contentTypeApiId: '*', actions: [...all], deniedFields: ['secret'] }]),
      ),
    ).toEqual([]);
    expect(
      entryBulkJobsFor(
        member([{ contentTypeApiId: '*', actions: [...all], readOnlyFields: ['slug'] }]),
      ),
    ).toEqual([]);
    expect(
      entryBulkJobsFor(
        member([
          { contentTypeApiId: '*', actions: [...all] },
          { contentTypeApiId: 'post', actions: ['read'] },
        ]),
      ),
    ).toEqual([]);
    expect(entryBulkJobsFor(member([{ contentTypeApiId: 'post', actions: [...all] }]))).toEqual([]);
    expect(entryBulkJobsFor(member([]))).toEqual([]);
  });
});
