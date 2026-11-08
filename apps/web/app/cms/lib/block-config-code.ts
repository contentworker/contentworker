/**
 * Build → Blocks' rules as code, as text: the block config exactly as `PUT …/block-config` takes it
 * (`{ targets, blocks }`), and, per place, the code's rule beside the rule in force, both as JSON in
 * one shape, for the Code and Narrowed from code views.
 *
 * Stable: the same rules always print the same text, so a copy diffs cleanly against the last and
 * the views never flicker on a refetch. Targets and slots go in the catalog's order (`placesOf`), a
 * part's keys in the order the domain's `checkBlockConfig` returns them, and a list in the catalog's
 * order. Pure: the views draw what this says.
 */
import type {
  BlockNarrowing,
  EffectiveBlockRules,
  SlotNarrowing,
  StaleNarrowing,
  TargetNarrowing,
} from '@contentworker/domain';
import type { Place } from './block-config-draft';

/** The body a save sends, without its `expectedVersion`. */
export interface BlockConfigBody {
  readonly targets: readonly TargetNarrowing[];
  readonly blocks: readonly BlockNarrowing[];
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** A rule's own fields, in the order the domain writes them; absent stays absent. */
function bounds(r: SlotNarrowing | TargetNarrowing) {
  return {
    ...(r.min !== undefined ? { min: r.min } : {}),
    ...(r.max !== undefined ? { max: r.max } : {}),
    ...(r.locked ? { locked: true } : {}),
  };
}

/**
 * The config as the API takes it, as JSON: targets and blocks in the catalog's order (anything the
 * catalog doesn't name after, as given), each part's keys in the domain's order.
 */
export function configJson(places: readonly Place[], config: BlockConfigBody): string {
  const order = new Map(places.map((p, i) => [p.key, i]));
  const at = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  const targetAt = (t: TargetNarrowing) => at(`targets[${t.contentTypeApiId}.${t.field}]`);
  const slotAt = (block: string, slot: string) => at(`blocks[${block}].slots.${slot}`);
  // A block sorts by its first slot: its slots are listed together in the catalog.
  const blockAt = (b: BlockNarrowing) =>
    Math.min(Number.MAX_SAFE_INTEGER, ...Object.keys(b.slots).map((s) => slotAt(b.block, s)));
  const byOrder = <T>(list: readonly T[], of: (x: T) => number) =>
    list
      .map((x, i) => [x, of(x), i] as const)
      .sort((a, b) => a[1] - b[1] || a[2] - b[2])
      .map(([x]) => x);
  return json({
    targets: byOrder(config.targets, targetAt).map((t) => ({
      contentTypeApiId: t.contentTypeApiId,
      field: t.field,
      ...(t.blocks ? { blocks: t.blocks } : {}),
      ...bounds(t),
    })),
    blocks: byOrder(config.blocks, blockAt).map((b) => ({
      block: b.block,
      slots: Object.fromEntries(
        byOrder(Object.entries(b.slots), ([slot]) => slotAt(b.block, slot)).map(([slot, s]) => [
          slot,
          { ...(s.allowedChildren ? { allowedChildren: s.allowedChildren } : {}), ...bounds(s) },
        ]),
      ),
    })),
  });
}

/** What a narrowing can change at a place, named as the Rules controls are. */
export type RulePart = 'blocks' | 'min' | 'max' | 'locked';

/** One place as code: the code's rule and the one in force, in one JSON shape. */
export interface PlaceCode {
  readonly place: Place;
  /** The code's rule (`{ blocks | allowedChildren, min?, max?, locked: false }`), as JSON. */
  readonly code: string;
  /** The rule in force, in the same shape. */
  readonly inForce: string;
  /** Whether the rule in force narrows the code's here: the domain's own `narrowed`. */
  readonly narrowed: boolean;
  /** What differs, in the order the JSON has it, for the words; empty where nothing is narrowed. */
  readonly changed: readonly RulePart[];
  /** The parts of the stored config at this place that are ignored (stale). */
  readonly ignored: readonly StaleNarrowing[];
}

interface Rule {
  readonly list: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly locked: boolean;
  readonly narrowed: boolean;
}

/** A rule in a place's shape: a target's list is `blocks`, a slot's `allowedChildren`. */
function ruleJson(place: Place, r: Rule): string {
  return json({
    [place.kind === 'target' ? 'blocks' : 'allowedChildren']: r.list,
    ...(r.min !== undefined ? { min: r.min } : {}),
    ...(r.max !== undefined ? { max: r.max } : {}),
    locked: r.locked,
  });
}

function inForceAt(rules: EffectiveBlockRules, p: Place): Rule | undefined {
  if (p.kind === 'target') {
    const t = rules.targets.find(
      (t) => t.contentTypeApiId === p.contentTypeApiId && t.field === p.field,
    );
    return t && { list: t.blocks, min: t.min, max: t.max, locked: t.locked, narrowed: t.narrowed };
  }
  const s = rules.blocks.find((b) => b.block === p.block)?.slots[p.slot];
  return (
    s && {
      list: s.allowedChildren,
      min: s.min,
      max: s.max,
      locked: s.locked,
      narrowed: s.narrowed,
    }
  );
}

/** Whether a stale part's path is at `key` or inside it (`targets[page.body].blocks`). */
const within = (at: string, key: string) => at === key || at.startsWith(`${key}.`);

/**
 * Every place, the code's rule beside the one in force (`rules`: from the api, or laid over a draft),
 * with what differs and, from `stale` (the stored config's ignored parts), what at it is ignored. A
 * place the rules don't name (a push landed between the reads) is the code's on both sides.
 */
export function placesAsCode(
  places: readonly Place[],
  rules: EffectiveBlockRules,
  stale: readonly StaleNarrowing[] = rules.stale,
): PlaceCode[] {
  return places.map((place) => {
    const code: Rule = {
      list: place.code.allowed,
      min: place.code.min,
      max: place.code.max,
      locked: false,
      narrowed: false,
    };
    const now = inForceAt(rules, place) ?? code;
    const changed: RulePart[] = [];
    if (now.list.join('\n') !== code.list.join('\n')) changed.push('blocks');
    if (now.min !== code.min) changed.push('min');
    if (now.max !== code.max) changed.push('max');
    if (now.locked !== code.locked) changed.push('locked');
    return {
      place,
      code: ruleJson(place, code),
      inForce: ruleJson(place, now),
      narrowed: now.narrowed,
      changed,
      ignored: stale.filter((s) => within(s.at, place.key)),
    };
  });
}

/**
 * The places a diff shows: those whose rule in force isn't the code's, and those with ignored parts
 * (the code's rule applies there, though the config says otherwise); every place with `all`.
 */
export function placesToShow(list: readonly PlaceCode[], all: boolean): PlaceCode[] {
  return all ? [...list] : list.filter((p) => p.narrowed || p.ignored.length > 0);
}

/** The stale parts no place holds: a target or a block the catalog no longer has. */
export function ignoredElsewhere(
  places: readonly Place[],
  stale: readonly StaleNarrowing[],
): StaleNarrowing[] {
  return stale.filter((s) => !places.some((p) => within(s.at, p.key)));
}

const PART_WORDS: Record<RulePart, string> = {
  blocks: 'the blocks it takes',
  min: 'the fewest',
  max: 'the most',
  locked: 'locked',
};

/** What a narrowing changed, in the Rules controls' words: "the blocks it takes, the most, locked". */
export function changedText(changed: readonly RulePart[]): string {
  return changed.map((c) => PART_WORDS[c]).join(', ');
}
