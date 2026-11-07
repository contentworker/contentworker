/**
 * The guest page: the entry's title and its `body` blocks (each shown by its `label` or
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
  const slot = el('div', { ...slotAttrs('body') });
  const blocks = at('body');
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const b = block as Record<string, unknown>;
    if (typeof b._key !== 'string') continue;
    const section = el('section', { ...blockAttrs(b._key) });
    section.appendChild(el('p', {}, String(b.label ?? b.heading ?? b._type ?? '')));
    slot.appendChild(section);
  }
  const more = el('p', {});
  more.appendChild(el('a', { href: '/elsewhere' }, 'Another page on the site'));
  app.replaceChildren(
    el('h1', { 'data-cw-ref': ref }, typeof title === 'string' ? title : 'Untitled'),
    slot,
    more,
  );
}

startLivePreview({ adminOrigin: __ADMIN_ORIGIN__, onChange: render });
