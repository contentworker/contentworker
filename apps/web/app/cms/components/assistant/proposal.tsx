/**
 * What a change the model proposed would do, read from the system before the person confirms it:
 * a draft save as the field diff from what the draft holds now (`diffEntryFields`, the domain's
 * own diff), a new entry by its fields, a batch by the entries it names, a tagging by its tags'
 * names, a release by its title, a block patch as the field diff its dry run answers (the api's
 * own checks, `checkEntryBlocks`, nothing written). The proposal's input is the
 * exact call that runs on Confirm, so it is what is shown; anything a model wrote around it (its
 * prose) never reaches here.
 */

import {
  type BlockOp,
  type BlockOutline,
  blockVariants,
  type ContentType,
  diffEntryFields,
  type EntryFields,
  outlineBlocks,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Collapsible, CollapsibleContent } from '@contentworker/ui/collapsible';
import { getToolName } from 'ai';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ApiError, type ManagementClient } from '../../lib/management';
import { entryRef, fetchEntriesById } from '../dashboard/entry-titles';
import {
  ChangedFields,
  changedCount,
  FieldReview,
  ReviewFailed,
  type ReviewField,
  reviewFields,
} from '../entries/EntryReview';
import type { Part } from './parts';

/** What a proposal is, as far as reviewing it goes. */
export type Proposal =
  | { readonly kind: 'save'; readonly entryId: string; readonly fields: EntryFields }
  | { readonly kind: 'create'; readonly contentType: string; readonly fields: EntryFields }
  | { readonly kind: 'entries'; readonly ids: readonly string[] }
  | { readonly kind: 'entry'; readonly entryId: string }
  | {
      readonly kind: 'tags';
      readonly entryId: string;
      readonly tagIds: readonly string[];
      readonly newTags: readonly string[];
      /** The tags become exactly these (`entries_set_metadata`), rather than being added. */
      readonly replace: boolean;
      readonly concepts: number;
    }
  | {
      readonly kind: 'release';
      readonly releaseId: string;
      readonly entryId: string;
      readonly unpublish: boolean;
    }
  | {
      readonly kind: 'blocks';
      /** Empty, or the version missing, when the call doesn't say: the card then can't confirm. */
      readonly entryId: string;
      readonly expectedVersion?: number;
      readonly ops: readonly unknown[];
    };

/** Why a block patch can't be confirmed as it stands, as its dry run answered. */
export type BlockRefusal =
  /** The draft moved past the version the patch was made for: the save would be refused. */
  | { readonly why: 'moved'; readonly now?: number; readonly expected: number }
  /** A step doesn't apply to the draft: the domain's own words, blocks named as a person reads them. */
  | { readonly why: 'step'; readonly step: number; readonly message: string }
  /** The result breaks a rule of the content model, as a save would find it. */
  | { readonly why: 'invalid'; readonly where: string; readonly message: string }
  /** It edits fields this person can't read, which their role can't write either. */
  | { readonly why: 'hidden'; readonly count: number }
  /** It edits a field this person can read but whose role makes it read-only. */
  | { readonly why: 'locked'; readonly field: string }
  | { readonly why: 'nothing' }
  /** The call doesn't say which entry, at which version, or what to change. */
  | { readonly why: 'unclear' };

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const isFields = (v: unknown): v is EntryFields =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tools whose single entry a card names by reading it (the publish card reads its own). */
const ONE_ENTRY = new Set([
  'entries_unpublish',
  'entries_trash',
  'entries_purge',
  'entries_restore',
  'entries_duplicate',
  'entries_restore_version',
  'schedule_action',
  'comments_add',
]);

/** What there is to review in a call, or null when it names nothing that can be read. */
export function proposalOf(part: Part): Proposal | null {
  const name = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'entries_update': {
      const entryId = str(input.id);
      return entryId && isFields(input.fields)
        ? { kind: 'save', entryId, fields: input.fields }
        : null;
    }
    case 'entries_create': {
      const contentType = str(input.contentType);
      return contentType && isFields(input.fields)
        ? { kind: 'create', contentType, fields: input.fields }
        : null;
    }
    case 'bulk_job_start':
    case 'entries_bulk_action': {
      const ids = strings(input.entryIds ?? input.ids);
      return ids.length ? { kind: 'entries', ids } : null;
    }
    case 'entries_set_metadata':
    case 'entry_apply_tags': {
      const entryId = str(input.entryId ?? input.id);
      if (!entryId) return null;
      const replace = name === 'entries_set_metadata';
      return {
        kind: 'tags',
        entryId,
        tagIds: strings(replace ? input.tags : input.tagIds),
        newTags: strings(input.newTags),
        replace,
        concepts: strings(input.concepts).length,
      };
    }
    case 'entry_blocks_patch': {
      // Always a proposal, however malformed: a card that can't show what changes stays held.
      const version = input.expectedVersion;
      return {
        kind: 'blocks',
        entryId: str(input.id) ?? '',
        ...(typeof version === 'number' ? { expectedVersion: version } : {}),
        ops: Array.isArray(input.ops) ? input.ops : [],
      };
    }
    case 'releases_add_entry': {
      const releaseId = str(input.releaseId);
      const entryId = str(input.entryId);
      return releaseId && entryId
        ? { kind: 'release', releaseId, entryId, unpublish: input.action === 'unpublish' }
        : null;
    }
    default: {
      const entryId = ONE_ENTRY.has(name) ? str(input.id ?? input.entryId) : undefined;
      return entryId ? { kind: 'entry', entryId } : null;
    }
  }
}

/** A batch names this many of its entries; the rest are counted. */
export const NAMED_MAX = 5;

export type ProposalReview =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly retry?: () => void }
  | {
      readonly status: 'ready';
      /** The entry the call is about, by its title. */
      readonly title?: string;
      /** A save's or a new entry's fields, as a person reads them. */
      readonly fields?: readonly ReviewField[];
      /** A batch's first entries by title, and how many more it holds. */
      readonly entries?: { readonly titles: readonly string[]; readonly more: number };
      readonly tags?: { readonly names: readonly string[]; readonly created: readonly string[] };
      readonly release?: string;
      /** A block patch's steps, in order, each naming its blocks by type and label. */
      readonly steps?: readonly string[];
    }
  /** Read, and it can't be confirmed as it stands: the card says why, and Confirm stays off. */
  | { readonly status: 'refused'; readonly title?: string; readonly refusal: BlockRefusal };

type Ready = Extract<ProposalReview, { status: 'ready' }>;
type Read = Ready | Extract<ProposalReview, { status: 'refused' }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One field's tree in one locale: keys are unique only there (a copied locale keeps them). */
const treeOf = (field: string, locale: string) => `${field}\u0000${locale}`;

/**
 * Every block an outline holds, by tree and key: "Hero “Spring launch”", or its type's name
 * alone. A key already named (from the draft as it is) keeps its name.
 */
function blockNames(
  outline: Readonly<Record<string, Readonly<Record<string, readonly BlockOutline[]>>>>,
  into = new Map<string, Map<string, string>>(),
): Map<string, Map<string, string>> {
  for (const [field, byLocale] of Object.entries(outline))
    for (const [locale, nodes] of Object.entries(byLocale)) {
      const tree = into.get(treeOf(field, locale)) ?? new Map<string, string>();
      into.set(treeOf(field, locale), tree);
      const walk = (list: readonly BlockOutline[]) => {
        for (const n of list) {
          if (n.key !== null && !tree.has(n.key))
            tree.set(n.key, n.label ? `${n.name} “${n.label}”` : n.name);
          for (const kids of Object.values(n.children ?? {})) walk(kids);
        }
      };
      walk(nodes);
    }
  return into;
}

/**
 * The domain's words with the block it names put the way a person reads it. Only the forms where
 * a key stands for an existing block are named; one that is a new block's own key is said so.
 */
function named(message: string, names: ReadonlyMap<string, string>, type: ContentType): string {
  let out = message;
  const held = /^_key "([^"]+)" is already held by a block in (.+)$/.exec(out);
  if (held?.[1] && names.has(held[1]))
    out = `The new block’s _key is already ${names.get(held[1])}’s, in ${held[2]}`;
  // `Block "k" sits in…`, `"items" of block "k"…`: there the key is that existing block.
  for (const [key, name] of names)
    out = out.replaceAll(`Block "${key}"`, name).replaceAll(`block "${key}"`, name);
  for (const f of type.fields) out = out.replaceAll(`in ${f.apiId} (`, `in ${f.name} (`);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** One applied step in words, its blocks named from their tree; its locale added when not `shown`. */
function stepText(
  op: Record<string, unknown>,
  applied: BlockOp,
  names: ReadonlyMap<string, ReadonlyMap<string, string>>,
  type: ContentType,
  shown: string,
): string {
  const tree = names.get(treeOf(applied.field, applied.locale));
  const name = (key: unknown) => (typeof key === 'string' && tree?.get(key)) || 'a block';
  const field = type.fields.find((f) => f.apiId === applied.field)?.name ?? applied.field;
  const where = (parent?: { readonly key: string }) => (parent ? name(parent.key) : field);
  let text: string;
  if (op.op === 'duplicate' && applied.op === 'insert')
    text = `Duplicates ${name(applied.block._key)} in ${where(applied.parent)}`;
  else if (applied.op === 'insert')
    text = `Adds ${name(applied.block._key)} to ${where(applied.parent)}`;
  else if (applied.op === 'update') text = `Changes ${name(applied.key)}`;
  else if (applied.op === 'move')
    text = `Moves ${name(applied.key)} ${applied.to.parent ? 'into' : 'in'} ${where(applied.to.parent)}`;
  else text = `Removes ${name(applied.key)}`;
  return applied.locale === shown ? text : `${text} (${applied.locale})`;
}

/** The api's 422 issues, as its body carries them. */
const issuesOf = (err: ApiError) =>
  ((err.body as { error?: { issues?: unknown } } | undefined)?.error?.issues ?? []) as {
    readonly op?: number;
    readonly field?: string;
    readonly locale?: string;
    readonly message?: string;
  }[];

/**
 * What a block patch would make of the draft, from its dry run: the api's own checks (the version,
 * the role's fields, the locales, the ops, the content model) with nothing written. What would
 * refuse the save on Confirm is said instead, in words; any other failure is a failed read.
 */
async function readBlockPatch(
  client: ManagementClient,
  p: Extract<Proposal, { kind: 'blocks' }>,
  types: readonly ContentType[],
  locale: string,
): Promise<Read> {
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
  const refused = (refusal: BlockRefusal): Read => ({ status: 'refused', title, refusal });
  // A blocks field missing from the outline is one this person can't read, not an empty one.
  const hidden = new Set(
    p.ops.flatMap((op) => {
      const f = isRecord(op) ? type.fields.find((d) => d.apiId === op.field) : undefined;
      return f && blockVariants(f) && !(f.apiId in outline.fields) ? [f.apiId] : [];
    }),
  );
  if (hidden.size > 0) return refused({ why: 'hidden', count: hidden.size });

  const before = entry.fields as EntryFields;
  const names = blockNames(outlineBlocks(type, before));
  let checked: Awaited<ReturnType<ManagementClient['checkBlockPatch']>>;
  try {
    checked = await client.checkBlockPatch(p.entryId, { expectedVersion, ops: p.ops });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 409) {
      const details = (err.body as { error?: { details?: { currentVersion?: unknown } } })?.error
        ?.details;
      const now = typeof details?.currentVersion === 'number' ? details.currentVersion : undefined;
      return refused({ why: 'moved', expected: expectedVersion, ...(now ? { now } : {}) });
    }
    if (err.status === 403) {
      const apiId = /content:write:[^."]+\.([A-Za-z][\w]*)/.exec(err.message)?.[1];
      const field = type.fields.find((f) => f.apiId === apiId)?.name;
      if (field) return refused({ why: 'locked', field });
      throw err;
    }
    if (err.status !== 422) throw err;
    const issue = issuesOf(err)[0];
    if (!issue) throw err;
    // The request's own shape (`ops.2.to`), the patch's (`op`), or the result's (`body[1].label`).
    const shape = /^ops\.(\d+)/.exec(issue.field ?? '');
    const at = typeof issue.op === 'number' ? issue.op : shape ? Number(shape[1]) : undefined;
    const message = issue.message ?? 'It doesn’t apply to this entry';
    if (at !== undefined) {
      const op = p.ops[at];
      const tree =
        names.get(treeOf(isRecord(op) ? String(op.field) : '', issue.locale ?? '')) ?? new Map();
      return refused({ why: 'step', step: at + 1, message: named(message, tree, type) });
    }
    const top = /^[A-Za-z]\w*/.exec(issue.field ?? '')?.[0];
    const fieldName = type.fields.find((f) => f.apiId === top)?.name;
    const where =
      fieldName && top ? (issue.field ?? '').replace(top, fieldName) : (issue.field ?? '');
    return refused({ why: 'invalid', where, message });
  }
  blockNames(outlineBlocks(type, checked.fields), names);
  const changes = diffEntryFields(before, checked.fields, type, { structureOnly: true });
  const fields = reviewFields(changes, locale);
  if (changedCount(fields) === 0) return refused({ why: 'nothing' });
  const steps = checked.applied.map((step, i) => {
    const op = p.ops[i];
    return stepText(isRecord(op) ? op : {}, step, names, type, locale);
  });
  return { status: 'ready', title, fields, steps };
}

async function readProposal(client: ManagementClient, p: Proposal, locale: string): Promise<Read> {
  const types = await client.listContentTypes();
  const titleOf = async (id: string) => {
    const entry = await client.getEntry(id);
    return { entry, title: entryRef(entry, types, locale).title };
  };
  switch (p.kind) {
    case 'save': {
      // A save writes the whole new version: a field it leaves out is gone from the draft.
      const { entry, title } = await titleOf(p.entryId);
      const type = types.find((t) => t.apiId === entry.contentType);
      const changes = diffEntryFields(entry.fields as EntryFields, p.fields, type, {
        structureOnly: true,
      });
      return { status: 'ready', title, fields: reviewFields(changes, locale) };
    }
    case 'create': {
      const type: ContentType | undefined = types.find((t) => t.apiId === p.contentType);
      const changes = diffEntryFields({}, p.fields, type, { structureOnly: true });
      const named = type?.displayField ? p.fields[type.displayField] : undefined;
      const title =
        named && typeof named === 'object'
          ? (str((named as Record<string, unknown>)[locale]) ??
            Object.values(named).map(str).find(Boolean))
          : undefined;
      return {
        status: 'ready',
        ...(title ? { title } : {}),
        fields: reviewFields(changes, locale),
      };
    }
    case 'entries': {
      const shown = p.ids.slice(0, NAMED_MAX);
      const found = await fetchEntriesById(client, shown);
      const byId = new Map(found.map((e) => [e.id, entryRef(e, types, locale).title]));
      // One that can't be read (gone, or not this person's to read) is still counted.
      const titles = shown.flatMap((id) => {
        const t = byId.get(id);
        return t ? [t] : [];
      });
      return { status: 'ready', entries: { titles, more: p.ids.length - titles.length } };
    }
    case 'entry':
      return { status: 'ready', title: (await titleOf(p.entryId)).title };
    case 'tags': {
      const [{ title }, tags] = await Promise.all([titleOf(p.entryId), client.listTags()]);
      const byId = new Map(tags.map((t) => [t.id, t.name]));
      return {
        status: 'ready',
        title,
        tags: {
          names: p.tagIds.map((id) => byId.get(id) ?? 'A tag you can’t see'),
          created: p.newTags,
        },
      };
    }
    case 'release': {
      const [{ title }, release] = await Promise.all([
        titleOf(p.entryId),
        client.getRelease(p.releaseId),
      ]);
      return { status: 'ready', title, release: release.release.title };
    }
    case 'blocks':
      return readBlockPatch(client, p, types, locale);
  }
}

const LOADING: ProposalReview = { status: 'loading' };
const IDLE: ProposalReview = { status: 'idle' };

/** Reads what `proposal` would do; a read only, and with no proposal nothing at all. */
export function useProposalReview(
  client: ManagementClient | undefined,
  proposal: Proposal | null,
  locale: string,
): ProposalReview {
  const [review, setReview] = useState(LOADING);
  const [attempt, setAttempt] = useState(0);
  // The proposal is a fresh object each render; its content is what identifies it.
  const key = proposal ? JSON.stringify(proposal) : null;
  useEffect(() => {
    setReview(LOADING);
    if (!key || !client) return;
    let live = true;
    readProposal(client, JSON.parse(key) as Proposal, locale).then(
      (r) => {
        if (live) setReview(r);
      },
      () => {
        if (live) setReview({ status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, key, locale, attempt]);
  if (!proposal) return IDLE;
  return review.status === 'failed'
    ? { status: 'failed', retry: () => setAttempt((n) => n + 1) }
    : review;
}

const note = (text: string) => <p className="text-muted-foreground text-xs">{text}</p>;

const ASK_AGAIN = 'Choose Not now, then ask again.';

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
    case 'hidden':
      return 'You can’t confirm this: it changes a field you can’t read.';
    case 'nothing':
      return 'You can’t confirm this: it changes nothing in the draft.';
    case 'unclear':
      return 'You can’t confirm this: it doesn’t say what to change.';
  }
}

/** A block patch that can't be saved as it stands, in words: what is wrong and what to do. */
function BlockRefused({ refusal }: { refusal: BlockRefusal }) {
  switch (refusal.why) {
    case 'moved':
      return (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The entry changed after this was proposed</AlertTitle>
          <AlertDescription>
            <p>
              {refusal.now === undefined
                ? `This change was made for version ${refusal.expected} of its draft, which has been saved since.`
                : `Its draft is at version ${refusal.now}; this change was made for version ${refusal.expected}.`}{' '}
              {ASK_AGAIN}
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'step':
      return (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Step {refusal.step} doesn’t fit this entry</AlertTitle>
          <AlertDescription>
            <p className="break-words">
              {refusal.message}. {ASK_AGAIN}
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'invalid':
      return (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The entry wouldn’t be valid after this</AlertTitle>
          <AlertDescription>
            <p className="break-words">
              {refusal.where}: {refusal.message}. {ASK_AGAIN}
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'locked':
      return (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Your role can’t change {refusal.field}</AlertTitle>
          <AlertDescription>
            <p>
              You can read it, but your role makes it read-only, so this change can’t be saved.{' '}
              {ASK_AGAIN}
            </p>
          </AlertDescription>
        </Alert>
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

const fieldsChange = (n: number, create: boolean) =>
  create
    ? `${n} ${n === 1 ? 'field' : 'fields'}:`
    : `${n} ${n === 1 ? 'field changes' : 'fields change'} in the draft:`;

/**
 * What a model's proposal would do, for its card: the system's reading of the call that runs on
 * Confirm. Each way it can't say that says what would let the person confirm.
 */
export function ProposalDetail({
  proposal,
  review,
  place,
  onRetry,
}: {
  proposal: Proposal;
  review: ProposalReview;
  place?: 'elsewhere' | 'unknown' | undefined;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (place === 'unknown')
    return note(
      'Coworker can’t tell where this runs, so it can’t show what changes. Choose Not now, then ask again.',
    );
  if (place === 'elsewhere')
    return note(
      'This was asked in another space or environment. Switch back to see what changes and confirm.',
    );
  if (review.status === 'loading')
    return <div className="min-h-12">{note('Reading what this changes…')}</div>;
  if (review.status === 'failed')
    return <ReviewFailed onRetry={onRetry} next="Try again to see what changes and confirm." />;
  if (review.status === 'refused') return <BlockRefused refusal={review.refusal} />;
  if (review.status !== 'ready') return null;

  if (review.entries) {
    const { titles, more } = review.entries;
    return (
      <ul aria-label="Entries" className="space-y-0.5 text-ui">
        {titles.map((t, i) => (
          // Titles needn't be unique; their order is the call's.
          <li key={`${i}:${t}`} className="truncate">
            {t}
          </li>
        ))}
        {more > 0 ? (
          <li className="text-muted-foreground text-xs">
            {titles.length ? `and ${more} more` : `${more} ${more === 1 ? 'entry' : 'entries'}`}
          </li>
        ) : null}
      </ul>
    );
  }
  if (review.tags) {
    const { names, created } = review.tags;
    const replace = proposal.kind === 'tags' && proposal.replace;
    const concepts = proposal.kind === 'tags' ? proposal.concepts : 0;
    return (
      <div className="space-y-1 text-ui">
        {names.length || replace ? (
          <p>
            <span className="text-muted-foreground">{replace ? 'Tags become: ' : 'Adds: '}</span>
            {names.length ? names.join(', ') : 'no tags'}
          </p>
        ) : null}
        {created.length ? (
          <p>
            <span className="text-muted-foreground">New tags: </span>
            {created.join(', ')}
          </p>
        ) : null}
        {concepts ? note(`And ${concepts} ${concepts === 1 ? 'concept' : 'concepts'}.`) : null}
      </div>
    );
  }
  if (review.release !== undefined) {
    const unpublish = proposal.kind === 'release' && proposal.unpublish;
    return (
      <p className="text-ui">
        <span className="text-muted-foreground">
          {unpublish ? 'Unpublishes with ' : 'Publishes with '}
        </span>
        {review.release}
      </p>
    );
  }
  if (review.fields) {
    const create = proposal.kind === 'create';
    const n = changedCount(review.fields);
    if (n === 0) return note('The draft already holds these values; saving changes nothing.');
    return (
      <Collapsible open={open} onOpenChange={setOpen} className="space-y-1">
        {review.steps?.length ? (
          <ol aria-label="Steps" className="list-decimal space-y-0.5 ps-5 text-ui">
            {review.steps.map((s, i) => (
              // Steps needn't be unique; their order is the call's.
              <li key={`${i}:${s}`} className="break-words">
                {s}
              </li>
            ))}
          </ol>
        ) : null}
        {note(fieldsChange(n, create))}
        <ChangedFields fields={review.fields} />
        <Button
          variant="link"
          size="xs"
          className="px-0"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide changes' : 'Review changes'}
        </Button>
        <CollapsibleContent id={id}>
          <FieldReview
            fields={create ? review.fields.filter((f) => f.kind !== 'unchanged') : review.fields}
            labels={create ? { after: 'Value' } : { before: 'Now', after: 'After saving' }}
          />
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return null;
}
