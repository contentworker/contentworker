/**
 * Tiptap extensions for the rich-text editor: the MIT StarterKit plus custom
 * atom nodes for embedded entries/assets and the lossless unknown-node
 * carriers used by the mapper (see `@/lib/rich-text-mapper.ts`).
 */

import { Mark, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { EmbedNodeView, InlineEmbedNodeView, UnknownNodeView } from './EmbedNodeView';

const embedNode = (name: string) =>
  Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
      return { targetId: { default: '' } };
    },
    parseHTML() {
      return [{ tag: `div[data-node="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', { ...HTMLAttributes, 'data-node': name }];
    },
    addNodeView() {
      return ReactNodeViewRenderer(EmbedNodeView);
    },
  });

export const EmbeddedEntryBlock = embedNode('embeddedEntryBlock');
export const EmbeddedAssetBlock = embedNode('embeddedAssetBlock');

const unknownNode = (name: string, opts: { inline: boolean }) =>
  Node.create({
    name,
    group: opts.inline ? 'inline' : 'block',
    inline: opts.inline,
    atom: true,
    addAttributes() {
      return { raw: { default: null } };
    },
    parseHTML() {
      return [{ tag: `${opts.inline ? 'span' : 'div'}[data-node="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return [opts.inline ? 'span' : 'div', { ...HTMLAttributes, 'data-node': name }];
    },
    addNodeView() {
      return ReactNodeViewRenderer(UnknownNodeView);
    },
  });

/** Inline atom for `embedded-entry-inline` (an entry referenced mid-sentence). */
export const EmbeddedEntryInline = Node.create({
  name: 'embeddedEntryInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { targetId: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-node="embeddedEntryInline"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-node': 'embeddedEntryInline' }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(InlineEmbedNodeView);
  },
});

/**
 * Marks for `entry-hyperlink`/`asset-hyperlink`. Link kinds are mutually
 * exclusive on a text node (the mapper also resolves any stacked survivors).
 */
const refLinkMark = (name: string) =>
  Mark.create({
    name,
    excludes: 'link entryLink assetLink',
    addAttributes() {
      return { targetId: { default: '' } };
    },
    parseHTML() {
      return [{ tag: `span[data-mark="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['span', { ...HTMLAttributes, 'data-mark': name }, 0];
    },
  });

export const EntryLink = refLinkMark('entryLink');
export const AssetLink = refLinkMark('assetLink');

/** Lossless carrier for stored block nodes the editor doesn't model. */
export const UnknownBlock = unknownNode('unknownBlock', { inline: false });
/** Lossless carrier for stored inline nodes (entry/asset hyperlinks, inline embeds). */
export const UnknownInline = unknownNode('unknownInline', { inline: true });

/** The full extension set; also used headlessly (getSchema) by the mapper tests. */
export function buildExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false },
    }),
    EmbeddedEntryBlock,
    EmbeddedAssetBlock,
    EmbeddedEntryInline,
    EntryLink,
    AssetLink,
    UnknownBlock,
    UnknownInline,
  ];
}
