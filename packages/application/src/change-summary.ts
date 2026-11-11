import {
  authorizeContent,
  type FieldDiff,
  holdsScope,
  isRichTextDocument,
  type LinkRef,
  type ListItemDiff,
  type NestedFieldDiff,
  type RichTextBlockDiff,
  richTextToPlainText,
  SCOPES,
  type Scope,
  type TextSegment,
  type ValueDiff,
} from '@contentworker/domain';
import type { AIProvider, ModelTier } from '@contentworker/ports';
import { conforms, generateJson } from './ai-json';
import { nameForModel, UNTRUSTED_CONTENT_GUARD, wrapUntrusted } from './ai-prompt';
import type { AiSource } from './ai-provenance';
import { requireAiCapability } from './ai-settings';
import { aiPrincipal, type EntryAiCaller } from './content-ai';
import type { AppContext } from './context';
import { getEntry } from './entries';
import { sha256Hex } from './token-crypto';
import { diffVersions, type VersionRef, visibleDiff } from './versioning';

/**
 * A change summary: a few sentences on what changed between two versions of an entry, written by a
 * model over the deterministic version diff (`diffVersions`) and nothing else. The model reads the
 * diff as the caller may read it (`visibleDiff`: a field their role denies never reaches it), as
 * compact JSON lines inside the untrusted-content fence, bounded in size. Without a model (AI_MODE
 * mock) the summary is built from the diff by rule and says so (`source: 'heuristic'`).
 */

/** Stable prompt id, for provenance, the call log and the cache key. Bump it with the prompt. */
export const CHANGE_SUMMARY_PROMPT = 'versions.change_summary.v1';

/**
 * How much of the diff the model reads, in characters of the serialized lines (about 3k tokens):
 * a diff past it is cut at a field boundary, and the model is told how many changed fields it
 * doesn't see, and which.
 */
export const CHANGE_SUMMARY_MAX_INPUT_CHARS = 12_000;
/** The longest excerpt of one value (a before or an after) a line carries. */
const EXCERPT_CHARS = 280;
/** The most elements of one list or blocks of one rich-text value a line lists. */
const MAX_ITEMS = 12;
/** How deep a component inside a list inside a component is followed. */
const MAX_DEPTH = 3;

/** The longest summary and highlight kept, and the most highlights. */
export const CHANGE_SUMMARY_LIMITS = { summary: 600, highlight: 200, highlights: 5 } as const;

/**
 * A model-written summary is the same for the same input, so it is kept (KV) for a day: long
 * enough for a review, short enough not to outlive a purged entry by much.
 */
export const CHANGE_SUMMARY_CACHE_TTL_SECONDS = 24 * 3600;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: CHANGE_SUMMARY_LIMITS.summary },
    highlights: {
      type: 'array',
      items: { type: 'string', maxLength: CHANGE_SUMMARY_LIMITS.highlight },
      maxItems: CHANGE_SUMMARY_LIMITS.highlights,
    },
  },
  required: ['summary', 'highlights'],
  additionalProperties: false,
} as const;

interface Answer {
  readonly summary: string;
  readonly highlights: readonly string[];
}

export interface ChangeSummary {
  readonly entryId: string;
  /** The version numbers the references resolved to. */
  readonly from: number;
  readonly to: number;
  /** One to three sentences, plain text (never markup: render it as text). */
  readonly summary: string;
  /** Notable changes, plain text, at most five; empty when the summary says it all. */
  readonly highlights: readonly string[];
  /** `model` when a model wrote it; `heuristic` when it was built from the diff by rule. */
  readonly source: AiSource;
  /** The tier that wrote it; null for the heuristic. */
  readonly tier: ModelTier | null;
  /** Why the heuristic wrote it: `mock`, `no visible changes`, or a bad answer. */
  readonly fallback?: string;
  /** Served from the cache: no model was called for this request. */
  readonly cached: boolean;
  /** The diff was longer than the model reads, so the summary covers part of it. */
  readonly truncated: boolean;
  /** Fields that changed which the caller may read (what the summary covers). */
  readonly changedFields: number;
  /** Fields that changed which the caller may not read: never shown to the model, only counted. */
  readonly hiddenChanges: number;
}

export interface SummarizeChangeOptions {
  readonly ai: AIProvider;
  /** Skip the cached summary and ask the model again (regenerate); the new one replaces it. */
  readonly fresh?: boolean;
}

// ---- the diff as the model reads it ------------------------------------------

/** How much of each value a line carries: the full reading, or the compact one a large field gets. */
interface Limits {
  /** The longest excerpt of one value (a before or an after). */
  readonly excerpt: number;
  /** The most elements of one list, blocks of one rich-text value or edits of one text. */
  readonly items: number;
}
const FULL: Limits = { excerpt: EXCERPT_CHARS, items: MAX_ITEMS };
const COMPACT: Limits = { excerpt: 80, items: 4 };

/** Words of unchanged text carried either side of an edit, so the model reads what it changed. */
const CONTEXT_WORDS = 6;

const clip = (text: string, max = EXCERPT_CHARS) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Any value as one line of text: rich text as its words, never its tree or markup. */
function valueText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (isRichTextDocument(value)) return richTextToPlainText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

const excerpt = (value: unknown, lim: Limits) => clip(oneLine(valueText(value)), lim.excerpt);

interface TextEdit {
  readonly removed?: string;
  readonly added?: string;
  /** The words just before and after the edit, unchanged, its place marked `…`. */
  readonly context?: string;
}

/**
 * A word diff as what was taken out and put in, each with a few unchanged words either side
 * (`context`); the unchanged stretches between edits are elided, so a long text costs its edits,
 * not its length.
 */
function textEdits(segments: readonly TextSegment[], lim: Limits): TextEdit[] {
  const out: TextEdit[] = [];
  let i = 0;
  while (i < segments.length) {
    if (segments[i]?.kind === 'unchanged') {
      i++;
      continue;
    }
    const prev = segments[i - 1];
    let removed = '';
    let added = '';
    while (i < segments.length && segments[i]?.kind !== 'unchanged') {
      const s = segments[i] as TextSegment;
      if (s.kind === 'removed') removed += s.text;
      else added += s.text;
      i++;
    }
    const next = segments[i];
    const lead = prev ? oneLine(prev.text).split(' ').slice(-CONTEXT_WORDS).join(' ') : '';
    const tail = next ? oneLine(next.text).split(' ').slice(0, CONTEXT_WORDS).join(' ') : '';
    out.push({
      ...(removed.trim() ? { removed: clip(oneLine(removed), 160) } : {}),
      ...(added.trim() ? { added: clip(oneLine(added), 160) } : {}),
      ...(lead || tail ? { context: `${lead} … ${tail}`.trim() } : {}),
    });
  }
  return out.slice(0, lim.items);
}

const sideText = (segments: readonly TextSegment[], side: 'removed' | 'added') =>
  segments
    .filter((s) => s.kind === 'unchanged' || s.kind === side)
    .map((s) => s.text)
    .join('');

/** A link by what it points at, never its id: an id read as a value is noise a model may quote. */
const linkText = (l: LinkRef | null) => (l ? `a linked ${l.linkType.toLowerCase()}` : null);

function richTextBlocks(blocks: readonly RichTextBlockDiff[], lim: Limits) {
  const shown = blocks.filter((b) => b.kind !== 'unchanged' || b.moved);
  return {
    blocks: shown.slice(0, lim.items).map((b) => ({
      block: b.beforeNodeType ? `${b.beforeNodeType} → ${b.nodeType}` : b.nodeType,
      kind: b.kind,
      ...(b.moved ? { moved: true } : {}),
      ...(b.formattingChanged ? { formattingOnly: true } : {}),
      ...(b.kind === 'added' ? {} : { before: excerpt(sideText(b.text, 'removed'), lim) }),
      ...(b.kind === 'removed' ? {} : { after: excerpt(sideText(b.text, 'added'), lim) }),
    })),
    ...(shown.length > lim.items ? { moreBlocks: shown.length - lim.items } : {}),
  };
}

function listItems(items: readonly ListItemDiff[], depth: number, lim: Limits) {
  const shown = items.filter((i) => i.kind !== 'unchanged' || i.moved);
  const values = (i: ListItemDiff) =>
    i.link
      ? {}
      : i.kind === 'added'
        ? { after: excerpt(i.after, lim) }
        : i.kind === 'removed'
          ? { before: excerpt(i.before, lim) }
          : {};
  return {
    items: shown.slice(0, lim.items).map((i) => ({
      kind: i.kind,
      ...(i.moved ? { moved: true } : {}),
      ...(i.variant ? { variant: nameForModel(i.variant) } : {}),
      ...(i.link ? { link: linkText(i.link) } : {}),
      ...(i.detail ? describeDetail(i.detail, depth + 1, lim) : values(i)),
    })),
    ...(shown.length > lim.items ? { moreItems: shown.length - lim.items } : {}),
  };
}

function nestedFields(fields: readonly NestedFieldDiff[], depth: number, lim: Limits) {
  return fields
    .filter((f) => f.kind !== 'unchanged')
    .slice(0, lim.items)
    .map((f) => ({
      field: nameForModel(f.name ?? f.field),
      kind: f.kind,
      ...(f.detail ? describeDetail(f.detail, depth + 1, lim) : {}),
    }));
}

/** A change's typed detail as plain, bounded data. */
function describeDetail(detail: ValueDiff, depth: number, lim: Limits): Record<string, unknown> {
  if (depth > MAX_DEPTH) return { nested: true };
  switch (detail.type) {
    case 'text': {
      // A value short enough to read whole is sent whole; a longer one as its edits alone, since
      // its opening words would rarely hold them.
      const before = sideText(detail.segments, 'removed');
      const after = sideText(detail.segments, 'added');
      const whole = Math.max(before.length, after.length) <= lim.excerpt;
      return {
        ...(whole ? { before: oneLine(before), after: oneLine(after) } : {}),
        edits: textEdits(detail.segments, lim),
      };
    }
    case 'value':
      return { before: excerpt(detail.before, lim), after: excerpt(detail.after, lim) };
    case 'link': {
      const swapped = detail.before && detail.after?.linkType === detail.before.linkType;
      return {
        before: linkText(detail.before),
        after: swapped
          ? `another linked ${detail.before?.linkType.toLowerCase()}`
          : linkText(detail.after),
      };
    }
    case 'component':
      return { fields: nestedFields(detail.fields, depth, lim) };
    case 'list':
      return listItems(detail.items, depth, lim);
    case 'richText':
      return richTextBlocks(detail.blocks, lim);
  }
}

/** One changed field as the lines the model reads: one per locale that changed. */
function fieldLines(change: FieldDiff, showLocale: boolean, lim: Limits): string {
  const name = nameForModel(change.name ?? change.field);
  return change.locales
    .filter((l) => l.kind !== 'unchanged')
    .map((l) =>
      JSON.stringify({
        field: name,
        ...(change.fieldType ? { type: change.fieldType } : {}),
        ...(showLocale ? { locale: l.locale } : {}),
        kind: l.kind,
        ...(l.detail ? describeDetail(l.detail, 0, lim) : {}),
      }),
    )
    .join('\n');
}

export interface SerializedDiff {
  /** JSON lines, one per changed field and locale, plus one naming what was left out. */
  readonly text: string;
  /** Changed fields left out for length, by name. */
  readonly omitted: readonly string[];
}

/**
 * The changed fields of a diff as the model reads them: JSON lines (so a value can't pose as a
 * marker or another field), short values whole, text edits as what was removed and added with a
 * few words either side, rich text as each changed block's words, links by kind, never by id.
 * Fields are added whole, in the content type's order; one that doesn't fit what is left of
 * `maxChars` is tried again compact (shorter excerpts, fewer elements), so one large field never
 * empties the input. Once one fits neither way, it and the rest are named in a last line and
 * counted.
 */
export function serializeDiffForModel(
  changes: readonly FieldDiff[],
  maxChars = CHANGE_SUMMARY_MAX_INPUT_CHARS,
): SerializedDiff {
  const changed = changes.filter((c) => c.kind !== 'unchanged');
  const showLocale = new Set(changed.flatMap((c) => c.locales.map((l) => l.locale))).size > 1;
  const lines: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const change of changed) {
    const fits = (block: string) => used + block.length + 1 <= maxChars;
    const block =
      omitted.length > 0
        ? undefined
        : [FULL, COMPACT].map((lim) => fieldLines(change, showLocale, lim)).find(fits);
    if (block === undefined) {
      omitted.push(nameForModel(change.name ?? change.field));
      continue;
    }
    lines.push(block);
    used += block.length + 1;
  }
  if (omitted.length > 0) {
    lines.push(JSON.stringify({ omittedForLength: omitted.length, fields: omitted.slice(0, 50) }));
  }
  return { text: lines.join('\n'), omitted };
}

// ---- the summary by rule -------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Names as a list a person reads: the first eight, then how many more. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 8);
  return names.length > shown.length
    ? `${shown.join(', ')} and ${names.length - shown.length} more`
    : shown.join(', ');
}

/** Field types whose values read whole in a line, before → after. */
const SIMPLE_TYPES: ReadonlySet<string> = new Set([
  'Symbol',
  'Slug',
  'Integer',
  'Number',
  'Boolean',
  'Date',
]);
/** A `Text` value this short reads whole too; a longer one is counted in words. */
const SHORT_TEXT_CHARS = 40;
/** The longest value a highlight shows before it is cut with an ellipsis. */
const SHOWN_VALUE_CHARS = 40;
/** Past this share of a text's words changed, it was rewritten rather than edited. */
const REWRITTEN_SHARE = 0.6;

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** A simple value as a highlight shows it: a switch on or off, text on one line and cut short. */
function shownValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string' || typeof value === 'number') {
    return clip(oneLine(String(value)), SHOWN_VALUE_CHARS);
  }
  return clip(oneLine(JSON.stringify(value) ?? ''), SHOWN_VALUE_CHARS);
}

/** "49 → 59", "set to 59", "cleared": a simple value's change. */
function beforeAfter(before: unknown, after: unknown): string {
  if (isEmpty(before)) return `set to ${shownValue(after)}`;
  if (isEmpty(after)) return 'cleared';
  return `${shownValue(before)} → ${shownValue(after)}`;
}

/** How many words a word diff changed: per edit, the longer of what went and what came. */
function changedWords(segments: readonly TextSegment[]): number {
  let total = 0;
  let removed = 0;
  let added = 0;
  const flush = () => {
    total += Math.max(removed, added);
    removed = 0;
    added = 0;
  };
  for (const s of segments) {
    if (s.kind === 'unchanged') flush();
    else if (s.kind === 'removed') removed += wordCount(s.text);
    else added += wordCount(s.text);
  }
  flush();
  return total;
}

/** "6 words changed", "rewritten", "added, 120 words", "cleared": a longer text's change. */
function wordsChanged(changed: number, before: number, after: number): string {
  if (before === 0) return after === 0 ? 'changed' : `added, ${plural(after, 'word')}`;
  if (after === 0) return 'cleared';
  if (changed >= REWRITTEN_SHARE * Math.max(before, after)) return 'rewritten';
  return changed === 0 ? 'formatting changed' : `${plural(changed, 'word')} changed`;
}

/** A rich-text change in words: the words its blocks changed, or that its blocks only moved. */
function richTextChange(blocks: readonly RichTextBlockDiff[]): string {
  const side = (b: RichTextBlockDiff, which: 'removed' | 'added') =>
    wordCount(sideText(b.text, which));
  const before = blocks.reduce((n, b) => n + (b.kind === 'added' ? 0 : side(b, 'removed')), 0);
  const after = blocks.reduce((n, b) => n + (b.kind === 'removed' ? 0 : side(b, 'added')), 0);
  const changed = blocks.reduce(
    (n, b) =>
      n +
      (b.kind === 'added'
        ? side(b, 'added')
        : b.kind === 'removed'
          ? side(b, 'removed')
          : b.kind === 'changed'
            ? changedWords(b.text)
            : 0),
    0,
  );
  if (changed === 0) {
    const moved = blocks.filter((b) => b.moved).length;
    if (moved > 0) return `${plural(moved, 'block')} moved`;
    if (blocks.some((b) => b.formattingChanged)) return 'formatting changed';
  }
  return wordsChanged(changed, before, after);
}

/** "2 added, 1 removed, 1 moved": a list's elements by what happened to them. */
function listChange(items: readonly ListItemDiff[]): string {
  const count = (pred: (i: ListItemDiff) => boolean) => items.filter(pred).length;
  const parts = [
    [count((i) => i.kind === 'added'), 'added'],
    [count((i) => i.kind === 'removed'), 'removed'],
    [count((i) => i.kind === 'changed'), 'changed'],
    [count((i) => i.kind === 'unchanged' && i.moved === true), 'moved'],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return said.length > 0 ? said.join(', ') : 'changed';
}

/** A link's change, by what happened to it, never what it points at. */
function linkChange(before: LinkRef | null, after: LinkRef | null): string {
  if (!before) return after ? 'set' : 'changed';
  return after ? 'replaced' : 'cleared';
}

/** What one value's change was, in a few words a person reads at a glance. */
function describeChange(
  fieldType: string | undefined,
  before: unknown,
  after: unknown,
  detail: ValueDiff | undefined,
): string {
  const shortText =
    (fieldType === 'Text' || fieldType === undefined) &&
    [before, after].every(
      (v) => isEmpty(v) || (typeof v === 'string' && v.length <= SHORT_TEXT_CHARS),
    );
  if ((fieldType && SIMPLE_TYPES.has(fieldType)) || (detail?.type === 'text' && shortText)) {
    return beforeAfter(before, after);
  }
  switch (detail?.type) {
    case 'text': {
      const was = wordCount(sideText(detail.segments, 'removed'));
      const now = wordCount(sideText(detail.segments, 'added'));
      return wordsChanged(changedWords(detail.segments), was, now);
    }
    case 'richText':
      return richTextChange(detail.blocks);
    case 'list':
      return listChange(detail.items);
    case 'link':
      return linkChange(detail.before, detail.after);
    case 'component': {
      const fields = detail.fields.filter((f) => f.kind !== 'unchanged');
      const names = nameList(fields.map((f) => f.name ?? f.field));
      return fields.length > 0 ? `${names} changed` : 'changed';
    }
    case 'value': {
      const primitive = (v: unknown) =>
        isEmpty(v) || ['string', 'number', 'boolean'].includes(typeof v);
      if (primitive(detail.before) && primitive(detail.after)) {
        return beforeAfter(detail.before, detail.after);
      }
      return isEmpty(detail.after) ? 'cleared' : isEmpty(detail.before) ? 'set' : 'changed';
    }
    default:
      return 'changed';
  }
}

/**
 * The summary a rule writes from the diff: a sentence naming the fields that changed, then a
 * highlight per changed field (and locale, when the entry has several) saying how: a simple value
 * before → after ("Price: 49 → 59", "Featured: off → on", "set to …", "cleared"), a longer text or
 * rich text by the words it changed ("Body: 6 words changed", or "rewritten"), a list by its
 * elements ("Tags: 2 added, 1 removed"), a link by what happened to it ("Hero image: replaced",
 * never an id). Fields the reader can't see are counted, never named. What it says is all in the
 * diff, so it needs no model and no fence.
 */
export function heuristicChangeSummary(
  changes: readonly FieldDiff[],
  hiddenChanges: number,
): Answer {
  const changed = changes.filter((c) => c.kind !== 'unchanged');
  const label = (c: FieldDiff) => c.name ?? c.field;
  const hidden =
    hiddenChanges > 0 ? `${plural(hiddenChanges, 'field')} you can’t read also changed.` : '';
  if (changed.length === 0) {
    return {
      summary:
        hiddenChanges > 0
          ? `${plural(hiddenChanges, 'field')} you can’t read changed.`
          : 'No field changes.',
      highlights: [],
    };
  }
  const summary = [
    `Changed ${plural(changed.length, 'field')}: ${nameList(changed.map(label))}.`,
    hidden,
  ]
    .filter(Boolean)
    .join(' ');
  const showLocale = new Set(changed.flatMap((c) => c.locales.map((l) => l.locale))).size > 1;
  const highlights = changed
    .flatMap((c) =>
      c.locales
        .filter((l) => l.kind !== 'unchanged')
        .map((l) => {
          const where = showLocale ? ` (${l.locale})` : '';
          const how = describeChange(c.fieldType, l.before, l.after, l.detail);
          return clip(`${label(c)}${where}: ${how}`, CHANGE_SUMMARY_LIMITS.highlight);
        }),
    )
    .slice(0, CHANGE_SUMMARY_LIMITS.highlights);
  return { summary, highlights };
}

// ---- the model's answer ----------------------------------------------------------

/**
 * A string the model wrote, as plain text: tag-shaped runs dropped and any angle bracket left over
 * (an unclosed tag), a Markdown link as its words, on one line, capped. The contract is plain text
 * whoever renders it, not only the admin, which renders it as text.
 */
function plainText(text: string, max: number): string {
  return clip(
    text
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/[<>]/g, '')
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}

function cleanAnswer(answer: Answer): Answer {
  return {
    summary: plainText(answer.summary, CHANGE_SUMMARY_LIMITS.summary),
    highlights: answer.highlights
      .map((h) => plainText(h, CHANGE_SUMMARY_LIMITS.highlight))
      .filter(Boolean)
      .slice(0, CHANGE_SUMMARY_LIMITS.highlights),
  };
}

const SYSTEM = [
  'You summarize the changes between two versions of a content entry for an editor reviewing them.',
  'The changes come as JSON lines, one per changed field (and locale), computed by a deterministic diff: ' +
    '`kind` is added, removed or changed; `before` and `after` are the values, or excerpts of them; ' +
    '`edits` are the words removed and added, with `context`, the unchanged words around the edit ' +
    '(… marks where it is); `blocks` are rich-text blocks; `items` are list elements; `moved` means ' +
    'reordered; `formattingOnly` means the words are the same and only formatting changed.',
  'Describe only what the lines show. Never guess why a change was made, never name a field, value ' +
    'or change that is not in them, never quote identifiers, and never judge the content. Excerpts ' +
    'may be cut short (…).',
  'Answer in English with `summary`: one to three plain sentences, about 350 characters, and ' +
    '`highlights`: up to five short notes (about 120 characters each) on the most notable changes, ' +
    'or an empty list when the summary says it all.',
  'Plain text only: no Markdown, HTML, links or quotation of whole values.',
].join('\n');

/**
 * Summarizes the changes between two versions of an entry (see the module comment). `from` and
 * `to` are as `diffVersions` takes them. 404 when the entry or a version doesn't exist, 403 when
 * the caller's role can't read the entry's type, 409 `ai_capability_disabled` when the space turned
 * `field-assist` off, 429 when the space's AI budget refuses the call, 503 when the model fails or
 * times out. A read: nothing is written to D1; a model-written summary is kept in the cache
 * (`ctx.cache`, KV) by a hash of everything the model read, so the same request (the same visible
 * diff, field names, tier and guidance) is answered from it without a call; `fresh` asks again.
 */
export async function summarizeChange(
  ctx: AppContext,
  caller: EntryAiCaller,
  scope: Scope,
  entryId: string,
  from: VersionRef,
  to: VersionRef,
  opts: SummarizeChangeOptions,
): Promise<ChangeSummary> {
  const principal = aiPrincipal(caller);
  const policy = await requireAiCapability(ctx, scope, 'field-assist');
  const { entry } = await getEntry(ctx, scope, entryId);
  if (principal) authorizeContent(principal, 'read', entry.contentTypeApiId);
  const diff = await diffVersions(ctx, scope, entryId, from, to);
  const seen = principal ? visibleDiff(principal, diff) : { ...diff, hiddenChanges: 0 };
  const changed = seen.changes.filter((c) => c.kind !== 'unchanged');
  const base = {
    entryId,
    from: seen.from,
    to: seen.to,
    changedFields: changed.length,
    hiddenChanges: seen.hiddenChanges,
  };
  const byRule = (fallback: string, truncated = false): ChangeSummary => ({
    ...base,
    ...heuristicChangeSummary(seen.changes, seen.hiddenChanges),
    source: 'heuristic',
    tier: null,
    fallback,
    cached: false,
    truncated,
  });
  // Nothing the caller may read changed: there is nothing for a model to say.
  if (changed.length === 0) return byRule('no visible changes');

  const serialized = serializeDiffForModel(seen.changes);
  const truncated = serialized.omitted.length > 0;
  const contentType = await ctx.store.contentTypes.get(scope, entry.contentTypeApiId);
  // The type's name is author text too: it goes inside the fence, as the first line.
  const typeLine = JSON.stringify({
    entryType: nameForModel(contentType?.name ?? entry.contentTypeApiId),
  });
  const prompt = [
    `Changes to an entry, from version ${seen.from} to version ${seen.to} (the first line names its type):`,
    wrapUntrusted(`${typeLine}\n${serialized.text}`),
    truncated
      ? `The list was cut short for length: ${plural(serialized.omitted.length, 'more changed field')} ` +
        'are named in its last line but not shown. Say that the summary covers only some of the changes.'
      : '',
    // Counted, never shown: the model is only told not to call what it sees all that changed.
    seen.hiddenChanges > 0
      ? 'Other fields changed that you are not shown: never say these are the only changes.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const system = policy.system(`${SYSTEM}\n${UNTRUSTED_CONTENT_GUARD}`);
  const tier = policy.tier('fast');
  const key = cacheKey([
    CHANGE_SUMMARY_PROMPT,
    scope.spaceId,
    scope.environmentId,
    entryId,
    tier,
    system,
    prompt,
  ]);

  // Asking past the cache is for someone who could edit the entry: a read-only caller (a preview
  // key in a frontend's build) gets one model call per distinct diff at most, so it can't drain
  // the space's AI budget, which every editor shares, by asking again in a loop.
  const fresh =
    opts.fresh === true && (!principal || holdsScope(principal.scopes, SCOPES.contentWrite));
  if (ctx.ai?.mode !== 'mock' && !fresh) {
    const hit = await readCached(ctx, key);
    if (hit) {
      return { ...base, ...hit.answer, source: 'model', tier: hit.tier, cached: true, truncated };
    }
  }

  const fallback = heuristicChangeSummary(seen.changes, seen.hiddenChanges);
  const res = await generateJson<Answer>(
    ctx,
    opts.ai,
    scope,
    {
      system,
      prompt,
      tier,
      // Room for the answer (up to ~1 600 characters) and for a reasoning model's thinking, which
      // counts against the cap: cut short, the adapter calls the answer bad.
      maxTokens: 1500,
      outputSchema: SCHEMA as unknown as Record<string, unknown>,
    },
    { prompt: CHANGE_SUMMARY_PROMPT, fallback: () => fallback, policy, failures: 'throw' },
  );
  if (res.source === 'heuristic') return byRule(res.fallback ?? 'heuristic', truncated);
  const answer = cleanAnswer(res.value);
  if (!answer.summary) return byRule('empty summary', truncated);
  await ctx.cache
    ?.set(key, JSON.stringify({ ...answer, tier: res.tier }), {
      ttlSeconds: CHANGE_SUMMARY_CACHE_TTL_SECONDS,
    })
    // A summary not kept is asked for again next time; the answer in hand still stands.
    .catch(() => {});
  return { ...base, ...answer, source: 'model', tier: res.tier, cached: false, truncated };
}

const cacheKey = (parts: readonly string[]) => `change-summary:${sha256Hex(JSON.stringify(parts))}`;

const CACHED_SCHEMA = {
  type: 'object',
  properties: {
    ...SCHEMA.properties,
    tier: { type: 'string', enum: ['flagship', 'balanced', 'fast'] },
  },
  required: ['summary', 'highlights', 'tier'],
};

async function readCached(
  ctx: AppContext,
  key: string,
): Promise<{ answer: Answer; tier: ModelTier } | null> {
  const raw = await ctx.cache?.get(key).catch(() => null);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!conforms(value, CACHED_SCHEMA)) return null;
    const { summary, highlights, tier } = value as Answer & { tier: ModelTier };
    return { answer: cleanAnswer({ summary, highlights }), tier };
  } catch {
    return null;
  }
}
