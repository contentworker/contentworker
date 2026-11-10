/**
 * `<Blocks>`: a blocks field rendered with a React component per block id, over
 * `@contentworker/sdk-core/blocks`. Each component gets its block (typed by codegen's
 * `BlockTypes`) and its slots as functions rendering the slot's blocks with the same components.
 * No hooks, so it renders on the server and in server components alike.
 */
import type { ContentRef } from '@contentworker/sdk-core';
import {
  type BlockAttrs,
  type BlockCatalogLike,
  type BlockGhost,
  type BlockGhosts,
  type BlockTypeMap,
  type BlockValue,
  type BlockVariantLike,
  type FieldAttrs,
  type ResolvedBlocks,
  resolveBlocks,
  type UnknownBlock,
} from '@contentworker/sdk-core/blocks';
import {
  type ComponentType,
  createElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

/** What a slot function takes: the element holding the slot's blocks, and its attributes. */
export type SlotProps = HTMLAttributes<HTMLElement> & {
  /** The element holding the slot's blocks; `div` by default. It carries the slot's preview mark. */
  readonly as?: string;
};

/** Renders one slot of a block: `slots.cards({ as: 'ul', className: 'grid' })`. */
export type SlotRender = (props?: SlotProps) => ReactElement;

/** The fields of `B` holding a list of blocks: its slots. Any name, for an untyped block. */
export type SlotNames<B> = string extends keyof B
  ? string
  : {
      [K in keyof B]-?: NonNullable<B[K]> extends readonly BlockValue[] ? K : never;
    }[keyof B] &
      string;

/** The props a block's component is rendered with. */
export interface BlockComponentProps<B extends BlockValue = UnknownBlock> {
  /** The block, `_type` its current id: a block stored under a former id reads as this one. */
  readonly block: B;
  readonly index: number;
  /** Set in a live preview for a block Coworker proposes: draw it as a ghost. */
  readonly ghost: BlockGhost | undefined;
  /** Spread onto the block's root element: its preview mark, empty outside a preview render. */
  readonly attrs: BlockAttrs;
  /** Spread onto an element rendering one field: `<h2 {...fieldAttrs('heading')}>`. */
  readonly fieldAttrs: (field: Exclude<keyof B, '_type' | '_key'> & string) => FieldAttrs;
  /** Each slot, rendered: `{slots.cards()}`. A slot holding nothing renders its empty element. */
  readonly slots: { readonly [K in SlotNames<B>]: SlotRender };
}

/** A component per block id, each typed by its block: `BlockComponents<BlockTypes>`. */
export type BlockComponents<M extends BlockTypeMap<M> = Record<string, UnknownBlock>> = {
  readonly [K in keyof M]?: ComponentType<BlockComponentProps<M[K]>>;
};

export type BlocksProps<M extends BlockTypeMap<M> = Record<string, UnknownBlock>> = Omit<
  HTMLAttributes<HTMLElement>,
  'children'
> & {
  /** The blocks field's value. Anything that isn't a list of blocks renders an empty element. */
  readonly value: unknown;
  readonly components: BlockComponents<M>;
  /** Renders a block no component is given for (an unknown or newer `_type`); absent, nothing. */
  readonly fallback?: ComponentType<BlockComponentProps<UnknownBlock>>;
  /** The catalog (`GET …/block-catalog`, or your blocks file): renamed blocks render as their block. */
  readonly catalog?: BlockCatalogLike;
  /** Or the field's variants from its content type. */
  readonly variants?: readonly BlockVariantLike[];
  /** `view.ghosts` from a live preview. */
  readonly ghosts?: BlockGhosts;
  /**
   * The field as a live preview ref (`{ space, environment, entryId, contentType, locale, field }`).
   * Given, blocks, slots and fields carry `data-cw-ref` and `data-cw-slot`; absent, nothing does.
   */
  readonly preview?: ContentRef | null | false;
  /** The element holding the blocks; `div` by default. */
  readonly as?: string;
};

type AnyComponent = ComponentType<BlockComponentProps<UnknownBlock>>;
type Components = Readonly<Record<string, AnyComponent | undefined>>;

function renderSlot(
  resolved: ResolvedBlocks,
  components: Components,
  fallback: AnyComponent | undefined,
  props: SlotProps,
): ReactElement {
  const { as = 'div', ...rest } = props;
  const children: ReactNode[] = [];
  for (const unit of resolved.blocks) {
    const component =
      (Object.hasOwn(components, unit.type) ? components[unit.type] : undefined) ?? fallback;
    if (!component) continue;
    const made = new Map<string, SlotRender>();
    // Any name resolves, so a slot holding nothing yet still renders the element its mark is on.
    const slots = new Proxy({} as Record<string, SlotRender>, {
      get(_target, name) {
        if (typeof name !== 'string') return undefined;
        let render = made.get(name);
        if (!render) {
          render = (p = {}) => renderSlot(unit.slot(name), components, fallback, p);
          made.set(name, render);
        }
        return render;
      },
    });
    children.push(
      createElement(component, {
        key: unit.renderKey,
        block: unit.block,
        index: unit.index,
        ghost: unit.ghost,
        attrs: unit.attrs,
        fieldAttrs: unit.fieldAttrs,
        slots,
      }),
    );
  }
  return createElement(as, { ...rest, ...resolved.attrs }, ...children);
}

/**
 * Renders a blocks field, each block with the component for its id, inside one element (`as`,
 * `div` by default) that takes the other props given.
 *
 * ```tsx
 * import type { BlockTypes } from './generated/content-types';
 *
 * const components: BlockComponents<BlockTypes> = {
 *   hero: ({ block, attrs, fieldAttrs }) => (
 *     <section {...attrs}><h1 {...fieldAttrs('heading')}>{block.heading}</h1></section>
 *   ),
 *   grid: ({ attrs, slots }) => <section {...attrs}>{slots.cards({ as: 'ul' })}</section>,
 * };
 *
 * <Blocks value={page.fields.body} components={components} as="main" />
 * ```
 */
export function Blocks<M extends BlockTypeMap<M> = Record<string, UnknownBlock>>(
  props: BlocksProps<M>,
): ReactElement {
  const { value, components, fallback, catalog, variants, ghosts, preview, ...element } = props;
  const resolved = resolveBlocks(value, { catalog, variants, ghosts, preview });
  return renderSlot(resolved, components as Components, fallback, element);
}
