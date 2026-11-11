import { describe, expect, it } from 'vitest';
import {
  type BlockCatalogLike,
  renderBlocks,
  resolveBlocks,
  responsiveProp,
} from '../src/blocks.js';

const catalog: BlockCatalogLike = {
  breakpoints: [
    { id: 'md', name: 'Tablet', minWidth: 768 },
    { id: 'lg', name: 'Desktop', minWidth: 1280 },
  ],
  blocks: [
    { id: 'hero', aliases: ['banner'], responsive: ['size', 'hidden'] },
    { id: 'grid', slots: [{ apiId: 'cards' }] },
    { id: 'card', responsive: ['hidden'] },
  ],
};

const hero = {
  _type: 'banner',
  _key: 'k1',
  size: 'md',
  heading: 'Hi',
  // `xl` and `heading` are stale: a later push removed the breakpoint, and heading was never one.
  _responsive: { lg: { size: 'xl' }, xl: { size: 'sm' }, md: { hidden: true, heading: 'x' } },
};
const body = [
  hero,
  {
    _type: 'grid',
    _key: 'k2',
    _responsive: { md: { columns: 2 } },
    cards: [{ _type: 'card', _key: 'k3', _responsive: { lg: { hidden: true } } }],
  },
];

describe('per-breakpoint overrides in the renderers', () => {
  it('gives each resolved block its declared overrides, in breakpoint order', () => {
    const { blocks } = resolveBlocks(body, { catalog });
    expect(blocks[0]?.responsive).toEqual({ md: { hidden: true }, lg: { size: 'xl' } });
    expect(Object.keys(blocks[0]?.responsive ?? {})).toEqual(['md', 'lg']);
    // A block without responsive props keeps none; one in a slot judges by the same catalog.
    expect(blocks[1]?.responsive).toEqual({});
    expect(blocks[1]?.slot('cards').blocks[0]?.responsive).toEqual({ lg: { hidden: true } });
    // The stored block is passed on as it is.
    expect(blocks[0]?.block._responsive).toBe(hero._responsive);
  });

  it('judges by the variants and the field’s breakpoints, or keeps what is stored without either', () => {
    const variants = [{ apiId: 'hero', aliases: ['banner'], responsive: ['size'], fields: [] }];
    const byVariants = resolveBlocks([hero], {
      variants,
      breakpoints: [{ id: 'lg', minWidth: 1280 }],
    });
    expect(byVariants.blocks[0]?.responsive).toEqual({ lg: { size: 'xl' } });
    expect(resolveBlocks([hero]).blocks[0]?.responsive).toEqual(hero._responsive);
    expect(resolveBlocks([{ _type: 'x', _responsive: 'odd' }]).blocks[0]?.responsive).toEqual({});
  });

  it('hands renderBlocks functions the same overrides', () => {
    const out = renderBlocks(body, {
      catalog,
      components: { hero: ({ responsive }) => JSON.stringify(responsive) },
    });
    expect(out.items).toEqual([JSON.stringify({ md: { hidden: true }, lg: { size: 'xl' } })]);
  });

  it('reads one prop at every width, base first, never picking one', () => {
    expect(responsiveProp(hero, 'size', catalog)).toEqual({ base: 'md', lg: 'xl' });
    expect(Object.keys(responsiveProp(hero, 'size', catalog))).toEqual(['base', 'lg']);
    expect(responsiveProp(hero, 'hidden', catalog)).toEqual({ base: undefined, md: true });
    // Not a responsive prop of its block: its base only.
    expect(responsiveProp(hero, 'heading', catalog)).toEqual({ base: 'Hi' });
    // Breakpoints alone: no check of the block's props.
    expect(responsiveProp(hero, 'heading', catalog.breakpoints ?? [])).toEqual({
      base: 'Hi',
      md: 'x',
    });
    expect(responsiveProp({ _type: 'hero', size: 'sm' }, 'size', catalog)).toEqual({ base: 'sm' });
  });

  it('leaves out a value that isn’t one of its prop’s tokens, when the definition gives them', () => {
    const typed: BlockCatalogLike = {
      ...catalog,
      blocks: [
        {
          id: 'hero',
          responsive: ['size', 'hidden'],
          fields: [
            { apiId: 'size', type: 'Symbol', validations: { in: ['sm', { value: 'md' }, 'xl'] } },
            { apiId: 'hidden', type: 'Boolean' },
          ],
        },
      ],
    };
    const odd = {
      _type: 'hero',
      size: 'md',
      _responsive: { md: { size: 'url(evil)', hidden: 'yes' }, lg: { size: 'md' } },
    };
    expect(resolveBlocks([odd], { catalog: typed }).blocks[0]?.responsive).toEqual({
      lg: { size: 'md' },
    });
    expect(responsiveProp(odd, 'size', typed)).toEqual({ base: 'md', lg: 'md' });
    const variants = [
      {
        apiId: 'hero',
        responsive: ['size'],
        fields: [{ apiId: 'size', type: 'Symbol', validations: { in: ['md'] } }],
      },
    ];
    expect(
      resolveBlocks([odd], { variants, breakpoints: catalog.breakpoints }).blocks[0]?.responsive,
    ).toEqual({ lg: { size: 'md' } });
  });
});
