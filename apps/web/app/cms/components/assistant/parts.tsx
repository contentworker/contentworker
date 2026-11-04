/**
 * How the assistant's messages read: prose; each read as a quiet line (what it is doing while the
 * reply streams, then that it's done); each edit as a line in the words of what happened, linking
 * to the entry it changed; and anything waiting for the person as a confirm card. A declined card
 * is neutral (the person chose it), never a failure.
 */

import { ASSISTANT_TOOLS, isAssistantTool } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@contentworker/ui/card';
import { Collapsible, CollapsibleContent } from '@contentworker/ui/collapsible';
import { ComposeLoader } from '@contentworker/ui/compose-loader';
import { cn } from '@contentworker/ui/lib/utils';
import { type DynamicToolUIPart, getToolName, type ToolUIPart } from 'ai';
import {
  ArrowUpRight,
  Ban,
  Check,
  CircleAlert,
  Copy,
  type LucideIcon,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Confirmation, ConfirmationActions } from '~/components/ai-elements/confirmation';
import { MessageAction, MessageResponse } from '~/components/ai-elements/message';
import { useAssistantIfAny } from '../../lib/assistant';
import { metaOf } from '../../lib/assistant-client';
import { useClient } from '../../lib/client-context';
import type { Connection } from '../../lib/management';
import {
  ChangedFields,
  type EntryReview,
  FIRST_PUBLISH,
  FieldReview,
  fieldsGoLive,
  HiddenChanges,
  NO_CHANGES,
  ReviewFailed,
  type ReviewTarget,
  useEntryReview,
} from '../entries/EntryReview';

export type Part = ToolUIPart | DynamicToolUIPart;

// ── Prose ──────────────────────────────────────────────────────────────────

/** Markdown from the model. Links inside the admin navigate in place; the panel stays open. */
export function Prose({ text, streaming }: { text: string; streaming?: boolean }) {
  const navigate = useNavigate();
  return (
    <MessageResponse
      className="cw-prose"
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      controls={false}
      components={{
        a: ({ href, children }) => {
          const internal =
            typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
          return internal ? (
            <a
              href={href}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(href);
              }}
            >
              {children}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </MessageResponse>
  );
}

// ── Lines ──────────────────────────────────────────────────────────────────

/** A tool's title, from the assistant's own list; an unknown tool by its name. */
export const toolTitle = (name: string) =>
  isAssistantTool(name) ? ASSISTANT_TOOLS[name].title : name;

/** Whether a tool changes something (its settled call reads as an edit line, not a read). */
export const isWrite = (name: string) => isAssistantTool(name) && ASSISTANT_TOOLS[name].write;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The editor of the entry an edit changed, when its output names one: an entry (`id` and
 * `contentTypeApiId`, as publish returns), or a view of one (`entry`, as save and duplicate do).
 */
export function entryHref(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  const e = (o.entry && typeof o.entry === 'object' ? o.entry : o) as Record<string, unknown>;
  const id = str(e.id);
  const type = str(e.contentTypeApiId);
  return id && type ? `/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}` : null;
}

const entriesCount = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

/** What a bulk job does, as a person would say it: `bulk_job_start`'s `action` over `entryIds`. */
const BULK_JOB_ABOUT: Record<string, (n: string) => string> = {
  publish: (n) => `Publish ${n}`,
  unpublish: (n) => `Unpublish ${n}`,
  trash: (n) => `Move ${n} to the trash`,
  restore: (n) => `Restore ${n} from the trash`,
  purge: (n) => `Permanently delete ${n}`,
};

/** A bulk job's action, when the call is one. */
function bulkJobAction(part: Part): string | undefined {
  if (getToolName(part) !== 'bulk_job_start') return undefined;
  const action = (part.input as { action?: unknown } | undefined)?.action;
  return typeof action === 'string' ? action : undefined;
}

/**
 * What a card or line is about when the page didn't say: how many entries, for a batch, and for a
 * bulk job what it does to them, so a model's proposal to delete 500 entries says so.
 */
export function aboutOf(part: Part): string | undefined {
  const about = metaOf(part).about;
  if (about) return about;
  const input = part.input as { ids?: unknown; entryIds?: unknown } | undefined;
  const action = bulkJobAction(part);
  if (action !== undefined && Array.isArray(input?.entryIds)) {
    const n = entriesCount(input.entryIds.length);
    return BULK_JOB_ABOUT[action]?.(n) ?? `${action}: ${n}`;
  }
  if (Array.isArray(input?.ids)) return entriesCount(input.ids.length);
  return undefined;
}

function Line({
  icon: Icon,
  tone = 'muted',
  href,
  children,
}: {
  icon: LucideIcon;
  tone?: 'muted' | 'ink' | 'bad' | 'running';
  href?: string | null;
  children: React.ReactNode;
}) {
  const line = (
    <span
      className={cn(
        'flex min-w-0 items-start gap-2 text-ui leading-snug',
        tone === 'ink' && 'font-medium text-foreground',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'running' && 'text-muted-foreground',
        tone === 'bad' && 'text-bad',
      )}
    >
      {/* A tool still running shows the model at work in place of its icon. */}
      {tone === 'running' ? (
        <ComposeLoader className="mt-0.5 size-3.5 text-ai" />
      ) : (
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0">
        {children}
        {tone === 'running' ? <span className="sr-only"> (running)</span> : null}
      </span>
    </span>
  );
  return href ? (
    <Link to={href} className="hit-area w-fit hover:underline">
      {line}
    </Link>
  ) : (
    line
  );
}

/**
 * A tool the assistant read with: what it is doing while the turn streams, then that it did. A read
 * that failed, or that the reply left unfinished, says so in `bad`, with why.
 */
export function ReadLine({ part, streaming }: { part: Part; streaming: boolean }) {
  const title = toolTitle(getToolName(part));
  const unfinished = part.state === 'input-streaming' || part.state === 'input-available';
  if (unfinished && streaming)
    return (
      <Line icon={Search} tone="running">
        {title}
      </Line>
    );
  if (unfinished || part.state === 'output-error')
    return (
      <Line icon={CircleAlert} tone="bad">
        {title} {unfinished ? 'stopped' : 'failed'}
        {part.state === 'output-error' && part.errorText ? (
          <span className="block text-muted-foreground text-xs">{part.errorText}</span>
        ) : null}
      </Line>
    );
  return <Line icon={Search}>{title}</Line>;
}

/**
 * An edit, settled: "Published · Spring launch notes", linking to the entry when its output names
 * one. A declined card stays as it was ("left as it was"); a failed one says why.
 */
export function EditLine({ part }: { part: Part }) {
  const name = getToolName(part);
  const about = aboutOf(part);
  const info = isAssistantTool(name) ? ASSISTANT_TOOLS[name] : null;
  const declined =
    part.state === 'output-denied' ||
    (part.state === 'approval-responded' && part.approval?.approved === false);
  if (declined)
    return (
      <Line icon={Ban}>
        {info?.title ?? name}
        {about ? ` · ${about}` : ''}: left as it was
      </Line>
    );
  if (part.state === 'output-error')
    return (
      <Line icon={CircleAlert} tone="bad">
        {info?.title ?? name} didn’t go through{about ? ` · ${about}` : ''}
        {part.errorText ? (
          <span className="block text-muted-foreground text-xs">{part.errorText}</span>
        ) : null}
      </Line>
    );
  if (part.state === 'output-available')
    return (
      <Line icon={ArrowUpRight} tone="ink" href={entryHref(part.output)}>
        {info?.done ?? name}
        {about ? (
          <>
            {' '}
            <span className="font-normal text-muted-foreground">· {about}</span>
          </>
        ) : null}
      </Line>
    );
  // Confirmed and running, or the model still writing its input.
  return (
    <Line icon={ArrowUpRight} tone="running">
      {info?.title ?? name}
      {about ? ` · ${about}` : ''}
    </Line>
  );
}

// ── Cards ──────────────────────────────────────────────────────────────────

/** Actions that remove something from the delivery API or for good: their confirm is `destructive`. */
const DESTRUCTIVE = new Set(['entries_trash', 'entries_purge', 'entries_unpublish']);
/** The bulk job actions that do the same to many entries at once. */
const DESTRUCTIVE_JOBS = new Set(['trash', 'purge', 'unpublish']);

export function isDestructive(part: Part): boolean {
  const action = bulkJobAction(part);
  return action !== undefined ? DESTRUCTIVE_JOBS.has(action) : DESTRUCTIVE.has(getToolName(part));
}

/** Where a turn's calls run, as the agent stamps it on the model's reply. */
export interface TurnScope {
  readonly spaceId?: unknown;
  readonly environmentId?: unknown;
}

/**
 * Where a publish card's review reads from; `elsewhere`, when that isn't where the card runs. A page's
 * card says where in its input. A model's input says nothing that counts: its turn's scope does.
 */
function publishTarget(
  part: Part,
  conn: Connection,
  direct: boolean,
  turn: TurnScope | undefined,
): ReviewTarget | 'elsewhere' | 'unknown' | null {
  if (getToolName(part) !== 'entries_publish') return null;
  const input = (part.input ?? {}) as Record<string, unknown>;
  const { id, expectedVersion } = input;
  if (typeof id !== 'string') return null;
  const space = direct ? input.space : turn?.spaceId;
  const environment = direct ? input.environment : turn?.environmentId;
  // Nothing says where it runs (no scope stored, or a continuation from elsewhere left none).
  if (typeof space !== 'string' || typeof environment !== 'string') return 'unknown';
  // A card outlives a switch of space or environment, and an id can mean a different entry there.
  if (space !== conn.space || environment !== conn.environment) return 'elsewhere';
  return {
    entryId: id,
    ...(typeof expectedVersion === 'number' ? { version: expectedVersion } : {}),
    ...(metaOf(part).about ? {} : { named: true }),
  };
}

/**
 * What a publish card will put live, from the system's own diff of the entry the call names. Nothing
 * here comes from the model: its text never reaches this card, and a read that fails says so.
 */
function PublishReview({
  review,
  place,
}: {
  review: EntryReview;
  /** Why the review wasn't read: the card runs somewhere else, or nothing says where. */
  place?: 'elsewhere' | 'unknown' | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const note = (text: string) => <p className="text-muted-foreground text-xs">{text}</p>;
  if (place === 'unknown')
    return note('Coworker can’t tell where this runs, so it can’t show what goes live.');
  if (place === 'elsewhere')
    return note(
      'This was asked in another space or environment. Switch back to see what goes live.',
    );
  // Held at about a short list's height, so Not now and Confirm don't move under the pointer.
  if (review.status === 'loading')
    return <div className="min-h-20">{note('Comparing with what’s live…')}</div>;
  if (review.status === 'first') return note(FIRST_PUBLISH);
  if (review.status === 'failed') return <ReviewFailed />;
  if (review.status !== 'ready') return null;
  const changed = review.fields.filter((f) => f.kind !== 'unchanged').length;
  const { hiddenChanges } = review;
  if (changed === 0)
    return hiddenChanges > 0 ? <HiddenChanges count={hiddenChanges} alone /> : note(NO_CHANGES);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-1">
      {note(fieldsGoLive(changed))}
      <ChangedFields fields={review.fields} />
      {hiddenChanges > 0 ? <HiddenChanges count={hiddenChanges} alone={false} /> : null}
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
        <FieldReview fields={review.fields} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A call waiting for the person: a page's action, or anything the model proposed to change. One
 * press confirms it; Not now leaves everything as it was. A publish lists what will go live, and
 * can't be confirmed until that has been read. Focus starts on the safe choice when the card came
 * from a page (the person just pressed for it) or the person is already in the conversation, never
 * pulled out of a field they are typing in. A card a newer, identical request replaced stops
 * asking, so only one button can do the thing.
 */
export function ActionCard({
  part,
  respond,
  actionKey,
  direct,
  replaced,
  turn,
}: {
  part: Part;
  respond: (part: Part, approved: boolean) => void;
  /** Unique in the conversation; a tool call id need not be. */
  actionKey: string;
  direct: boolean;
  replaced?: boolean;
  /** The scope of the turn a model's card came from. */
  turn?: TurnScope;
}) {
  const name = getToolName(part);
  const titleId = useId();
  const safe = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);
  const asking = part.state === 'approval-requested' && !replaced;

  const { client, conn } = useClient();
  const target = useMemo(
    () => (asking ? publishTarget(part, conn, direct, turn) : null),
    [asking, part, conn, direct, turn],
  );
  const place = target === 'elsewhere' || target === 'unknown' ? target : undefined;
  const review = useEntryReview(
    client,
    target === 'elsewhere' || target === 'unknown' ? null : target,
    conn.locale,
  );
  const about = aboutOf(part) ?? ('title' in review && review.title ? review.title : undefined);

  // The panel is inert until it opens, and focus can't land in it: a card that arrives first (a
  // cold open, whose message can beat the page's answer) waits for that, then asks once.
  const panelOpen = useAssistantIfAny()?.open ?? true;
  const offered = useRef(false);
  useEffect(() => {
    if (!asking || !panelOpen || offered.current) return;
    offered.current = true;
    const el = safe.current;
    const now = document.activeElement;
    const typing = now instanceof HTMLElement && now.matches('input, textarea, [contenteditable]');
    const inLog = !now || now === document.body || el?.closest('[role="log"]')?.contains(now);
    if ((direct && !typing) || inLog) el?.focus({ preventScroll: true });
  }, [asking, direct, panelOpen]);

  // The buttons go when the card is answered, here or anywhere else. Focus that was on them stays
  // with what replaces them, which outlives both, so it never falls to the body.
  const holder = useRef<HTMLDivElement>(null);
  const focusWithin = useRef(false);
  useEffect(() => {
    if (!asking && focusWithin.current && document.activeElement === document.body)
      holder.current?.focus({ preventScroll: true });
  }, [asking]);
  const answer = (approved: boolean) => {
    holder.current?.focus({ preventScroll: true });
    setSent(true);
    respond(part, approved);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only notices focus; it is no control.
    <div
      ref={holder}
      tabIndex={-1}
      onFocus={() => {
        focusWithin.current = true;
      }}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          focusWithin.current = false;
      }}
    >
      {replaced && part.state === 'approval-requested' ? (
        <Line icon={Ban}>{toolTitle(name)}: replaced by the newer request below</Line>
      ) : !asking ? (
        <EditLine part={part} />
      ) : (
        <Confirmation
          approval={part.approval}
          state={part.state}
          aria-labelledby={titleId}
          data-action={actionKey}
          className="cw-confirm my-1 scroll-my-4"
        >
          {/* No `overflow-hidden`: it would clip the buttons' touch areas (`hit-area`). */}
          <Card size="sm" className="gap-3 overflow-visible pb-0 ring-wait/40">
            <CardHeader>
              <CardTitle>
                <h3 id={titleId} className="min-w-0 font-semibold text-sm leading-snug">
                  {toolTitle(name)}
                </h3>
              </CardTitle>
            </CardHeader>
            {about || target ? (
              <CardContent className="space-y-2">
                {about ? <p className="break-words text-ui leading-snug">{about}</p> : null}
                {target ? <PublishReview review={review} place={place} /> : null}
              </CardContent>
            ) : null}
            <CardFooter className="flex-col items-stretch gap-2 rounded-b-2xl border-t bg-wait/10 pb-(--card-spacing)">
              <p className="text-muted-foreground text-xs leading-snug">
                Nothing changes until you confirm, here or wherever else you’re signed in.
              </p>
              <ConfirmationActions>
                <Button
                  ref={safe}
                  size="sm"
                  variant="ghost"
                  disabled={sent}
                  data-safe-choice
                  onClick={() => answer(false)}
                >
                  Not now
                </Button>
                <Button
                  size="sm"
                  variant={isDestructive(part) ? 'destructive' : 'default'}
                  disabled={sent || review.status === 'loading'}
                  onClick={() => answer(true)}
                >
                  Confirm
                </Button>
              </ConfirmationActions>
            </CardFooter>
          </Card>
        </Confirmation>
      )}
    </div>
  );
}

// ── Message actions ────────────────────────────────────────────────────────

/** Copies the text, then says so for a moment. */
export function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <MessageAction
      label={done ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? <Check /> : <Copy />}
    </MessageAction>
  );
}

/** A turn that failed: what went wrong, in a sentence, with the way to try again. */
export function TurnError({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-bad/10 px-3 py-2 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-bad">Coworker couldn’t finish that reply.</p>
        <p className="break-words text-muted-foreground text-xs">{message}</p>
      </div>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Try again
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        className="hit-area grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
