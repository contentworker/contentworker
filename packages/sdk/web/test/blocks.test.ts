// @vitest-environment jsdom
import type { ContentRef } from '@contentworker/sdk-core';
import { parseContentRef } from '@contentworker/sdk-core';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BlockComponentProps, type BlockComponents, Blocks } from '../src/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What codegen's `BlockTypes` emits for the catalog below.
type CardBlock = { _type: 'card'; _key: string; title?: string };
type GridBlock = { _type: 'grid'; _key: string; title?: string; cards?: CardBlock[] };
type BannerBlock = { _type: 'banner'; _key: string; heading: string };
type BlockTypes = { banner: BannerBlock; grid: GridBlock; card: CardBlock };

const catalog = {
  blocks: [
    { id: 'banner', aliases: ['hero'] },
    { id: 'grid', slots: [{ apiId: 'cards' }] },
    { id: 'card' },
  ],
};

const body = [
  { _type: 'hero', _key: 'k1', heading: 'Hello' },
  {
    _type: 'grid',
    _key: 'k2',
    title: 'Cards',
    cards: [
      { _type: 'card', _key: 'k3', title: 'One' },
      { _type: 'card', _key: 'k4', title: 'Two' },
    ],
  },
];

const ref: ContentRef = {
  space: 's1',
  environment: 'main',
  entryId: 'e1',
  contentType: 'page',
  field: 'body',
  locale: 'en-US',
};

const components: BlockComponents<BlockTypes> = {
  banner: ({ block, attrs, fieldAttrs }) =>
    createElement(
      'section',
      { ...attrs, className: 'banner' },
      createElement('h1', fieldAttrs('heading'), block.heading),
    ),
  grid: ({ block, attrs, slots }) =>
    createElement(
      'section',
      attrs,
      createElement('h2', null, block.title),
      slots.cards({ as: 'ul', className: 'cards' }),
    ),
  card: ({ block, attrs, ghost }) =>
    createElement('li', { ...attrs, 'data-ghost': ghost }, block.title),
};

function Counter({ block }: BlockComponentProps<CardBlock>) {
  const [n, setN] = useState(0);
  return createElement(
    'button',
    { type: 'button', onClick: () => setN(n + 1) },
    `${block.title}:${n}`,
  );
}

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(el);
  return host;
};

describe('<Blocks>', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders each block with its component and slots with the same components', () => {
    const host = html(
      createElement(Blocks<BlockTypes>, {
        value: body,
        components,
        catalog,
        as: 'main',
        className: 'page',
      }),
    );
    expect(host.innerHTML).toBe(
      '<main class="page">' +
        '<section class="banner"><h1>Hello</h1></section>' +
        '<section><h2>Cards</h2><ul class="cards"><li>One</li><li>Two</li></ul></section>' +
        '</main>',
    );
  });

  it('carries no preview marks at all in a normal render', () => {
    const host = html(
      createElement(Blocks<BlockTypes>, {
        value: body,
        components,
        catalog,
        ghosts: { inserted: ['k3'] },
      }),
    );
    expect(host.querySelector('[data-cw-ref], [data-cw-slot], [data-cw-ghost]')).toBeNull();
    // The ghost state still reaches the component, which decides how to draw it.
    expect(host.querySelector('li')?.getAttribute('data-ghost')).toBe('inserted');
  });

  it('marks blocks, slots and fields with their key paths in a preview render', () => {
    const host = html(
      createElement(Blocks<BlockTypes>, {
        value: body,
        components,
        catalog,
        preview: ref,
        ghosts: { inserted: ['k3'] },
      }),
    );
    const field = (el: Element | null | undefined, attr: string) =>
      parseContentRef(el?.getAttribute(attr))?.field;
    expect(field(host.firstElementChild, 'data-cw-slot')).toBe('body');
    expect(field(host.querySelector('.banner'), 'data-cw-ref')).toBe('body[k1]');
    expect(field(host.querySelector('h1'), 'data-cw-ref')).toBe('body[k1].heading');
    expect(field(host.querySelector('ul'), 'data-cw-slot')).toBe('body[k2].cards');
    const cards = [...host.querySelectorAll('li')];
    expect(cards.map((li) => field(li, 'data-cw-ref'))).toEqual([
      'body[k2].cards[k3]',
      'body[k2].cards[k4]',
    ]);
    expect(cards.map((li) => li.getAttribute('data-cw-ghost'))).toEqual(['inserted', null]);
  });

  it('renders an empty slot as its marked element, so the canvas can offer a seam in it', () => {
    const host = html(
      createElement(Blocks<BlockTypes>, {
        value: [{ _type: 'grid', _key: 'g' }],
        components,
        preview: ref,
      }),
    );
    const ul = host.querySelector('ul');
    expect(ul?.children).toHaveLength(0);
    expect(parseContentRef(ul?.getAttribute('data-cw-slot'))?.field).toBe('body[g].cards');
  });

  it('renders an unknown block with the fallback, or not at all', () => {
    const fallback = ({ block, attrs }: BlockComponentProps) =>
      createElement('div', { ...attrs, className: 'unknown' }, block._type);
    const value = [{ _type: 'quote', _key: 'q' }, ...body];
    const withFallback = html(
      createElement(Blocks<BlockTypes>, { value, components, catalog, fallback }),
    );
    expect(withFallback.querySelector('.unknown')?.textContent).toBe('quote');
    const without = html(createElement(Blocks<BlockTypes>, { value, components, catalog }));
    expect(without.querySelector('.unknown')).toBeNull();
    expect(without.querySelectorAll('section')).toHaveLength(2);
  });

  it('renders a former id as its block only when given the catalog', () => {
    const without = html(createElement(Blocks<BlockTypes>, { value: body, components }));
    expect(without.querySelector('.banner')).toBeNull();
  });

  it('renders an empty element for a value that is not a list of blocks', () => {
    expect(html(createElement(Blocks, { value: 'nope', components: {} })).innerHTML).toBe(
      '<div></div>',
    );
  });

  it('keys blocks by _key, so a reorder keeps each block its own state', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const cards = [
      { _type: 'card', _key: 'a', title: 'A' },
      { _type: 'card', _key: 'b', title: 'B' },
      { _type: 'card', _key: 'b', title: 'B again' },
    ];
    await act(async () =>
      root.render(createElement(Blocks, { value: cards, components: { card: Counter } })),
    );
    await act(async () => host.querySelector('button')?.click());
    await act(async () =>
      root.render(
        createElement(Blocks, {
          value: [cards[1], cards[0], cards[2]],
          components: { card: Counter },
        }),
      ),
    );
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'B:0',
      'A:1',
      'B again:0',
    ]);
    // A key two blocks hold gets a positional key instead of a duplicate-key warning.
    expect(errors).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
