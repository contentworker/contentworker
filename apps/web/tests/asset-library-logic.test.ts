import type { AssetFolder } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  ASSET_BULK_JOB_THRESHOLD,
  activeFilterCount,
  assetLibraryQuery,
  assetSearchQuery,
  bulkSummary,
  facetChips,
  fileSize,
  folderLabel,
  folderRows,
  ingestState,
  isoToLocalInput,
  jobFailures,
  localInputToIso,
  RIGHTS_EXPIRE_SOON_MS,
  rightsState,
  runBulk,
  runsAsJob,
  timeUntil,
  versionAuthor,
} from '~/cms/lib/assets';

const folder = (id: string, name: string, path: string, parentId?: string): AssetFolder => ({
  id,
  name,
  path,
  ...(parentId ? { parentId } : {}),
  createdAt: '',
  updatedAt: '',
});

describe('the asset library query', () => {
  it('names the folder and the filters, and nothing it was not asked for', () => {
    expect(assetLibraryQuery({ kind: 'all' }, {})).toEqual({ limit: 50 });
    expect(assetLibraryQuery({ kind: 'root' }, { kind: 'image' })).toEqual({
      limit: 50,
      folder: 'root',
      kind: 'image',
    });
    expect(
      assetLibraryQuery(
        { kind: 'folder', id: 'f1' },
        { status: 'archived', tag: 't1', sort: 'size-asc' },
      ),
    ).toEqual({
      limit: 50,
      folder: 'f1',
      status: 'archived',
      tag: 't1',
      sort: 'size',
      order: 'asc',
    });
  });

  it('counts the filters but not the sort', () => {
    expect(activeFilterCount({ sort: 'size-desc' })).toBe(0);
    expect(activeFilterCount({ kind: 'video', tag: 't' })).toBe(2);
  });
});

describe('the folder tree', () => {
  const folders = [
    folder('b', 'Brand', '/b/'),
    folder('l', 'Logos', '/b/l/', 'b'),
    folder('a', 'Archive 2024', '/a/'),
    folder('i', 'Icons', '/b/i/', 'b'),
  ];

  it('nests children under their parent, siblings by name', () => {
    expect(folderRows(folders).map((r) => `${r.depth}:${r.folder.name}`)).toEqual([
      '0:Archive 2024',
      '0:Brand',
      '1:Icons',
      '1:Logos',
    ]);
  });

  it('labels a folder with its ancestors', () => {
    expect(folderLabel(folders[1] as AssetFolder, folders)).toBe('Brand / Logos');
  });
});

describe('bulk actions', () => {
  it('runs every one, counting failures without stopping', async () => {
    const outcome = await runBulk(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('nope');
    });
    expect(outcome).toEqual({ done: 2, failed: 1, failures: [{ id: 'b', error: 'nope' }] });
    expect(bulkSummary('Published', outcome)).toBe('Published 2 of 3 assets; 1 failed');
    expect(bulkSummary('Archived', { done: 1, failed: 0 })).toBe('Archived 1 asset');
  });
});

describe('file sizes', () => {
  it('reads like a person would say them', () => {
    expect(fileSize(undefined)).toBe('—');
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(1536)).toBe('1.5 KB');
    expect(fileSize(25 * 1024 * 1024)).toBe('25 MB');
  });
});

describe('asset search', () => {
  it('searches what the folder and filter bar say, relevance first (no sort)', () => {
    expect(
      assetSearchQuery(
        'mug',
        { kind: 'folder', id: 'f1' },
        {
          kind: 'image',
          status: 'all',
          tag: 't1',
          sort: 'size-desc',
        },
      ),
    ).toEqual({ q: 'mug', limit: 100, folder: 'f1', kind: 'image', status: 'all', tag: 't1' });
    expect(assetSearchQuery('mug', { kind: 'root' }, {})).toEqual({
      q: 'mug',
      limit: 100,
      folder: 'root',
    });
  });

  it('names facet chips, most matches first, leaving out tags and folders it can’t name', () => {
    const chips = facetChips(
      { kind: { image: 1, document: 3 }, tag: { t1: 2, gone: 5 }, folder: { root: 1, f1: 4 } },
      [{ id: 't1', name: 'Hero' }],
      [folder('f1', 'Brand', '/f1/')],
    );
    expect(chips.kind.map((c) => [c.label, c.count])).toEqual([
      ['Documents', 3],
      ['Images', 1],
    ]);
    expect(chips.tag.map((c) => c.label)).toEqual(['Hero']);
    expect(chips.folder.map((c) => [c.value, c.label])).toEqual([
      ['f1', 'Brand'],
      ['root', 'Not in a folder'],
    ]);
  });

  it('says processing for pending and running ingest, failed with why, and nothing when done', () => {
    expect(ingestState({ ingestStatus: 'pending' })).toEqual({ state: 'processing' });
    expect(ingestState({ ingestStatus: 'processing' })).toEqual({ state: 'processing' });
    expect(ingestState({ ingestStatus: 'error', ingestError: 'boom' })).toEqual({
      state: 'failed',
      error: 'boom',
    });
    expect(ingestState({ ingestStatus: 'ready' })).toBeNull();
    expect(ingestState({})).toBeNull();
  });
});

describe('usage rights at a glance', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const at = (ms: number) => new Date(ms).toISOString();

  it('says expired, expiring within a week, embargoed, or nothing', () => {
    expect(rightsState(undefined, now)).toBeNull();
    expect(rightsState({ license: 'CC BY' }, now)).toBeNull();
    expect(rightsState({ expiresAt: at(now - 1) }, now)).toEqual({
      state: 'expired',
      at: at(now - 1),
    });
    expect(rightsState({ expiresAt: at(now + 3 * day) }, now)?.state).toBe('expiring');
    expect(rightsState({ expiresAt: at(now + RIGHTS_EXPIRE_SOON_MS) }, now)?.state).toBe(
      'expiring',
    );
    expect(rightsState({ expiresAt: at(now + RIGHTS_EXPIRE_SOON_MS + 1) }, now)).toBeNull();
    expect(rightsState({ embargoUntil: at(now + day) }, now)?.state).toBe('embargoed');
    expect(rightsState({ embargoUntil: at(now - day) }, now)).toBeNull();
    // Expired wins: an expired asset can't be delivered whatever its embargo says.
    expect(rightsState({ embargoUntil: at(now + day), expiresAt: at(now - day) }, now)?.state).toBe(
      'expired',
    );
  });

  it('says how long is left in words', () => {
    expect(timeUntil(now + 3 * day, now)).toBe('in 3 days');
    expect(timeUntil(now + 5 * 60 * 60 * 1000, now)).toBe('in 5 hours');
    expect(timeUntil(now + 60 * 60 * 1000, now)).toBe('in 1 hour');
    expect(timeUntil(now + 20 * 60 * 1000, now)).toBe('in 20 minutes');
    expect(timeUntil(now + 1000, now)).toBe('in 1 minute');
  });

  it('turns a date and time on the reader’s clock into an instant with a zone, and back', () => {
    expect(localInputToIso('')).toBeNull();
    const iso = localInputToIso('2026-01-31T09:30');
    expect(iso).toMatch(/^2026-01-3\dT\d{2}:30:00\.000Z$/);
    expect(isoToLocalInput(iso ?? undefined)).toBe('2026-01-31T09:30');
    expect(isoToLocalInput(undefined)).toBe('');
    expect(isoToLocalInput('not a date')).toBe('');
  });
});

describe('asset bulk jobs', () => {
  it('runs a selection bigger than one page as a job', () => {
    expect(runsAsJob(ASSET_BULK_JOB_THRESHOLD)).toBe(false);
    expect(runsAsJob(ASSET_BULK_JOB_THRESHOLD + 1)).toBe(true);
  });

  it('names a job’s failures by the asset name the report gives, else the id', () => {
    expect(
      jobFailures({
        job: {} as never,
        chunks: [
          {
            chunkId: 'c1',
            status: 'completed',
            attempts: 1,
            itemCount: 2,
            failures: [{ id: 'a1', error: 'embargoed', name: 'hero.jpg' }],
          },
          {
            chunkId: 'c2',
            status: 'completed',
            attempts: 2,
            itemCount: 1,
            failures: [{ id: 'a9', error: 'gone' }],
          },
        ],
      }),
    ).toEqual([
      { id: 'a1', name: 'hero.jpg', error: 'embargoed' },
      { id: 'a9', name: 'a9', error: 'gone' },
    ]);
  });

  it('names a failure the report left unnamed from the library before falling back to the id', () => {
    const report = {
      job: {} as never,
      chunks: [
        {
          chunkId: 'c1',
          status: 'failed' as const,
          attempts: 3,
          itemCount: 2,
          failures: [
            { id: 'a1', error: 'batch failed' },
            { id: 'a2', error: 'batch failed' },
          ],
        },
      ],
    };
    expect(jobFailures(report, new Map([['a1', 'Hero']])).map((f) => f.name)).toEqual([
      'Hero',
      'a2',
    ]);
  });

  it('says who uploaded a version by name, or by kind, never by a raw id', () => {
    const people = [{ id: 'u1', email: 'ada@example.com', name: 'Ada' }];
    expect(versionAuthor('u1', people)).toBe('Ada');
    expect(versionAuthor('u1', [{ id: 'u1', email: 'ada@example.com' }])).toBe('ada@example.com');
    expect(versionAuthor('cma')).toBe('an API key');
    expect(versionAuthor('admin-token')).toBe('the admin token');
    expect(versionAuthor('0193f1e2-7c4a-7000-8000-000000000000')).toBe('a teammate');
  });
});
