import { describe, expect, it } from 'vitest';
import {
  type FieldDefinition,
  type ImportScriptOutput,
  importScriptAssetUrls,
  importScriptValueIssues,
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

describe('import script values against the content type', () => {
  const f = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
    ({
      name: over.apiId,
      localized: false,
      required: false,
      position: 0,
      ...over,
    }) as FieldDefinition;
  const type = {
    fields: [
      f({ apiId: 'title', type: 'Symbol' }),
      f({ apiId: 'body', type: 'RichText' }),
      f({ apiId: 'cover', type: 'Link', linkType: 'Asset' }),
      f({ apiId: 'gallery', type: 'Array', items: { type: 'Link', linkType: 'Asset' } }),
      f({ apiId: 'meta', type: 'Object' }),
      f({
        apiId: 'sections',
        type: 'Array',
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'text',
              name: 'Text',
              fields: [
                f({ apiId: 'heading', type: 'Text' }),
                f({ apiId: 'body', type: 'RichText' }),
              ],
            },
          ],
        },
      }),
    ],
  };
  const out = (fields: Record<string, unknown>, blocks: ImportScriptOutput['blocks'] = []) => ({
    fields,
    blocks,
    assets: [],
    links: [],
  });

  it('take markers where they become what the field holds', () => {
    expect(
      importScriptValueIssues(
        out(
          {
            title: 'Fish & chips: a < b',
            body: { $html: '<p>x</p>' },
            cover: { $asset: '/c.png' },
            gallery: [{ $asset: '/a.png' }],
          },
          [{ variant: 'text', fields: { heading: 'Plain', body: { $html: '<p>y</p>' } } }],
        ),
        type,
      ),
    ).toEqual([]);
  });

  it('name each marker out of place, a marker with other keys, and text that is markup', () => {
    expect(
      importScriptValueIssues(
        out(
          {
            title: { $html: '<b>x</b>' },
            body: { $html: '<p>x</p>', extra: 1 },
            cover: { $html: '<img src="/c.png">' },
            gallery: [{ $html: '<p>no</p>' }],
            meta: { nested: { $asset: '/m.png' } },
            unknown: { $html: '<p>?</p>' },
          },
          [{ variant: 'text', fields: { heading: '<h2>Title</h2>', body: { $asset: '/x.png' } } }],
        ),
        type,
      ),
    ).toEqual([
      'fields.title: $html goes only in a RichText field',
      'fields.body: a $html or $asset marker is an object with that one key, as text',
      'fields.cover: $html goes only in a RichText field',
      'fields.gallery[0]: $html goes only in a RichText field',
      'fields.meta.nested: $asset goes only in an asset link field',
      'fields.unknown: $html goes only in a RichText field',
      'blocks[0].heading: holds markup; hand rich text back as { $html } in a RichText field',
      'blocks[0].body: $asset goes only in an asset link field',
    ]);
  });
});
