/**
 * `<CwBlocks>`: a blocks field rendered with a Vue component per block id, over
 * `@contentworker/sdk-core/blocks`. Each component gets its block as the `block` prop (typed by
 * codegen's `BlockTypes` in its `defineProps`), its preview mark as fallthrough attributes on its
 * root element, and its slots as Vue slots rendering the slot's blocks with the same components:
 * `<slot name="cards" as="ul" class="grid" />`. `useBlock()` reads the rest.
 */
import type { ContentRef } from '@contentworker/sdk-core';
import {
  type BlockAttrs,
  type BlockCatalogLike,
  type BlockGhost,
  type BlockGhosts,
  type BlockOverrides,
  type BlockTypeMap,
  type BlockValue,
  type BlockVariantLike,
  type BreakpointLike,
  type FieldAttrs,
  type ResolvedBlock,
  type ResolvedBlocks,
  resolveBlocks,
  type UnknownBlock,
} from '@contentworker/sdk-core/blocks';
import {
  type Component,
  defineComponent,
  h,
  type InjectionKey,
  inject,
  type PropType,
  provide,
  type VNode,
} from 'vue';

/** A component per block id: `BlockComponents<BlockTypes>`. Each declares a `block` prop, or reads `useBlock()`. */
export type BlockComponents<M extends BlockTypeMap<M> = Record<string, UnknownBlock>> = {
  readonly [K in keyof M]?: Component;
};

/** What a block's component reads with {@link useBlock}. */
export interface BlockContext<B extends BlockValue = UnknownBlock> {
  /** The block, `_type` its current id: a block stored under a former id reads as this one. */
  readonly block: B;
  /** Its per-breakpoint overrides as they apply (stale ones left out); `responsiveProp` reads one. */
  readonly responsive: BlockOverrides;
  readonly index: number;
  /** Set in a live preview for a block Coworker proposes: draw it as a ghost. */
  readonly ghost: BlockGhost | undefined;
  /** The block's preview mark, already on the component's root element when it has one. */
  readonly attrs: BlockAttrs;
  /** Bind onto an element rendering one field: `v-bind="fieldAttrs('heading')"`. */
  readonly fieldAttrs: (field: Exclude<keyof B, '_type' | '_key'> & string) => FieldAttrs;
}

const BLOCK: InjectionKey<BlockContext> = Symbol('contentworker-block');

/**
 * Inside a block's component: its block, ghost state and field marks. Throws outside a component
 * `<CwBlocks>` renders.
 */
export function useBlock<B extends BlockValue = UnknownBlock>(): BlockContext<B> {
  const context = inject(BLOCK, null);
  if (!context) throw new Error('useBlock must be called in a component <CwBlocks> renders');
  return context as unknown as BlockContext<B>;
}

type Components = Readonly<Record<string, Component | undefined>>;

interface Render {
  readonly components: Components;
  readonly fallback: Component | undefined;
}

/** What a slot takes: `as`, the element holding its blocks (`div` by default), and attributes. */
type SlotProps = Record<string, unknown> & { as?: string };

function renderSlot(resolved: ResolvedBlocks, render: Render, props: SlotProps = {}): VNode {
  const { as = 'div', ...rest } = props;
  const children: VNode[] = [];
  for (const unit of resolved.blocks) {
    const component =
      (Object.hasOwn(render.components, unit.type) ? render.components[unit.type] : undefined) ??
      render.fallback;
    if (component) {
      children.push(h(Block, { key: unit.renderKey, unit, component, render }));
    }
  }
  return h(as, { ...rest, ...resolved.attrs }, children);
}

/**
 * Whether a component is given `block` as a prop: one that declares it, or a functional component
 * declaring no props (which gets every attribute as one). Any other would have it fall through
 * onto its root element as `block="[object Object]"`, so one that reads `useBlock()` instead isn't
 * given it.
 */
function takesBlock(component: Component): boolean {
  const props = (component as { props?: unknown }).props;
  if (Array.isArray(props)) return props.includes('block');
  if (props && typeof props === 'object') return Object.hasOwn(props, 'block');
  return typeof component === 'function';
}

/** One block: provides its context, and renders its component with its slots. */
const Block = defineComponent({
  name: 'CwBlock',
  inheritAttrs: false,
  props: {
    unit: { type: Object as PropType<ResolvedBlock>, required: true },
    component: { type: [Object, Function] as PropType<Component>, required: true },
    render: { type: Object as PropType<Render>, required: true },
  },
  setup(props) {
    // Getters, so a re-render with the same key reads the new block.
    provide(BLOCK, {
      get block() {
        return props.unit.block;
      },
      get responsive() {
        return props.unit.responsive;
      },
      get index() {
        return props.unit.index;
      },
      get ghost() {
        return props.unit.ghost;
      },
      get attrs() {
        return props.unit.attrs;
      },
      fieldAttrs: (field: string) => props.unit.fieldAttrs(field),
    });
    return () => {
      const { unit, component, render } = props;
      const slots = Object.fromEntries(
        unit.slotNames.map((name) => [
          name,
          (slotProps?: SlotProps) => renderSlot(unit.slot(name), render, slotProps),
        ]),
      );
      return h(
        component,
        takesBlock(component) ? { block: unit.block, ...unit.attrs } : unit.attrs,
        slots,
      );
    };
  },
});

/**
 * Renders a blocks field, each block with the component for its id, inside one element (`as`,
 * `div` by default) that takes the attributes given. A slot is known when the block holds blocks
 * there, or when `catalog` or `variants` names it: pass one, so an empty slot still renders the
 * element its preview mark is on.
 *
 * ```vue
 * <CwBlocks :value="page.fields.body" :components="{ hero: Hero, grid: Grid }" as="main" />
 * ```
 */
export const CwBlocks = defineComponent({
  name: 'CwBlocks',
  props: {
    /** The blocks field's value. Anything that isn't a list of blocks renders an empty element. */
    value: { type: null as unknown as PropType<unknown>, default: undefined },
    components: { type: Object as PropType<BlockComponents>, required: true },
    /** Renders a block no component is given for (an unknown or newer `_type`); absent, nothing. */
    fallback: { type: [Object, Function] as PropType<Component>, default: undefined },
    catalog: { type: Object as PropType<BlockCatalogLike>, default: undefined },
    variants: { type: Array as PropType<readonly BlockVariantLike[]>, default: undefined },
    /** With `variants`, the field's breakpoints (`items.breakpoints`). */
    breakpoints: { type: Array as PropType<readonly BreakpointLike[]>, default: undefined },
    ghosts: { type: Object as PropType<BlockGhosts>, default: undefined },
    /** The field as a live preview ref. Given, blocks, slots and fields carry their marks. */
    preview: {
      type: [Object, Boolean, null] as PropType<ContentRef | null | false>,
      default: undefined,
    },
    as: { type: String, default: 'div' },
  },
  setup(props) {
    return () => {
      const resolved = resolveBlocks(props.value, {
        catalog: props.catalog,
        variants: props.variants,
        breakpoints: props.breakpoints,
        ghosts: props.ghosts,
        preview: props.preview,
      });
      return renderSlot(
        resolved,
        { components: props.components as Components, fallback: props.fallback },
        { as: props.as },
      );
    };
  },
});
