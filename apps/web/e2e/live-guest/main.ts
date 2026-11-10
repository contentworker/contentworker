/**
 * The guest page: a customer's frontend in miniature. It connects to the admin that frames it
 * (`connectPreview`), says which entry it renders (`page`, from its URL), and renders the entry's
 * title and its blocks fields (each block shown by its `label`, `heading` or `title`, its slots
 * nested inside it) from the unsaved state the admin sends, with Coworker's proposed blocks laid over
 * it as ghosts (`data-cw-proposed`, dashed). Every blocks field and slot is marked
 * `data-cw-slot`, so the page reports seams in its `layout`. Built from text nodes only, never markup from the entry, as a real
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

type Step = { key: string } | { field: string };
const isBlocks = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every((b) => typeof b === 'object' && b !== null && '_type' in b);

/** Coworker's ghost blocks in this render, by key: drawn dashed and marked, never saved. */
let ghosts = new Set<string>();

/** One slot: its blocks, each marked with its ref, and each block's own slots inside it. */
function slot(name: string, steps: Step[], blocks: Record<string, unknown>[], locale: string) {
  const box = el('div', { ...slotAttrs(ref(formatFieldPath({ field: name, steps }), locale)) });
  for (const block of blocks) {
    if (typeof block._key !== 'string') continue;
    const at: Step[] = [...steps, { key: block._key }];
    const section = el('section', {
      ...refAttrs(ref(formatFieldPath({ field: name, steps: at }), locale)),
      ...(ghosts.has(block._key) ? { 'data-cw-proposed': 'inserted' } : {}),
    });
    const text = block.label ?? block.heading ?? block.title ?? block._type;
    section.appendChild(el('p', {}, typeof text === 'string' ? text : ''));
    for (const [prop, value] of Object.entries(block)) {
      if (prop.startsWith('_') || !isBlocks(value)) continue;
      section.appendChild(slot(name, [...at, { field: prop }], value, locale));
    }
    box.appendChild(section);
  }
  return box;
}

function render(locale: string, fields: LiveFields) {
  const title = fields.title;
  const slots: HTMLElement[] = [];
  // Every blocks field: a list of objects with a `_type`, a slot even while it's empty.
  for (const [name, value] of Object.entries(fields)) {
    if (isBlocks(value)) slots.push(slot(name, [], value, locale));
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
  capabilities: ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout', 'proposals'],
  onState(_entryId, locale, _fields, view) {
    ghosts = new Set(view.ghosts.inserted);
    render(locale, view.withProposals);
  },
});
if (entryId && contentType) {
  preview.emit('page', {
    url: location.href,
    entries: [{ entryId, contentType, locale: pageLocale }],
  });
}
