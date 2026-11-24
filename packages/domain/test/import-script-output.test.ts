import { describe, expect, it } from 'vitest';
import {
  type ImportScriptOutput,
  importScriptAssetUrls,
  isImportScriptAssetRef,
  isImportScriptHtml,
  resolveImportScriptOutput,
} from '../src/index';

const output: ImportScriptOutput = {
  fields: {
    title: 'Kettle',
    summary: { $html: '<p>A <a href="/shop/toaster">toaster</a>.</p>' },
    gallery: [{ $asset: '/img/a.png' }, { $asset: '/img/missing.png' }],
    cover: { $asset: 'https://cdn.test/c.png' },
  },
  blocks: [
    {
      variant: 'text',
      fields: {
        body: { $html: '<p><img src="/img/a.png" alt="A"></p>' },
        nested: { deep: { $html: 'x' } },
      },
    },
  ],
  assets: [{ url: '/img/a.png', alt: 'A' }],
  links: [{ href: '/shop/toaster' }],
};

describe('import script output markers', () => {
  it('are recognised only as the one key they are', () => {
    expect(isImportScriptHtml({ $html: '<p>x</p>' })).toBe(true);
    expect(isImportScriptHtml({ $html: '<p>x</p>', other: 1 })).toBe(false);
    expect(isImportScriptHtml({ $html: 3 })).toBe(false);
    expect(isImportScriptAssetRef({ $asset: '/a.png' })).toBe(true);
    expect(isImportScriptAssetRef('/a.png')).toBe(false);
  });

  it('name every asset URL the output holds, once, as written', () => {
    expect(importScriptAssetUrls(output)).toEqual([
      '/img/a.png',
      '/img/missing.png',
      'https://cdn.test/c.png',
    ]);
  });

  it('resolve to documents and links with the resolvers, and drop an asset that has none', () => {
    const resolved = resolveImportScriptOutput(output, {
      resolveAsset: (src) => (src === '/img/a.png' ? { id: 'asset-a' } : undefined),
      resolveAssetRef: (url) => (url === '/img/missing.png' ? undefined : { id: `asset:${url}` }),
      resolveLink: (href) =>
        href === '/shop/toaster' ? { linkType: 'Entry', id: 'e1' } : undefined,
    });
    expect(resolved.fields.title).toBe('Kettle');
    expect(resolved.fields.gallery).toEqual([{ id: 'asset:/img/a.png', linkType: 'Asset' }]);
    expect(resolved.fields.cover).toEqual({
      id: 'asset:https://cdn.test/c.png',
      linkType: 'Asset',
    });
    const text = JSON.stringify(resolved);
    expect(text).not.toMatch(/\$html|\$asset|<p>/);
    expect(text).toContain('"nodeType":"entry-hyperlink"');
    expect(text).toContain('"nodeType":"embedded-asset-block"');
    expect(resolved.blocks[0]?.fields.nested).toMatchObject({ deep: { nodeType: 'document' } });
    // Assets and links lists are the script's, as they were.
    expect(resolved.assets).toEqual(output.assets);
  });

  it('resolve without resolvers to what a score or a preview reads', () => {
    const resolved = resolveImportScriptOutput(output);
    expect(resolved.fields.gallery).toEqual([]);
    expect(resolved.fields).not.toHaveProperty('cover');
    expect(resolved.fields.summary).toMatchObject({ nodeType: 'document' });
    expect(JSON.stringify(resolved.fields.summary)).toContain('"uri":"/shop/toaster"');
  });
});
