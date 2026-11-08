/**
 * The guest page: a customer's frontend in miniature. It connects to the admin that frames it
 * (`connectPreview`), says which entry it renders (`page`, from its URL), and renders the entry's
 * title and its blocks fields (each block shown by its `label` or `heading`) from the unsaved
 * state the admin sends. Built from text nodes only, never markup from the entry, as a real
 * frontend renders structured content.
 *
 * Its URL names the entry: `?entry=<id>&type=<apiId>&space=<id>&env=<id>&locale=<code>`.
 */
import { formatContentRef, formatFieldPath } from '@contentworker/sdk-core';
import {
  connectPreview,
  type LiveFields,
  refAttrs,
  slotAttrs,
} from '@contentworker/sdk-core/live-preview';

declare const __ADMIN_ORIGIN__: string;

const app = document.getElementById('app') as HTMLElement;
const params = new URL(location.href).searchParams;
const space = params.get('space') ?? '';
const environment = params.get('env') ?? 'main';
const entryId = params.get('entry') ?? '';
const contentType = params.get('type') ?? '';
const pageLocale = params.get('locale') ?? 'en-US';

function el(tag: string, attrs: Record<string, string>, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

const ref = (field: string, locale: string) => ({
  space,
  environment,
  entryId,
  contentType,
  field,
  locale,
});

function render(locale: string, fields: LiveFields) {
  const title = fields.title;
  const slots: HTMLElement[] = [];
  // Every blocks field: a list of objects with a `_type`.
  for (const [name, value] of Object.entries(fields)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    if (!value.every((b) => typeof b === 'object' && b !== null && '_type' in b)) continue;
    const slot = el('div', { ...slotAttrs(ref(name, locale)) });
    for (const block of value as Record<string, unknown>[]) {
      if (typeof block._key !== 'string') continue;
      const path = formatFieldPath({ field: name, steps: [{ key: block._key }] });
      const section = el('section', { ...refAttrs(ref(path, locale)) });
      const text = block.label ?? block.heading ?? block._type;
      section.appendChild(el('p', {}, typeof text === 'string' ? text : ''));
      slot.appendChild(section);
    }
    slots.push(slot);
  }
  const more = el('p', {});
  more.appendChild(el('a', { href: '/elsewhere' }, 'Another page on the site'));
  app.replaceChildren(
    el(
      'h1',
      { 'data-cw-ref': formatContentRef(ref('title', locale)) },
      typeof title === 'string' ? title : 'Untitled',
    ),
    ...slots,
    more,
  );
}

const preview = connectPreview({
  adminOrigin: __ADMIN_ORIGIN__,
  capabilities: ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout'],
  onState(_entryId, locale, _fields, view) {
    render(locale, view.withProposals);
  },
});
if (entryId && contentType) {
  preview.emit('page', {
    url: location.href,
    entries: [{ entryId, contentType, locale: pageLocale }],
  });
}
