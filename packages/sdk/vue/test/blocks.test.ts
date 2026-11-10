// @vitest-environment jsdom
import type { ContentRef } from '@contentworker/sdk-core';
import { parseContentRef } from '@contentworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, type PropType, ref, renderSlot } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { CwBlocks, useBlock } from '../src/index.js';

type CardBlock = { _type: 'card'; _key: string; title?: string };
type GridBlock = { _type: 'grid'; _key: string; title?: string; cards?: CardBlock[] };
type BannerBlock = { _type: 'banner'; _key: string; heading: string };

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

const ref1: ContentRef = {
  space: 's1',
  environment: 'main',
  entryId: 'e1',
  contentType: 'page',
  field: 'body',
  locale: 'en-US',
};

const Banner = defineComponent({
  props: { block: { type: Object as PropType<BannerBlock>, required: true } },
  setup(props) {
    const { fieldAttrs } = useBlock<BannerBlock>();
    return () =>
      h('section', { class: 'banner' }, [h('h1', fieldAttrs('heading'), props.block.heading)]);
  },
});

// The slot is a Vue slot: what a template writes as `<slot name="cards" as="ul" class="cards" />`.
const Grid = defineComponent({
  props: { block: { type: Object as PropType<GridBlock>, required: true } },
  setup(props, { slots }) {
    return () =>
      h('section', [
        h('h2', props.block.title),
        renderSlot(slots, 'cards', { as: 'ul', class: 'cards' }),
      ]);
  },
});

const Card = defineComponent({
  props: { block: { type: Object as PropType<CardBlock>, required: true } },
  setup(props) {
    const context = useBlock<CardBlock>();
    return () => h('li', { 'data-ghost': context.ghost }, props.block.title);
  },
});

const components = { banner: Banner, grid: Grid, card: Card };

const html = async (props: Record<string, unknown>) => {
  const host = document.createElement('div');
  host.innerHTML = await renderToString(createApp({ render: () => h(CwBlocks, props as never) }));
  return host;
};

describe('<CwBlocks>', () => {
  it('renders each block with its component and slots with the same components', async () => {
    const host = await html({ value: body, components, catalog, as: 'main', class: 'page' });
    expect(host.innerHTML.replace(/<!--\[-->|<!--]-->/g, '')).toBe(
      '<main class="page">' +
        '<section class="banner"><h1>Hello</h1></section>' +
        '<section><h2>Cards</h2><ul class="cards"><li>One</li><li>Two</li></ul></section>' +
        '</main>',
    );
  });

  it('carries no preview marks at all in a normal render', async () => {
    const host = await html({ value: body, components, catalog, ghosts: { inserted: ['k3'] } });
    expect(host.querySelector('[data-cw-ref], [data-cw-slot], [data-cw-ghost]')).toBeNull();
    expect(host.querySelector('li')?.getAttribute('data-ghost')).toBe('inserted');
  });

  it('marks blocks (on their root), slots and fields in a preview render', async () => {
    const host = await html({
      value: body,
      components,
      catalog,
      preview: ref1,
      ghosts: { inserted: ['k3'] },
    });
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

  it('renders an empty slot the catalog names as its marked element', async () => {
    const host = await html({
      value: [{ _type: 'grid', _key: 'g' }],
      components,
      catalog,
      preview: ref1,
    });
    const ul = host.querySelector('ul');
    expect(ul?.children).toHaveLength(0);
    expect(parseContentRef(ul?.getAttribute('data-cw-slot'))?.field).toBe('body[g].cards');
  });

  it('renders an unknown block with the fallback, or not at all', async () => {
    const Fallback = defineComponent({
      props: { block: { type: Object, required: true } },
      setup: (props) => () => h('div', { class: 'unknown' }, String(props.block._type)),
    });
    const value = [{ _type: 'quote', _key: 'q' }, ...body];
    const withFallback = await html({ value, components, catalog, fallback: Fallback });
    expect(withFallback.querySelector('.unknown')?.textContent).toBe('quote');
    const without = await html({ value, components, catalog });
    expect(without.querySelector('.unknown')).toBeNull();
    expect(without.querySelectorAll('section')).toHaveLength(2);
  });

  it('keys blocks by _key and reads the new block after an edit', async () => {
    const Counter = defineComponent({
      props: { block: { type: Object as PropType<CardBlock>, required: true } },
      setup(props) {
        const n = ref(0);
        const context = useBlock<CardBlock>();
        return () =>
          h(
            'button',
            { type: 'button', onClick: () => n.value++ },
            `${props.block.title}/${context.block.title}:${n.value}`,
          );
      },
    });
    const value = ref<CardBlock[]>([
      { _type: 'card', _key: 'a', title: 'A' },
      { _type: 'card', _key: 'b', title: 'B' },
    ]);
    const host = document.createElement('div');
    const app = createApp({
      render: () => h(CwBlocks, { value: value.value, components: { card: Counter } }),
    });
    app.mount(host);
    host.querySelector('button')?.click();
    await nextTick();
    value.value = [
      { _type: 'card', _key: 'b', title: 'B' },
      { _type: 'card', _key: 'a', title: 'A2' },
    ];
    await nextTick();
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'B/B:0',
      'A2/A2:1',
    ]);
    app.unmount();
  });

  it('gives block as a prop only to a component that takes it', async () => {
    const ViaContext = defineComponent({
      setup() {
        const context = useBlock<CardBlock>();
        return () => h('li', { class: 'context' }, context.block.title);
      },
    });
    const Functional = (props: { block?: CardBlock }) =>
      h('li', { class: 'fn' }, props.block?.title);
    const host = document.createElement('div');
    const app = createApp({
      render: () =>
        h(CwBlocks, {
          value: [
            { _type: 'a', _key: 'a', title: 'A' },
            { _type: 'b', _key: 'b', title: 'B' },
          ],
          components: { a: ViaContext, b: Functional },
          preview: ref1,
        }),
    });
    app.mount(host);
    await nextTick();
    const [a, b] = [...host.querySelectorAll('li')];
    expect([a?.textContent, b?.textContent]).toEqual(['A', 'B']);
    expect(a?.hasAttribute('block')).toBe(false);
    // The preview mark still falls through onto the root.
    expect(parseContentRef(a?.getAttribute('data-cw-ref'))?.field).toBe('body[a]');
    app.unmount();
  });

  it('refuses useBlock outside a block', () => {
    const app = createApp({
      setup() {
        useBlock();
        return () => null;
      },
    });
    app.config.warnHandler = () => {};
    let error: unknown;
    app.config.errorHandler = (e) => {
      error = e;
    };
    app.mount(document.createElement('div'));
    expect(String(error)).toMatch(/useBlock must be called/);
  });
});
