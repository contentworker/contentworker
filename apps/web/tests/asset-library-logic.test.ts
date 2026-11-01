import type { AssetFolder } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  assetLibraryQuery,
  bulkSummary,
  fileSize,
  folderLabel,
  folderRows,
  runBulk,
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
    expect(outcome).toEqual({ done: 2, failed: 1 });
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
