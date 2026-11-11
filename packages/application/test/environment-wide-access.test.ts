import {
  type ContentTypeGrant,
  ForbiddenError,
  type Principal,
  SCOPES,
} from '@contentworker/domain';
import type { ConvertedSpace, SpaceExportReader } from '@contentworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  analyzeSpaceExport,
  cloneEnvironment,
  createContentType,
  createEntry,
  createEnvironment,
  type EnvironmentSnapshot,
  exportSnapshot,
  importSnapshot,
  mergeEnvironments,
  publishContentType,
  SYSTEM_CALLER,
  startEnvironmentClone,
  startSnapshotImport,
  startSpaceExportImport,
} from '../src/index';

/**
 * The environment-wide operations (snapshot export and import, clone, a merge of entries, a space
 * export import) hold their caller to every content type alike inside the use-case, so no surface
 * can reach one without naming who it acts for, and none can forget the check.
 */

const source = { spaceId: 's1', environmentId: 'main' };
const target = { spaceId: 's1', environmentId: 'copy' };
const elsewhere = { spaceId: 's2', environmentId: 'main' };

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const role = (contentGrants: readonly ContentTypeGrant[], spaceId = 's1'): Principal => ({
  spaceId,
  kind: 'cma',
  scopes: [SCOPES.contentManage, SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead],
  contentGrants,
});
/** Every action on one type only. */
const narrow = role([{ contentTypeApiId: 'article', actions: ['read', 'write', 'publish'] }]);
/** Every type, but a field it may only read. */
const fieldRule = role([
  { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], readOnlyFields: ['body'] },
]);
/** One full `*` grant: every type alike, locking too, no field rules (the Manager preset's). */
const wide = role([{ contentTypeApiId: '*', actions: ['read', 'write', 'publish', 'lock'] }]);
/** Every type alike, without publish. */
const drafter = role([{ contentTypeApiId: '*', actions: ['read', 'write'] }]);

let ctx: AppContext;
let store: InMemoryContentStore;
let blob: FakeBlobStore;

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  store.seedSpace({ spaceId: 's2', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('w') };
  blob = new FakeBlobStore();
  await createEnvironment(ctx, 's1', 'copy');
  for (const apiId of ['article', 'page']) {
    await createContentType(ctx, SYSTEM_CALLER, source, {
      apiId,
      name: apiId,
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, source, apiId);
    await createEntry(ctx, source, {
      id: `${apiId}-1`,
      contentTypeApiId: apiId,
      fields: { title: { 'en-US': apiId } },
    });
  }
});

const refusal = (actions: string) =>
  new ForbiddenError(`content:${actions}:* (on every content type, every field)`).message;

/** Nothing landed in `scope`: no content type, no entry, no job. */
async function untouched(scope = target) {
  expect(await store.contentTypes.list(scope)).toEqual([]);
  expect(await store.entries.list(scope, {})).toEqual([]);
  expect(await store.bulkJobs.listJobs(scope, { limit: 10 })).toEqual([]);
}

const snapshot = () => exportSnapshot(ctx, SYSTEM_CALLER, source);

describe('exportSnapshot', () => {
  it.each([
    ['limited to some types', narrow],
    ['with a field rule', fieldRule],
  ])('refuses a role %s', async (_, caller) => {
    await expect(exportSnapshot(ctx, caller, source)).rejects.toThrow(refusal('read'));
  });

  it('exports for an admin, a role holding every type, and the system', async () => {
    for (const caller of [admin, wide, SYSTEM_CALLER]) {
      expect((await exportSnapshot(ctx, caller, source)).entries).toHaveLength(2);
    }
  });

  it('fails closed on a caller that is neither a principal nor the system', async () => {
    await expect(exportSnapshot(ctx, undefined as never, source)).rejects.toThrow(ForbiddenError);
    await expect(exportSnapshot(ctx, 'system' as never, source)).rejects.toThrow(ForbiddenError);
  });
});

describe('importSnapshot and startSnapshotImport', () => {
  it.each([
    ['limited to some types', narrow],
    ['with a field rule', fieldRule],
  ])('refuse a role %s, a dry run too, writing nothing', async (_, caller) => {
    const snap: EnvironmentSnapshot = await snapshot();
    await expect(importSnapshot(ctx, caller, target, snap)).rejects.toThrow(
      refusal('write+publish'),
    );
    await expect(importSnapshot(ctx, caller, target, snap, { dryRun: true })).rejects.toThrow(
      refusal('write+publish'),
    );
    await expect(startSnapshotImport(ctx, caller, blob, target, snap)).rejects.toThrow(
      refusal('write+publish'),
    );
    await untouched();
  });

  it('asks for publish only when the import publishes', async () => {
    const snap = await snapshot();
    await expect(importSnapshot(ctx, drafter, target, snap, { dryRun: true })).rejects.toThrow(
      refusal('write+publish'),
    );
    const drafts = await importSnapshot(ctx, drafter, target, snap, {
      dryRun: true,
      publish: false,
    });
    expect(drafts.entries).toBe(2);
  });

  it('imports for an admin, a role holding every type, and the system', async () => {
    const snap = await snapshot();
    for (const caller of [admin, wide, SYSTEM_CALLER]) {
      expect((await importSnapshot(ctx, caller, target, snap, { dryRun: true })).entries).toBe(2);
    }
    const started = await startSnapshotImport(ctx, wide, blob, target, snap);
    expect(started.job).not.toBeNull();
  });
});

describe('cloneEnvironment and startEnvironmentClone', () => {
  it.each([
    ['limited to some types', narrow],
    ['with a field rule', fieldRule],
  ])('refuse a role %s, writing nothing', async (_, caller) => {
    await expect(cloneEnvironment(ctx, caller, source, target)).rejects.toThrow(
      refusal('read+write+publish'),
    );
    await expect(startEnvironmentClone(ctx, caller, source, target)).rejects.toThrow(
      refusal('read+write+publish'),
    );
    await untouched();
  });

  it("refuses a target space the caller can't manage before anything else", async () => {
    // A role from s1 holding every type there: its grants say nothing about s2.
    const expected = new ForbiddenError(SCOPES.contentManage).message;
    await expect(cloneEnvironment(ctx, wide, source, elsewhere)).rejects.toThrow(expected);
    await expect(startEnvironmentClone(ctx, wide, source, elsewhere)).rejects.toThrow(expected);
    await untouched(elsewhere);
  });

  it('clones for an admin (across spaces too), a role holding every type, and the system', async () => {
    expect((await cloneEnvironment(ctx, admin, source, elsewhere)).entries).toBe(2);
    expect((await cloneEnvironment(ctx, wide, source, target, { dryRun: true })).entries).toBe(2);
    expect((await cloneEnvironment(ctx, SYSTEM_CALLER, source, target)).entries).toBe(2);
    await createEnvironment(ctx, 's1', 'jobs');
    const started = await startEnvironmentClone(ctx, wide, source, {
      spaceId: 's1',
      environmentId: 'jobs',
    });
    expect(started.job.status).toBe('running');
  });
});

describe('mergeEnvironments', () => {
  it.each([
    ['limited to some types', narrow],
    ['with a field rule', fieldRule],
  ])('refuses a role %s merging entries, writing nothing', async (_, caller) => {
    await expect(
      mergeEnvironments(ctx, caller, 's1', 'main', 'copy', {
        contentTypes: ['article'],
        entries: ['article-1'],
      }),
    ).rejects.toThrow(refusal('read+write+lock'));
    await untouched();
  });

  it("takes lock to merge entries, which go over the target's locked regions", async () => {
    await expect(
      mergeEnvironments(ctx, drafter, 's1', 'main', 'copy', {
        contentTypes: ['article'],
        entries: ['article-1'],
      }),
    ).rejects.toThrow(refusal('read+write+lock'));
    await untouched();
    // Content types alone copy no entry: no lock needed.
    const merged = await mergeEnvironments(ctx, drafter, 's1', 'main', 'copy', {
      contentTypes: ['article'],
    });
    expect(merged.mergedContentTypes).toEqual(['article']);
  });

  it('leaves such a role the content model, as saving a type does', async () => {
    const merged = await mergeEnvironments(ctx, narrow, 's1', 'main', 'copy', {
      contentTypes: ['page'],
    });
    expect(merged.mergedContentTypes).toEqual(['page']);
  });

  it('merges entries for an admin, a role holding every type, and the system', async () => {
    for (const [caller, entry] of [
      [admin, 'article-1'],
      [wide, 'page-1'],
      [SYSTEM_CALLER, 'article-1'],
    ] as const) {
      const merged = await mergeEnvironments(ctx, caller, 's1', 'main', 'copy', {
        contentTypes: ['article', 'page'],
        entries: [entry],
      });
      expect(merged.mergedEntries).toEqual([entry]);
    }
  });

  it('fails closed on a malformed caller even with no entries', async () => {
    await expect(
      mergeEnvironments(ctx, null as never, 's1', 'main', 'copy', { contentTypes: ['page'] }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('analyzeSpaceExport and startSpaceExportImport', () => {
  /** A reader that counts its reads and converts to an export holding nothing. */
  function reader(): SpaceExportReader & { reads: number } {
    const r = {
      id: 'space-export',
      name: 'Space export',
      reads: 0,
      async read(): Promise<ConvertedSpace> {
        r.reads++;
        return {
          defaultLocale: 'en-US',
          locales: [{ code: 'en-US', name: 'English', fallback: null, default: true }],
          contentTypes: [],
          tags: [],
          entries: [],
          assets: [],
          findings: {
            unmappedFields: [],
            unmappedValidations: [],
            warnings: [],
            missingLinks: [],
            invalidEntries: [],
          },
          entriesRead: 0,
          assetsRead: 0,
        };
      },
    };
    return r;
  }

  it.each([
    ['limited to some types', narrow],
    ['with a field rule', fieldRule],
  ])('refuse a role %s before reading the export', async (_, caller) => {
    const r = reader();
    await expect(analyzeSpaceExport(ctx, caller, target, r, { payload: '{}' })).rejects.toThrow(
      refusal('write+publish'),
    );
    await expect(
      startSpaceExportImport(ctx, caller, blob, target, r, { payload: '{}' }),
    ).rejects.toThrow(refusal('write+publish'));
    expect(r.reads).toBe(0);
    await untouched();
  });

  it('asks for space:admin to add locales, before every type', async () => {
    const r = reader();
    const expected = new ForbiddenError(SCOPES.spaceAdmin).message;
    const input = { payload: '{}', addLocales: true };
    await expect(analyzeSpaceExport(ctx, wide, target, r, input)).rejects.toThrow(expected);
    await expect(startSpaceExportImport(ctx, narrow, blob, target, r, input)).rejects.toThrow(
      expected,
    );
    expect(r.reads).toBe(0);
  });

  it('asks for publish only when the import publishes', async () => {
    const r = reader();
    await expect(analyzeSpaceExport(ctx, drafter, target, r, { payload: '{}' })).rejects.toThrow(
      refusal('write+publish'),
    );
    await analyzeSpaceExport(ctx, drafter, target, r, { payload: '{}', publish: false });
    expect(r.reads).toBe(1);
  });

  it('analyzes and imports for an admin, a role holding every type, and the system', async () => {
    for (const caller of [admin, wide, SYSTEM_CALLER]) {
      const r = reader();
      const report = await analyzeSpaceExport(ctx, caller, target, r, {
        payload: '{}',
        addLocales: caller !== wide,
      });
      expect(report.executable).toBe(true);
    }
    const started = await startSpaceExportImport(ctx, wide, blob, target, reader(), {
      payload: '{}',
    });
    expect(started.report.dryRun).toBe(false);
  });
});
