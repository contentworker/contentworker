/**
 * A proposed block patch, as its confirm card reads it: the api's dry run of the very call that
 * runs on Confirm (`POST …/entries/blocks/validate`, `checkEntryBlocks`), so what the card says is
 * what the save would do. Its steps and its review name blocks by their type's name and label, from
 * the keys the api answers with, never by key and never by position; a refusal is read from the
 * api's structured answer (a 409's versions, a 403's details, a 422's issue code and block key),
 * never from its wording.
 */

import {
  applyBlockPatch,
  type BlockOp,
  type BlockOutline,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EntryFields,
  outlineBlocks,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { TriangleAlert } from 'lucide-react';
import { ApiError, type ManagementClient } from '../../lib/management';
import { entryRef } from '../dashboard/entry-titles';
import { valueText } from '../EntryDiff';
import type { ReviewField } from '../entries/EntryReview';

/** Why a block patch can't be confirmed as it stands, as its dry run answered. */
export type BlockRefusal =
  /** The draft moved past the version the patch was made for: the save would be refused. */
  | { readonly why: 'moved'; readonly now?: number; readonly expected: number }
  /** A step doesn't apply to the draft, said in the card's words from the issue's code. */
  | { readonly why: 'step'; readonly step: number; readonly text: string }
  /** The result breaks a rule of the content model, where it would break it. */
  | { readonly why: 'invalid'; readonly where: string; readonly message: string }
  /** It edits fields this person can't read (their role can't write them either), counted. */
  | { readonly why: 'hidden'; readonly count: number }
  /** It edits a field this person can read but whose role makes it read-only. */
  | { readonly why: 'locked'; readonly field: string }
  /** The role can't change this entry at all. */
  | { readonly why: 'denied' }
  | { readonly why: 'nothing' }
  /** The call doesn't say which entry, at which version, or what to change. */
  | { readonly why: 'unclear' };

/** What the card shows of a patch the api would save. */
export interface BlockPatchRead {
  readonly status: 'ready';
  readonly title: string;
  /** Each step in words: what it does to which block, and where. */
  readonly steps: readonly string[];
  /** What changes: each touched slot's order, then each updated block's fields. */
  readonly fields: readonly ReviewField[];
}

export type BlockPatchReview =
  | BlockPatchRead
  | { readonly status: 'refused'; readonly title?: string; readonly refusal: BlockRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --- the blocks of a draft, by key -----------------------------------------------

/** One field's tree in one locale: keys are unique only there (a copied locale keeps them). */
const treeOf = (field: string, locale: string) => `${field}\u0000${locale}`;
const at = (field: string, locale: string, key: string) => `${treeOf(field, locale)}\u0000${key}`;
/** A slot: a field's top in one locale, or a parent block's blocks field. */
const slotOf = (field: string, locale: string, parent?: { key: string; slot: string }) =>
  `${treeOf(field, locale)}\u0000${parent ? `${parent.key}\u0000${parent.slot}` : ''}`;
/** A block of a slot's tree, by key. */
const inSlot = (slot: string, key: string) =>
  `${slot.split('\u0000').slice(0, 2).join('\u0000')}\u0000${key}`;
/** The locale a slot's tree is in. */
const localeOfSlot = (slot: string) => slot.split('\u0000')[1] ?? '';

/** A draft's addressable blocks, read from its outline: names, slots in order, and where each is. */
interface BlockIndex {
  /** "Hero “Spring launch”", or the type's name alone, by tree and key. */
  readonly names: Map<string, string>;
  /** The variant each block is, for its fields' names. */
  readonly variants: Map<string, ComponentVariant>;
  /** Each non-empty slot's keys, in order. */
  readonly slots: Map<string, string[]>;
  /** The slot each block sits in. */
  readonly home: Map<string, string>;
  /** Each slot as a person reads it: "Body", "Section “Features” › Items". */
  readonly labels: Map<string, string>;
}

function indexBlocks(type: ContentType, fields: EntryFields): BlockIndex {
  const index: BlockIndex = {
    names: new Map(),
    variants: new Map(),
    slots: new Map(),
    home: new Map(),
    labels: new Map(),
  };
  const outline = outlineBlocks(type, fields);
  for (const def of type.fields) {
    const variants = blockVariants(def);
    if (!variants) continue;
    for (const [locale, nodes] of Object.entries(outline[def.apiId] ?? {})) {
      const walk = (
        list: readonly BlockOutline[],
        admitted: readonly ComponentVariant[],
        slot: string,
        label: string,
      ) => {
        index.labels.set(slot, label);
        const keys: string[] = [];
        for (const n of list) {
          if (n.key === null) continue;
          const id = at(def.apiId, locale, n.key);
          const name = n.label ? `${n.name} “${n.label}”` : n.name;
          const variant = admitted.find((v) => v.apiId === n.type);
          index.names.set(id, name);
          if (variant) index.variants.set(id, variant);
          index.home.set(id, slot);
          keys.push(n.key);
          for (const [child, kids] of Object.entries(n.children ?? {})) {
            const slotDef = variant?.fields.find((f) => f.apiId === child);
            walk(
              kids,
              (slotDef && blockVariants(slotDef)) ?? [],
              slotOf(def.apiId, locale, { key: n.key, slot: child }),
              `${name} › ${slotDef?.name ?? child}`,
            );
          }
        }
        index.slots.set(slot, keys);
      };
      walk(nodes, variants, slotOf(def.apiId, locale), def.name);
    }
  }
  return index;
}

/** The block a key names in one tree of `fields`, as stored. */
function findBlock(fields: EntryFields, field: string, locale: string, key: string) {
  const search = (v: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(v)) {
      for (const x of v) {
        const found = search(x);
        if (found) return found;
      }
    } else if (isRecord(v)) {
      if (v._key === key) return v;
      for (const x of Object.values(v)) {
        const found = search(x);
        if (found) return found;
      }
    }
    return undefined;
  };
  return search(fields[field]?.[locale]);
}

/**
 * The draft before each applied step, from the applied ops themselves (they carry every key and
 * position, so the domain's own patch replays them with nothing to mint). Stops where one doesn't
 * replay, so a step past it is said without where it lands.
 */
function statesBefore(
  type: ContentType,
  before: EntryFields,
  applied: readonly BlockOp[],
): EntryFields[] {
  const states = [before];
  for (const op of applied) {
    try {
      const next = applyBlockPatch(type, states.at(-1) as EntryFields, [op], () => {
        throw new Error('An applied op carries its keys');
      });
      if (!next.ok) break;
      states.push(next.fields);
    } catch {
      break;
    }
  }
  return states;
}

// --- steps in words ------------------------------------------------------------------

/**
 * Where a block lands in `keys` (the slot without it) at `index`: the start, the end, after a
 * sibling, or into an empty slot.
 */
function landing(
  keys: readonly string[],
  index: number,
  where: string,
  name: (key: string) => string,
): string {
  if (keys.length === 0) return `into ${where}`;
  if (index <= 0) return `at the start of ${where}`;
  if (index >= keys.length) return `to the end of ${where}`;
  return `after ${name(keys[index - 1] as string)}`;
}

function stepText(
  verb: unknown,
  applied: BlockOp,
  state: BlockIndex | undefined,
  after: BlockIndex,
  type: ContentType,
  shown: string,
): string {
  const { field, locale } = applied;
  const name = (key: string) =>
    state?.names.get(at(field, locale, key)) ??
    after.names.get(at(field, locale, key)) ??
    'a block';
  const fieldName = type.fields.find((f) => f.apiId === field)?.name ?? field;
  /**
   * Where a block goes: the field, or the block whose slot takes it, and where in it when the draft
   * before the step is known.
   */
  const destination = (
    key: string,
    parent: { key: string; slot: string } | undefined,
    index: number | undefined,
  ) => {
    const target = slotOf(field, locale, parent);
    const where = parent ? name(parent.key) : fieldName;
    if (!state || index === undefined) return `in ${where}`;
    const keys = (state.slots.get(target) ?? []).filter((k) => k !== key);
    const place = landing(keys, index, where, name);
    // A block crossing into another block's slot says which one, when its place names only a sibling.
    const crossing = state.home.get(at(field, locale, key)) !== target;
    return crossing && place.startsWith('after ') && target !== slotOf(field, locale)
      ? `into ${where}, ${place}`
      : place;
  };
  let text: string;
  if (applied.op === 'insert') {
    const key = String(applied.block._key);
    text =
      verb === 'duplicate'
        ? `Duplicates ${name(findOriginal(applied, state, after) ?? key)}`
        : `Adds ${after.names.get(at(field, locale, key)) ?? 'a block'} ${destination(key, applied.parent, applied.index)}`;
  } else if (applied.op === 'move') {
    text = `Moves ${name(applied.key)} ${destination(applied.key, applied.to.parent, applied.to.index)}`;
  } else if (applied.op === 'update') {
    text = `Changes ${name(applied.key)}`;
  } else {
    text = `Removes ${name(applied.key)}`;
  }
  return locale === shown ? text : `${text} (${locale})`;
}

/** A duplicate's original: the block right before its copy, in the draft before the step. */
function findOriginal(
  applied: Extract<BlockOp, { op: 'insert' }>,
  state: BlockIndex | undefined,
  after: BlockIndex,
): string | undefined {
  const slot = slotOf(applied.field, applied.locale, applied.parent);
  const keys = (state ?? after).slots.get(slot) ?? [];
  const index = applied.index ?? keys.length;
  return keys[index - 1];
}

// --- what changes ------------------------------------------------------------------

/**
 * What a patch changes, by key: each slot a structural step touches as its order before and after
 * (by block name), then each updated block's fields, before and after. Never by position: a text
 * diff of a list compares whichever blocks sit at the same index.
 */
function reviewOf(
  applied: readonly BlockOp[],
  states: readonly BlockIndex[],
  before: BlockIndex,
  after: BlockIndex,
  beforeFields: EntryFields,
  afterFields: EntryFields,
  shown: string,
): ReviewField[] {
  const slots = new Set<string>();
  const updates = new Map<
    string,
    { field: string; locale: string; key: string; names: Set<string> }
  >();
  applied.forEach((op, i) => {
    const state = states[i] ?? before;
    const { field, locale } = op;
    if (op.op === 'insert') slots.add(slotOf(field, locale, op.parent));
    else if (op.op === 'move') {
      slots.add(slotOf(field, locale, op.to.parent));
      const from = state.home.get(at(field, locale, op.key));
      if (from) slots.add(from);
    } else if (op.op === 'remove') {
      const from = state.home.get(at(field, locale, op.key));
      if (from) slots.add(from);
    } else if (op.op === 'update') {
      const id = at(field, locale, op.key);
      const entry = updates.get(id) ?? { field, locale, key: op.key, names: new Set<string>() };
      for (const n of [...Object.keys(op.set ?? {}), ...(op.unset ?? [])]) entry.names.add(n);
      updates.set(id, entry);
    }
  });
  const order = (index: BlockIndex, slot: string) =>
    (index.slots.get(slot) ?? [])
      .map((k) => index.names.get(inSlot(slot, k)) ?? 'A block')
      .join(' · ');
  const out: ReviewField[] = [];
  for (const slot of slots) {
    const was = order(before, slot);
    const now = order(after, slot);
    if (was === now) continue;
    const locale = localeOfSlot(slot);
    out.push({
      field: `order:${slot}`,
      name: after.labels.get(slot) ?? before.labels.get(slot) ?? 'Blocks',
      kind: 'changed',
      rows: [
        {
          ...(locale !== shown ? { locale } : {}),
          before: was || 'No blocks',
          after: now || 'No blocks',
        },
      ],
    });
  }
  for (const [id, u] of updates) {
    const name = before.names.get(id) ?? after.names.get(id) ?? 'A block';
    const variant = after.variants.get(id) ?? before.variants.get(id);
    const was = findBlock(beforeFields, u.field, u.locale, u.key);
    const now = findBlock(afterFields, u.field, u.locale, u.key);
    for (const apiId of u.names) {
      const b = valueText(was?.[apiId]);
      const a = valueText(now?.[apiId]);
      if (b === a) continue;
      out.push({
        field: `update:${id}:${apiId}`,
        name: `${name} › ${variant?.fields.find((f) => f.apiId === apiId)?.name ?? apiId}`,
        kind: !b ? 'added' : !a ? 'removed' : 'changed',
        rows: [{ ...(u.locale !== shown ? { locale: u.locale } : {}), before: b, after: a }],
      });
    }
  }
  return out;
}

// --- refusals from the api's answer ------------------------------------------------

interface Issue {
  readonly op?: number;
  readonly code?: string;
  readonly key?: string;
  readonly field?: string;
  readonly locale?: string;
  readonly message?: string;
  readonly block?: { readonly key: string; readonly type: string; readonly path: string };
}

const issuesOf = (err: ApiError): Issue[] => {
  const issues = (err.body as { error?: { issues?: unknown } } | undefined)?.error?.issues;
  return Array.isArray(issues) ? (issues as Issue[]) : [];
};

/** A step's refusal in the card's words, from its code and the block its key names. */
function stepRefusal(issue: Issue, field: string, index: BlockIndex, type: ContentType): string {
  const locale = issue.locale ?? '';
  const name = issue.key ? index.names.get(at(field, locale, issue.key)) : undefined;
  const fieldName = type.fields.find((f) => f.apiId === field)?.name ?? field;
  const it = name ?? 'The block it names';
  switch (issue.code) {
    case 'unknown_key':
      return `It names a block ${fieldName} (${locale}) doesn’t hold.`;
    case 'ambiguous_key':
      return `Two blocks in ${fieldName} share the key it names, so it can’t tell which one.`;
    case 'keyless_parent':
      return `${it} sits in a block with no key; save the entry once to give it one.`;
    case 'unknown_type':
      return `${it} is of a type ${fieldName} doesn’t declare.`;
    case 'key_taken':
      return `The new block’s key is already ${name ? `${name}’s` : 'another block’s'}.`;
    case 'into_itself':
      return `${it} can’t move into itself or a block inside it.`;
    case 'placed_by_itself':
      return `${it} can’t be placed before or after itself.`;
    case 'not_in_slot':
      return `${it} isn’t in the place this step puts the block.`;
    case 'not_a_slot':
      return `${it} has no place for blocks by the name the step gives.`;
    case 'unknown_field':
      return `${it} has no field by the name the step gives.`;
    case 'type_not_allowed':
      return name
        ? `${name} can’t go there: that place doesn’t take its type.`
        : 'A block of that type can’t go there.';
    default:
      return issue.message ?? 'It doesn’t apply to this entry.';
  }
}

/** Where a rule breaks: the block by name and the field inside it, or the field by name. */
function ruleWhere(issue: Issue, index: BlockIndex, type: ContentType): string {
  const top = /^[A-Za-z]\w*/.exec(issue.field ?? '')?.[0] ?? '';
  const def = type.fields.find((f) => f.apiId === top);
  const block = issue.block;
  if (block && def) {
    const id = at(def.apiId, issue.locale ?? '', block.key);
    const name = index.names.get(id) ?? 'A block';
    const first = /^[A-Za-z]\w*/.exec(block.path)?.[0];
    const inner = index.variants.get(id)?.fields.find((f) => f.apiId === first)?.name;
    return inner ? `${name} › ${inner}` : name;
  }
  return def?.name ?? (issue.field || 'The entry');
}

/**
 * What a block patch would make of the draft, from its dry run: the api's own checks with nothing
 * written. What would refuse the save on Confirm is said instead, in words; any other failure is a
 * failed read, offered again.
 */
export async function readBlockPatch(
  client: ManagementClient,
  p: {
    readonly entryId: string;
    readonly expectedVersion?: number;
    readonly ops: readonly unknown[];
  },
  types: readonly ContentType[],
  locale: string,
): Promise<BlockPatchReview> {
  const { expectedVersion } = p;
  if (!p.entryId || expectedVersion === undefined || p.ops.length === 0)
    return { status: 'refused', refusal: { why: 'unclear' } };
  const [entry, outline] = await Promise.all([
    client.getEntry(p.entryId),
    client.getBlocksOutline(p.entryId),
  ]);
  const title = entryRef(entry, types, locale).title;
  const type = types.find((t) => t.apiId === entry.contentType);
  if (!type) throw new Error(`No content type "${entry.contentType}"`);
  const refused = (refusal: BlockRefusal): BlockPatchReview => ({
    status: 'refused',
    title,
    refusal,
  });
  // A shortcut, not the rule: a blocks field missing from the outline is one this person can't
  // read, and the dry run would refuse it the same way (a 403 counting it).
  const hidden = new Set(
    p.ops.flatMap((op) => {
      const f = isRecord(op) ? type.fields.find((d) => d.apiId === op.field) : undefined;
      return f && blockVariants(f) && !(f.apiId in outline.fields) ? [f.apiId] : [];
    }),
  );
  if (hidden.size > 0) return refused({ why: 'hidden', count: hidden.size });

  const beforeFields = entry.fields as EntryFields;
  const before = indexBlocks(type, beforeFields);
  let checked: Awaited<ReturnType<ManagementClient['checkBlockPatch']>>;
  try {
    checked = await client.checkBlockPatch(p.entryId, { expectedVersion, ops: p.ops });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const details = (err.body as { error?: { details?: Record<string, unknown> } } | undefined)
      ?.error?.details;
    if (err.status === 409) {
      const now = details?.currentVersion;
      return refused({
        why: 'moved',
        expected: expectedVersion,
        ...(typeof now === 'number' ? { now } : {}),
      });
    }
    // Every 403 is a refusal: a field named, fields counted, or the entry itself.
    if (err.status === 403) {
      if (details?.reason === 'hidden' && typeof details.hidden === 'number')
        return refused({ why: 'hidden', count: details.hidden });
      if (details?.reason === 'read_only' && typeof details.field === 'string') {
        const field = type.fields.find((f) => f.apiId === details.field)?.name ?? details.field;
        return refused({ why: 'locked', field });
      }
      return refused({ why: 'denied' });
    }
    if (err.status !== 422) throw err;
    const issue = issuesOf(err)[0];
    if (!issue) throw err;
    if (typeof issue.op === 'number' && typeof issue.code === 'string') {
      const op = p.ops[issue.op];
      const field = isRecord(op) && typeof op.field === 'string' ? op.field : '';
      return refused({
        why: 'step',
        step: issue.op + 1,
        text: stepRefusal(issue, field, before, type),
      });
    }
    // The call's own shape (`ops.2.to`): a step the api can't read at all.
    const shape = /^ops\.(\d+)/.exec(issue.field ?? '');
    if (shape) {
      return refused({
        why: 'step',
        step: Number(shape[1]) + 1,
        text: `Coworker wrote this step in a way the api can’t read (${issue.message ?? 'invalid'}).`,
      });
    }
    return refused({
      why: 'invalid',
      where: ruleWhere(issue, before, type),
      message: issue.message ?? 'It isn’t valid',
    });
  }
  const afterFields = checked.fields;
  const after = indexBlocks(type, afterFields);
  const states = statesBefore(type, beforeFields, checked.applied).map((s, i) =>
    i === 0 ? before : indexBlocks(type, s),
  );
  const fields = reviewOf(
    checked.applied,
    states,
    before,
    after,
    beforeFields,
    afterFields,
    locale,
  );
  if (fields.length === 0) return refused({ why: 'nothing' });
  const steps = checked.applied.map((step, i) => {
    const op = p.ops[i];
    return stepText(isRecord(op) ? op.op : undefined, step, states[i], after, type, locale);
  });
  return { status: 'ready', title, steps, fields };
}

// --- the refusal, said ----------------------------------------------------------------

const ASK_AGAIN = 'Choose Not now, then ask again.';

/** `text`, ending in a full stop unless it already ends a sentence. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** Why a refused block patch can't be confirmed, for the hold line Confirm is described by. */
export function refusalHold(refusal: BlockRefusal): string {
  switch (refusal.why) {
    case 'moved':
      return 'You can’t confirm this: the entry changed after it was proposed.';
    case 'step':
      return `You can’t confirm this: step ${refusal.step} doesn’t fit this entry.`;
    case 'invalid':
      return 'You can’t confirm this: the entry wouldn’t be valid after it.';
    case 'locked':
      return 'You can’t confirm this: it changes a field your role can’t change.';
    case 'denied':
      return 'You can’t confirm this: your role can’t change this entry.';
    case 'hidden':
      return 'You can’t confirm this: it changes a field you can’t read.';
    case 'nothing':
      return 'You can’t confirm this: it changes nothing in the draft.';
    case 'unclear':
      return 'You can’t confirm this: it doesn’t say what to change.';
  }
}

const note = (text: string) => <p className="text-muted-foreground text-xs">{text}</p>;

function Refused({ title, children }: { title: string; children: string }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p className="break-words">
          {sentence(children)} {ASK_AGAIN}
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** A block patch that can't be saved as it stands, in words: what is wrong and what to do. */
export function BlockRefused({ refusal }: { refusal: BlockRefusal }) {
  switch (refusal.why) {
    case 'moved':
      return (
        <Refused title="The entry changed after this was proposed">
          {refusal.now === undefined
            ? `This change was made for version ${refusal.expected} of its draft, which has been saved since`
            : `Its draft is at version ${refusal.now}; this change was made for version ${refusal.expected}`}
        </Refused>
      );
    case 'step':
      return (
        <Refused title={`Step ${refusal.step} doesn’t fit this entry`}>{refusal.text}</Refused>
      );
    case 'invalid':
      return (
        <Refused title="The entry wouldn’t be valid after this">
          {`${refusal.where}: ${refusal.message}`}
        </Refused>
      );
    case 'locked':
      return (
        <Refused title={`Your role can’t change ${refusal.field}`}>
          You can read it, but your role makes it read-only, so this change can’t be saved
        </Refused>
      );
    case 'denied':
      return (
        <Refused title="Your role can’t change this entry">
          It can read the entry but not save it, so this change can’t be saved
        </Refused>
      );
    case 'hidden':
      // Counted, never left out: the person's role can't write what it can't read either.
      return (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>
            {refusal.count} {refusal.count === 1 ? 'field' : 'fields'} you can’t read{' '}
            {refusal.count === 1 ? 'is' : 'are'} in this change, so it can’t be saved.
          </AlertDescription>
        </Alert>
      );
    case 'nothing':
      return note('The draft already holds this; the change does nothing.');
    case 'unclear':
      return note(`Coworker didn’t say which entry or what to change. ${ASK_AGAIN}`);
  }
}
