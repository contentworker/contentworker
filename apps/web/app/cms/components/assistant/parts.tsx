/**
 * How the assistant's messages read: prose; each read as a quiet line (what it is doing while the
 * reply streams, then that it's done); each edit as a line in the words of what happened, linking
 * to the entry it changed; and anything waiting for the person as a confirm card. A declined card
 * is neutral (the person chose it), never a failure.
 */

import { ASSISTANT_TOOLS, isAssistantTool } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@contentworker/ui/card';
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
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Confirmation, ConfirmationActions } from '~/components/ai-elements/confirmation';
import { MessageAction, MessageResponse } from '~/components/ai-elements/message';
import { metaOf } from '../../lib/assistant-client';

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

/** What a card or line is about when the page didn't say: how many entries, for a batch. */
function aboutOf(part: Part): string | undefined {
  const about = metaOf(part).about;
  if (about) return about;
  const ids = (part.input as { ids?: unknown } | undefined)?.ids;
  if (Array.isArray(ids)) return `${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}`;
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

/**
 * A call waiting for the person: a page's action, or anything the model proposed to change. One
 * press confirms it; Not now leaves everything as it was. Focus starts on the safe choice when the
 * card came from a page (the person just pressed for it) or the person is already in the
 * conversation, never pulled out of a field they are typing in. A card a newer, identical request
 * replaced stops asking, so only one button can do the thing.
 */
export function ActionCard({
  part,
  respond,
  actionKey,
  direct,
  replaced,
}: {
  part: Part;
  respond: (part: Part, approved: boolean) => void;
  /** Unique in the conversation; a tool call id need not be. */
  actionKey: string;
  direct: boolean;
  replaced?: boolean;
}) {
  const name = getToolName(part);
  const about = aboutOf(part);
  const titleId = useId();
  const safe = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);
  const asking = part.state === 'approval-requested' && !replaced;

  useEffect(() => {
    if (!asking) return;
    const el = safe.current;
    const now = document.activeElement;
    const typing = now instanceof HTMLElement && now.matches('input, textarea, [contenteditable]');
    const inLog = !now || now === document.body || el?.closest('[role="log"]')?.contains(now);
    if ((direct && !typing) || inLog) el?.focus({ preventScroll: true });
  }, [asking, direct]);

  if (replaced && part.state === 'approval-requested')
    return <Line icon={Ban}>{toolTitle(name)}: replaced by the newer request below</Line>;
  if (!asking) return <EditLine part={part} />;

  return (
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
        {about ? (
          <CardContent>
            <p className="break-words text-ui leading-snug">{about}</p>
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
              onClick={() => {
                setSent(true);
                respond(part, false);
              }}
            >
              Not now
            </Button>
            <Button
              size="sm"
              variant={DESTRUCTIVE.has(name) ? 'destructive' : 'default'}
              disabled={sent}
              onClick={() => {
                setSent(true);
                respond(part, true);
              }}
            >
              Confirm
            </Button>
          </ConfirmationActions>
        </CardFooter>
      </Card>
    </Confirmation>
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
