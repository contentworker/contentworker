/**
 * The guest page: the entry's title and its blocks fields (each block shown by its `label` or
 * `heading`), re-rendered on every change the admin sends. Built from text nodes only, never
 * markup from the entry, as a real frontend renders structured content.
 */
import { formatContentRef } from '@contentworker/sdk-core';
import {
  blockAttrs,
  type LiveFields,
  type LivePreviewUpdate,
  slotAttrs,
  startLivePreview,
} from '@contentworker/sdk-core/live-preview';

declare const __ADMIN_ORIGIN__: string;

const app = document.getElementById('app') as HTMLElement;
const params = new URL(location.href).searchParams;
const space = params.get('space') ?? '';
const environment = params.get('env') ?? 'main';

function el(tag: string, attrs: Record<string, string>, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(fields: LiveFields, update: LivePreviewUpdate) {
  const at = (name: string) =>
    fields[name]?.[update.locale] ?? Object.values(fields[name] ?? {})[0];
  const title = at('title');
  const ref = formatContentRef({
    space,
    environment,
    entryId: update.entryId,
    contentType: update.contentType,
    field: 'title',
    locale: update.locale,
  });
  // Every blocks field (a list of objects with a `_type`), each block shown by its label or heading.
  const slots: HTMLElement[] = [];
  for (const name of Object.keys(fields)) {
    const blocks = at(name);
    if (
      !Array.isArray(blocks) ||
      !blocks.every((b) => typeof b === 'object' && b && '_type' in b)
    ) {
      continue;
    }
    const slot = el('div', { ...slotAttrs(name) });
    for (const block of blocks as Record<string, unknown>[]) {
      if (typeof block._key !== 'string') continue;
      const section = el('section', { ...blockAttrs(block._key) });
      const text = block.label ?? block.heading ?? block._type;
      section.appendChild(el('p', {}, typeof text === 'string' ? text : ''));
      slot.appendChild(section);
    }
    slots.push(slot);
  }
  const more = el('p', {});
  more.appendChild(el('a', { href: '/elsewhere' }, 'Another page on the site'));
  app.replaceChildren(
    el('h1', { 'data-cw-ref': ref }, typeof title === 'string' ? title : 'Untitled'),
    ...slots,
    more,
  );
}

startLivePreview({ adminOrigin: __ADMIN_ORIGIN__, onChange: render });
