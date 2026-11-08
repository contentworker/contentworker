/**
 * Build → Blocks' rules editor, as data: every place the catalog lets blocks go (each target's top
 * level and each block's slot) with the code's own rule there, the admin's narrowing of each as it
 * is typed, and the config a save sends. The parts are named as the domain's `checkBlockConfig`
 * names them (`targets[page.body]`, `blocks[grid].slots.items`), so a 422's issues land on the
 * controls they name.
 *
 * A draft is seeded from the rules in force (`GET …/block-config/effective`), never from the stored
 * config: aliases are followed to the ids the catalog has now and the stale parts are already left
 * out, so what a save sends is a config the catalog in force accepts. It only ever narrows: the
 * blocks it can choose are the code's, and the config it would send is checked by the domain's
 * `checkBlockConfig` before it is (the server checks it again).
 */
import {
  type BlockCatalog,
  type BlockConfigCatalog,
  type BlockNarrowing,
  canonicalJson,
  checkBlockConfig,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  effectiveBlockRules,
  type SlotNarrowing,
  type TargetNarrowing,
  ValidationError,
} from '@contentworker/domain';

/** What the code allows at a place. */
export interface CodeRule {
  /** The block ids it takes, in the catalog's order. */
  readonly allowed: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

/** A place blocks go: a target's top level, or one block's slot. */
export type Place =
  | {
      readonly kind: 'target';
      readonly key: string;
      readonly contentTypeApiId: string;
      readonly field: string;
      readonly code: CodeRule;
    }
  | {
      readonly kind: 'slot';
      readonly key: string;
      readonly block: string;
      readonly slot: string;
      readonly code: CodeRule;
    };

export const targetKey = (contentTypeApiId: string, field: string) =>
  `targets[${contentTypeApiId}.${field}]`;
export const slotKey = (block: string, slot: string) => `blocks[${block}].slots.${slot}`;

/** Every place of `catalog`, targets first, then each block's slots, in the catalog's order. */
export function placesOf(catalog: BlockCatalog): Place[] {
  const code = effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG);
  const bounds = (r: { readonly min?: number; readonly max?: number }) => ({
    ...(r.min !== undefined ? { min: r.min } : {}),
    ...(r.max !== undefined ? { max: r.max } : {}),
  });
  return [
    ...code.targets.map(
      (t): Place => ({
        kind: 'target',
        key: targetKey(t.contentTypeApiId, t.field),
        contentTypeApiId: t.contentTypeApiId,
        field: t.field,
        code: { allowed: t.blocks, ...bounds(t) },
      }),
    ),
    ...code.blocks.flatMap((b) =>
      Object.entries(b.slots).map(
        ([slot, r]): Place => ({
          kind: 'slot',
          key: slotKey(b.block, slot),
          block: b.block,
          slot,
          code: { allowed: r.allowedChildren, ...bounds(r) },
        }),
      ),
    ),
  ];
}

/** One place's narrowing as the admin has it: bounds as typed ('' is the code's). */
export interface PartDraft {
  /** The blocks it takes: a subset of the code's, in the catalog's order. */
  readonly allowed: readonly string[];
  readonly min: string;
  readonly max: string;
  readonly locked: boolean;
}

export type Draft = Readonly<Record<string, PartDraft>>;

/** The draft of the rules in force: each place as narrowed now, the code's where it isn't. */
export function seedDraft(places: readonly Place[], rules: EffectiveBlockRules | undefined): Draft {
  const out: Record<string, PartDraft> = {};
  for (const p of places) {
    const r =
      p.kind === 'target'
        ? rules?.targets.find(
            (t) => t.contentTypeApiId === p.contentTypeApiId && t.field === p.field,
          )
        : rules?.blocks.find((b) => b.block === p.block)?.slots[p.slot];
    const allowed = r ? ('blocks' in r ? r.blocks : r.allowedChildren) : p.code.allowed;
    out[p.key] = {
      allowed,
      min: r?.min !== undefined && r.min !== p.code.min ? String(r.min) : '',
      max: r?.max !== undefined && r.max !== p.code.max ? String(r.max) : '',
      locked: r?.locked ?? false,
    };
  }
  return out;
}

const WHOLE = /^\d+$/;

/** A bound as typed: undefined when blank (the code's), NaN when it isn't a whole number. */
function parse(text: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  return WHOLE.test(t) ? Number(t) : Number.NaN;
}

/**
 * What's wrong with a draft before it is sent, by control (`<part>.blocks` or
 * `<part>.allowedChildren`, `<part>.min`, `<part>.max`, or `<part>` for the two bounds together):
 * a bound that isn't a whole number, said here, and everything else the domain's own
 * `checkBlockConfig` finds of the config it would send (fewer than the code's least, more than its
 * most, no blocks at all), in its words, as the server would refuse it.
 */
export function draftErrors(
  places: readonly Place[],
  draft: Draft,
  catalog: BlockConfigCatalog,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of places) {
    const d = draft[p.key];
    if (!d) continue;
    for (const which of ['min', 'max'] as const) {
      if (Number.isNaN(parse(d[which]))) {
        out[`${p.key}.${which}`] = 'A whole number, or blank for the code’s.';
      }
    }
  }
  try {
    checkBlockConfig(configFromDraft(places, draft), catalog);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    for (const [key, message] of Object.entries(issuesByControl(places, err.issues))) {
      out[key] ??= message;
    }
  }
  return out;
}

/**
 * The config a draft sends: each list in the catalog's order, sent when it leaves a block out, and
 * each bound sent when it differs from the code's (a wider one too, for `checkBlockConfig` to
 * refuse: a draft is only saved once that finds nothing).
 */
export function configFromDraft(
  places: readonly Place[],
  draft: Draft,
): { targets: TargetNarrowing[]; blocks: BlockNarrowing[] } {
  const targets: TargetNarrowing[] = [];
  const slots = new Map<string, [string, SlotNarrowing][]>();
  for (const p of places) {
    const d = draft[p.key];
    if (!d) continue;
    const chosen = new Set(d.allowed);
    const list = p.code.allowed.filter((id) => chosen.has(id));
    const min = parse(d.min);
    const max = parse(d.max);
    const n = {
      ...(list.length < p.code.allowed.length ? { list } : {}),
      ...(min !== undefined && !Number.isNaN(min) && min !== (p.code.min ?? 0) ? { min } : {}),
      ...(max !== undefined && !Number.isNaN(max) && max !== p.code.max ? { max } : {}),
      ...(d.locked ? { locked: true } : {}),
    };
    if (Object.keys(n).length === 0) continue;
    const { list: blocks, ...rest } = n as typeof n & { list?: string[] };
    if (p.kind === 'target') {
      targets.push({
        contentTypeApiId: p.contentTypeApiId,
        field: p.field,
        ...(blocks ? { blocks } : {}),
        ...rest,
      });
    } else {
      const of = slots.get(p.block) ?? [];
      of.push([p.slot, { ...(blocks ? { allowedChildren: blocks } : {}), ...rest }]);
      slots.set(p.block, of);
    }
  }
  return {
    targets,
    blocks: [...slots].map(([block, entries]) => ({
      block,
      slots: Object.fromEntries(entries),
    })),
  };
}

/** Whether two drafts send the same config. */
export function sameConfig(places: readonly Place[], a: Draft, b: Draft): boolean {
  return canonicalJson(configFromDraft(places, a)) === canonicalJson(configFromDraft(places, b));
}

/**
 * A domain issue's message as a control shows it. The domain writes fragments that follow a field
 * path in an API error (`…items.max: cannot be above the code's max of 4`); beside the control the
 * path is already said, so the bounds read as the limit they name and the rest as a sentence.
 */
export function controlMessage(message: string): string {
  const max = /^cannot be above the code[’']s max of (\d+)$/.exec(message);
  if (max) return `At most ${max[1]}: the code’s limit.`;
  const min = /^cannot be below the code[’']s min of (\d+)$/.exec(message);
  if (min) return `At least ${min[1]}: the code’s limit.`;
  if (/^names at least one block id/.test(message)) return 'Choose at least one block.';
  // The controls are labelled Fewest and Most.
  const crossed = /^min \((\d+)\) is more than max \((\d+)\)$/.exec(message);
  if (crossed) return `Fewest (${crossed[1]}) is more than Most (${crossed[2]}).`;
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * A refusal's issues (`{ field, message }`, fields named as the draft's parts are) by the control
 * they name, as `draftErrors` keys them, worded for the control ({@link controlMessage}); an issue
 * naming no place of the draft is under `''`.
 */
export function issuesByControl(
  places: readonly Place[],
  issues: readonly { readonly field: string; readonly message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const place = places.find((p) => issue.field === p.key || issue.field.startsWith(`${p.key}.`));
    const key = place ? issue.field : '';
    const message = controlMessage(issue.message);
    out[key] = out[key] ? `${out[key]} ${message}` : message;
  }
  return out;
}
