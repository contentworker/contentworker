/**
 * The assistant panel: one conversation per person, beside every page. It talks to the person's own
 * AssistantAgent over the proxied socket (`useAgentChat`), so a reply keeps going if the tab sleeps
 * and picks up again when it wakes. The page in front supplies the context chip, and hands the
 * panel its edits (`act`), which it sends as they are, one tool call each.
 */

import { type UseAgentChatOptions, useAgentChat } from '@cloudflare/ai-chat/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@contentworker/ui/alert-dialog';
import { Button } from '@contentworker/ui/button';
import { ComposeLoader, composeSequences } from '@contentworker/ui/compose-loader';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import { cn } from '@contentworker/ui/lib/utils';
import { useAgent } from 'agents/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { ChevronDown, MoreHorizontal, Pencil, RotateCcw, X } from 'lucide-react';
import {
  Component,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '~/components/ai-elements/conversation';
import {
  MessageAction,
  MessageActions,
  MessageContent,
  Message as MessageFrame,
} from '~/components/ai-elements/message';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '~/components/ai-elements/prompt-input';
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueList,
} from '~/components/ai-elements/queue';
import { Shimmer } from '~/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '~/components/ai-elements/suggestion';
import { Mark } from '~/components/mark';
import { useMe } from '~/lib/use-me';
import {
  type ActResult,
  AssistantUnavailable,
  contextLabel,
  type QueuedAct,
  useAssistant,
} from '../../lib/assistant';
import {
  type AgentCaller,
  agentAddress,
  chatBody,
  isDirectCall,
  sendAct,
  sendAnswer,
} from '../../lib/assistant-client';
import { coarse, useMedia, useVisualViewport, WIDE } from '../../lib/device';
import { useShortcutLabel } from '../../lib/shortcuts';
import { Empty } from '../page';
import {
  ActionCard,
  CopyAction,
  EditLine,
  isWrite,
  type Part,
  Prose,
  ReadLine,
  TurnError,
  toolTitle,
} from './parts';

/**
 * Whether the socket to the agent is up. `down` until it opens again (it keeps retrying); `ended`
 * when the agent closed it because the person's sign-in has ended (it doesn't retry).
 */
type Link = 'connecting' | 'open' | 'down' | 'ended';

/** The agent's close code for a person whose sign-in has ended (packages/http/src/assistant). */
const SIGN_IN_ENDED = 4401;

/** How long a page's edit waits for the socket to open before the page makes it itself. */
export const LINK_TIMEOUT_MS = 5000;

type Agent = UseAgentChatOptions['agent'] & AgentCaller;

/**
 * The panel. On wide screens it takes a column beside the page (the page narrows; nothing is
 * covered); below that it is a sheet between the header and the tab bar, taking exactly the area
 * above an on-screen keyboard. Mounted on first open (or a page's first edit) only, so nobody
 * connects to an assistant they never used.
 *
 * Both slide, in 200ms with an exponential ease-out. The sheet slides in from the right edge, where
 * the button that opens it sits. The column moves only by transform: opening takes its 400px at
 * once (the page lays out one time) and slides its content in; closing slides the content out and
 * gives the width back once it has gone. Animating the width would lay the page out every frame.
 * Reduced motion shows and hides both at once.
 */
export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const wide = useMedia(WIDE);
  // As a sheet, it keeps its composer above the on-screen keyboard.
  useVisualViewport(open && !wide);
  // As a column, it tells toasts (cms/lib/toast) to sit inside it, above the composer.
  const column = open && wide;
  useEffect(() => {
    if (!column) return;
    const root = document.documentElement;
    root.style.setProperty('--assistant-w', '400px');
    root.style.setProperty('--assistant-lift', '7.5rem');
    return () => {
      root.style.removeProperty('--assistant-w');
      root.style.removeProperty('--assistant-lift');
    };
  }, [column]);
  return (
    <aside
      aria-label="Coworker"
      inert={!open}
      className={cn(
        'z-30 overflow-hidden bg-card ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        // Phones and tablets: a sheet over the page, between the header and the phone's tab bar.
        'fixed inset-x-0 top-[var(--shell-h)] bottom-[var(--tabbar-h)] transition-[opacity,translate] duration-200 md:left-(--sidebar-width-icon)',
        open ? 'opacity-100' : 'pointer-events-none translate-x-full opacity-0',
        // With the keyboard up, it takes exactly the visible area above it, over the bars.
        'in-data-keyboard:top-[var(--vvtop)] in-data-keyboard:bottom-auto in-data-keyboard:z-50 in-data-keyboard:h-[var(--vvh)]',
        // Wide screens: a column beside the page. Its width changes in one step, not per frame: at
        // once on opening, and on closing only after the content's 200ms slide out.
        'lg:sticky lg:inset-auto lg:top-[var(--shell-h)] lg:flex lg:h-[calc(100dvh-var(--shell-h))] lg:shrink-0 lg:translate-x-0 lg:justify-end lg:opacity-100 lg:transition-[width] lg:duration-0 lg:motion-reduce:transition-none',
        open ? 'lg:w-[400px]' : 'lg:w-0 lg:delay-200',
      )}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        // The sheet covers the page, so Escape closes it; the column stays and hands focus back.
        if (!window.matchMedia?.(WIDE).matches) setOpen(false);
        document.getElementById('main')?.focus({ preventScroll: true });
      }}
    >
      <div
        className={cn(
          'flex h-full flex-col lg:w-[400px] lg:shrink-0 lg:border-l',
          'lg:transition-[opacity,translate] lg:duration-200 lg:ease-[cubic-bezier(0.16,1,0.3,1)] lg:motion-reduce:transition-none',
          open ? 'lg:translate-x-0 lg:opacity-100' : 'lg:translate-x-full lg:opacity-0',
        )}
      >
        <Connected />
      </div>
    </aside>
  );
}

/**
 * The socket, and the edits pages hand over. It never suspends, so an edit is sent (or handed back
 * to its page) while the conversation is still loading, or when it can't load at all.
 */
function Connected() {
  const me = useMe();
  const a = useAssistant();
  const [link, setLinkState] = useState<Link>('connecting');
  const linkRef = useRef<Link>('connecting');
  const watchers = useRef(new Set<() => void>());
  const setLink = useCallback((next: Link) => {
    linkRef.current = next;
    setLinkState(next);
    for (const w of [...watchers.current]) w();
  }, []);

  const socket = useRef<{ close: () => void } | null>(null);
  const agent = useAgent({
    ...agentAddress(me?.id ?? 'local'),
    onOpen: () => setLink('open'),
    onClose: (e: CloseEvent) => {
      // Reconnecting can't help a sign-in that has ended: stop, and ask for a reload.
      if (e?.code === SIGN_IN_ENDED) {
        setLink('ended');
        socket.current?.close();
      } else if (linkRef.current !== 'ended') setLink('down');
    },
    onError: () => {
      if (linkRef.current !== 'ended') setLink('down');
    },
  }) as Agent;
  socket.current = agent as unknown as { close: () => void };

  // Settles once the socket is open; rejects at once while it is down, and after LINK_TIMEOUT_MS
  // while it is still connecting. Either way nothing was sent.
  const whenOpen = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          window.clearTimeout(timer);
          watchers.current.delete(check);
        };
        const check = () => {
          if (linkRef.current === 'open') {
            done();
            resolve();
          } else if (linkRef.current === 'down' || linkRef.current === 'ended') {
            done();
            reject(new AssistantUnavailable());
          }
        };
        const timer = window.setTimeout(() => {
          done();
          reject(new AssistantUnavailable());
        }, LINK_TIMEOUT_MS);
        watchers.current.add(check);
        check();
      }),
    [],
  );

  // Edits pages handed over: each is one tool call of its own, sent as the page built it.
  const latest = useRef({ a, agent });
  latest.current = { a, agent };
  useEffect(() => {
    if (!a.acts.length) return;
    for (const q of a.takeActs()) void deliver(q);
    async function deliver(q: QueuedAct) {
      try {
        await whenOpen();
      } catch (e) {
        q.reject(asError(e));
        return;
      }
      try {
        const r = await sendAct(latest.current.agent, q.tool, q.input, q.context, q.about);
        if ('waiting' in r) {
          // The card is in the conversation now: the page waits for its answer, here.
          latest.current.a.awaitAnswer(r.callId, q);
          latest.current.a.setOpen(true);
        } else q.resolve({ output: r.output });
      } catch (e) {
        q.reject(asError(e));
      }
    }
  }, [a.acts, a.takeActs, whenOpen]);

  return (
    <ConversationBoundary fallback={<PanelFrame note="unreachable" />}>
      <Suspense fallback={<PanelFrame note="opening" />}>
        <ChatView agent={agent} link={link} />
      </Suspense>
    </ConversationBoundary>
  );
}

/** A conversation that couldn't load (its history, say) leaves the panel saying so, not a blank. */
class ConversationBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PanelFrame({ note }: { note: 'opening' | 'unreachable' }) {
  return (
    <div className="flex h-full flex-col">
      <PanelHeader />
      <div className="flex-1 px-4 py-6 text-muted-foreground text-sm">
        {note === 'opening' ? (
          <Shimmer>Opening your conversation</Shimmer>
        ) : (
          <p role="status">
            Can’t reach Coworker right now. Edits you make on the page still go through.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * What the next question is about. It sits in the composer, beside where the question is written
 * (and in thumb reach on a phone), not in the header.
 */
function ScopeChip() {
  const { page, scope, setScope } = useAssistant();
  const onPage = page.kind !== 'everything';
  const current = scope === 'everything' || !onPage ? 'Everything' : contextLabel(page);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="hit-area flex h-7 min-w-0 max-w-[70%] items-center gap-1 rounded-full border border-input px-2.5 text-muted-foreground text-xs hover:text-foreground touch:h-9 touch:px-3"
        aria-label={`Asking about: ${current}`}
      >
        <span className="truncate">{current}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="caption">Ask about</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={onPage ? scope : 'everything'}
          onValueChange={(v) => setScope(v as 'page' | 'everything')}
        >
          <DropdownMenuRadioItem value="page" disabled={!onPage}>
            <span className="truncate">
              {page.kind === 'entry'
                ? `This entry: ${page.label}`
                : page.kind === 'content-type'
                  ? `These entries: ${page.label}`
                  : 'This page (nothing open)'}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="everything">Everything</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PanelHeader({ onClear, canClear }: { onClear?: () => void; canClear?: boolean }) {
  const { setOpen } = useAssistant();
  const shortcut = useShortcutLabel('J');
  const [clearing, setClearing] = useState(false);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <h2 className="font-semibold text-base tracking-title">Coworker</h2>
      <div className="ml-auto flex items-center">
        {onClear ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="hit-area grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Conversation options"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={!canClear} onSelect={() => setClearing(true)}>
                New conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="hit-area grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Close Coworker (${shortcut})`}
          title={`Close (${shortcut})`}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
        {onClear ? (
          <AlertDialog open={clearing} onOpenChange={setClearing}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Start a new conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  This conversation is deleted; it was only yours. Changes you confirmed stay made
                  and stay in the audit log.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onClear}>
                  New conversation
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </header>
  );
}

type Message = UIMessage;

function ChatView({ agent, link }: { agent: Agent; link: Link }) {
  const a = useAssistant();
  const chat = useAgentChat<unknown, Message>({
    agent,
    body: () => chatBody(a.readContext()),
  });
  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    error,
    clearError,
    addToolApprovalResponse,
    clearHistory,
  } = chat;
  const busy = chat.isStreaming || chat.isRecovering || status === 'submitted';
  const ended = link === 'ended';
  const down = link === 'down' || ended;

  // A card a page made (`act`) is answered through the agent, with no model turn, and settles the
  // page waiting on it; a card the model proposed is answered as the AI SDK answers one.
  const latest = useRef(a);
  latest.current = a;
  const respond = useCallback(
    (part: Part, approved: boolean) => {
      if (!isDirectCall(part)) {
        if (part.approval) addToolApprovalResponse({ id: part.approval.id, approved });
        return;
      }
      const id = part.toolCallId;
      sendAnswer(agent, id, approved)
        .then((r) =>
          latest.current.answered(
            id,
            approved && r.done !== null ? { output: r.output } : { declined: true },
          ),
        )
        .catch((e: unknown) => latest.current.answered(id, asError(e)));
    },
    [addToolApprovalResponse, agent],
  );

  // A card answered somewhere else (another tab, the phone) settles the page waiting on it here.
  useEffect(() => {
    for (const m of messages)
      for (const p of m.parts) {
        if (!isToolUIPart(p) || !isDirectCall(p)) continue;
        const settled = settledAs(p);
        if (settled) latest.current.answered(p.toolCallId, settled);
      }
  }, [messages]);

  // ── Messages written while a reply is running wait here, editable, until it ends.
  const [held, setHeld] = useState<string[]>([]);
  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      if (busy) setHeld((h) => [...h, t]);
      else void sendMessage({ text: t });
    },
    [busy, sendMessage],
  );
  useEffect(() => {
    if (busy || !held.length) return;
    const [next, ...rest] = held;
    setHeld(rest);
    if (next) void sendMessage({ text: next });
  }, [busy, held, sendMessage]);

  // A question asked from a page.
  useEffect(() => {
    if (!a.pendingAsk) return;
    const t = a.takeAsk();
    if (t) send(t);
  }, [a.pendingAsk, a.takeAsk, send]);

  const last = messages.at(-1);
  const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant');
  // Editing or answering again rewrites what came after; never across an action, which may already
  // have happened, or an edit a page made.
  const lastAction = messages.findLastIndex(hasAction);
  const edit = useCallback(
    (messageId: string, text: string) => {
      const t = text.trim();
      if (t && !busy) void sendMessage({ text: t, messageId });
    },
    [busy, sendMessage],
  );

  const thinking =
    status === 'submitted' || (busy && last?.role === 'user') || (busy && last?.parts.length === 0);
  const { pending, replaced } = waitingActions(messages);
  const announcement = useAnnouncement(messages, busy, pending);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader onClear={clearHistory} canClear={messages.length > 0 && !busy} />
      {down ? (
        // Quiet: the page's own edits don't need the panel, so this is news, not an error.
        <p role="status" className="border-b px-4 py-2 text-muted-foreground text-xs">
          {ended
            ? 'Your sign-in has ended. Reload the page to sign in again.'
            : 'Can’t reach Coworker right now; trying again. Edits you make on the page still go through.'}
        </p>
      ) : null}
      {/* Not live: streamed text would be read out a fragment at a time. A finished reply, and an
          action that needs an answer, are announced once each instead (`useAnnouncement`). */}
      <Conversation aria-label="Conversation" className="cw-scroll min-h-0">
        <ConversationContent aria-live="off" className="gap-4 px-4 py-4">
          {messages.length === 0 ? (
            <FirstRun onAsk={send} />
          ) : (
            messages.map((m, i) =>
              m.role === 'user' ? (
                <UserMessage
                  key={m.id}
                  m={m}
                  busy={busy}
                  onEdit={i > lastAction ? edit : undefined}
                />
              ) : (
                <AssistantMessage
                  key={m.id}
                  m={m}
                  streaming={busy && i === messages.length - 1}
                  respond={respond}
                  replaced={replaced}
                  // Only the latest reply can be asked again, and not while one is running.
                  onRegenerate={
                    i === lastAssistant &&
                    i === messages.length - 1 &&
                    i !== lastAction &&
                    !busy &&
                    !down
                      ? () => void regenerate()
                      : undefined
                  }
                />
              ),
            )
          )}
          {thinking ? (
            <div role="status" className="flex items-center gap-2 text-ui">
              <ComposeLoader icon={composeSequences.working} className="size-3.5 text-ai" />
              <Shimmer as="span">
                {chat.isRecovering ? 'Picking up where it left off' : 'Working on it'}
              </Shimmer>
            </div>
          ) : null}
          {error && !busy ? (
            <TurnError
              message={error.message}
              onRetry={() => {
                clearError();
                void regenerate();
              }}
              onDismiss={clearError}
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {pending.length ? <WaitingBar pending={pending} /> : null}
      {held.length ? (
        <HeldMessages
          held={held}
          onChange={(i, text) => setHeld((h) => h.map((x, j) => (j === i ? text : x)))}
          onRemove={(i) => setHeld((h) => h.filter((_, j) => j !== i))}
        />
      ) : null}
      <Composer busy={busy} down={down} onSend={send} onStop={() => void stop()} />
    </div>
  );
}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** How a page's card ended, once it has: its output, declined, or why it failed. */
export function settledAs(p: Part): ActResult | Error | null {
  if (p.state === 'output-available') return { output: p.output };
  if (p.state === 'output-denied') return { declined: true };
  if (p.state === 'approval-responded' && p.approval?.approved === false) return { declined: true };
  if (p.state === 'output-error') return new Error(p.errorText || 'The change didn’t go through');
  return null;
}

const textOf = (m: Message) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();

/** Whether a message holds an action or a page's edit: the conversation never rewrites past it. */
const hasAction = (m: Message) =>
  m.parts.some(
    (p) =>
      isToolUIPart(p) && (isDirectCall(p) || p.approval !== undefined || isWrite(getToolName(p))),
  );

function UserMessage({
  m,
  busy,
  onEdit,
}: {
  m: Message;
  busy: boolean;
  onEdit?: (messageId: string, text: string) => void;
}) {
  const text = textOf(m);
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const changed = draft.trim() && draft.trim() !== text;
    return (
      <MessageFrame from="user" className="max-w-full">
        <PromptInput
          aria-label="Edit your message"
          onSubmit={() => {
            if (!changed) return;
            onEdit?.(m.id, draft);
            setDraft(null);
          }}
        >
          <PromptInputTextarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
            sendOnEnter={(e) => !coarse() || e.metaKey || e.ctrlKey}
            aria-label="Edited message"
          />
          <PromptInputFooter className="justify-end">
            <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!changed || busy}>
              Send again
            </Button>
          </PromptInputFooter>
        </PromptInput>
        <p className="text-muted-foreground text-xs">
          Sending again replaces this message and the replies after it.
        </p>
      </MessageFrame>
    );
  }
  // The actions sit beside the bubble, so a question costs no extra line.
  return (
    <MessageFrame from="user" className="flex-row-reverse items-center gap-1">
      <MessageContent>{text}</MessageContent>
      <MessageActions>
        <CopyAction text={text} />
        {onEdit ? (
          <MessageAction label="Edit" disabled={busy} onClick={() => setDraft(text)}>
            <Pencil />
          </MessageAction>
        ) : null}
      </MessageActions>
    </MessageFrame>
  );
}

type Waiting = { key: string; name: string; input: unknown };

/**
 * Names one tool part in the conversation. Not its tool call id: a model may number its calls
 * afresh each turn, so the same id can turn up in several messages.
 */
const actionKey = (messageId: string, index: number) => `${messageId}:${index}`;

/**
 * The calls waiting for the person's answer, oldest first. The conversation is one per person and
 * live on every device they use, so the same request can be made twice. Only the newest of
 * identical requests asks; the older ones are `replaced`.
 */
function waitingActions(messages: Message[]) {
  const asking: Waiting[] = [];
  for (const m of messages)
    m.parts.forEach((p, i) => {
      if (isToolUIPart(p) && p.state === 'approval-requested')
        asking.push({ key: actionKey(m.id, i), name: getToolName(p), input: p.input });
    });
  const newest = new Map<string, string>();
  for (const w of asking) newest.set(`${w.name} ${JSON.stringify(w.input)}`, w.key);
  const live = new Set(newest.values());
  return {
    pending: asking.filter((w) => live.has(w.key)),
    replaced: new Set(
      asking.filter((w) => !live.has(w.key)).map((w) => w.key),
    ) as ReadonlySet<string>,
  };
}

/**
 * What a screen reader hears: a reply once it has finished (not each streamed fragment), and a card
 * once it starts waiting for an answer.
 */
function useAnnouncement(messages: Message[], busy: boolean, pending: Waiting[]) {
  const [said, setSaid] = useState('');
  const wasBusy = useRef(busy);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const last = messages.at(-1);
      const text = last?.role === 'assistant' ? textOf(last) : '';
      if (text) setSaid(text.length > 300 ? `${text.slice(0, 300)}…` : text);
    }
    wasBusy.current = busy;
  }, [busy, messages]);
  useEffect(() => {
    // The first render only learns what is already waiting; it announces nothing.
    const before = known.current;
    known.current = new Set(pending.map((w) => w.key));
    const fresh = before ? pending.filter((w) => !before.has(w.key)) : [];
    if (fresh.length)
      setSaid(`Waiting for your answer: ${fresh.map((w) => toolTitle(w.name)).join(', ')}`);
  }, [pending]);
  return said;
}

/**
 * Pinned above the composer while a card waits for the person, so it can't scroll out of mind under
 * newer turns. The conversation goes on; pressing it brings the card back, focused on the safe
 * choice.
 */
function WaitingBar({ pending }: { pending: Waiting[] }) {
  const newest = pending.at(-1);
  if (!newest) return null;
  const show = () => {
    const card = document.querySelector<HTMLElement>(`[data-action="${CSS.escape(newest.key)}"]`);
    if (!card) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
    card.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  return (
    <button
      type="button"
      onClick={show}
      className="mx-3 mt-2 flex min-h-9 items-center gap-2 rounded-full border border-wait/30 bg-wait/10 px-3 text-left text-xs hover:bg-wait/15"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-wait" />
      <span className="min-w-0 flex-1 truncate">
        {pending.length === 1 ? (
          <>
            <span className="font-medium text-foreground">Waiting for you:</span>{' '}
            <span className="text-muted-foreground">{toolTitle(newest.name)}</span>
          </>
        ) : (
          <span className="font-medium text-foreground">
            {pending.length} changes waiting for you
          </span>
        )}
      </span>
      <span className="shrink-0 font-medium text-foreground">Show</span>
    </button>
  );
}

function AssistantMessage({
  m,
  streaming,
  respond,
  replaced,
  onRegenerate,
}: {
  m: Message;
  streaming: boolean;
  respond: (part: Part, approved: boolean) => void;
  replaced: ReadonlySet<string>;
  onRegenerate?: () => void;
}) {
  const lastText = m.parts.findLastIndex((p) => p.type === 'text');
  const text = textOf(m);
  return (
    <MessageFrame from="assistant">
      <MessageContent className="space-y-2">
        {m.parts.map((p, i) => {
          const key = actionKey(m.id, i);
          if (p.type === 'text')
            return p.text.trim() ? (
              <Prose key={key} text={p.text} streaming={streaming && i === lastText} />
            ) : null;
          if (!isToolUIPart(p)) return null;
          const name = getToolName(p);
          if (p.approval !== undefined)
            return (
              <ActionCard
                key={key}
                part={p}
                respond={respond}
                actionKey={key}
                direct={isDirectCall(p)}
                replaced={replaced.has(key)}
              />
            );
          if (isWrite(name) || isDirectCall(p)) return <EditLine key={key} part={p} />;
          return <ReadLine key={key} part={p} streaming={streaming} />;
        })}
      </MessageContent>
      {!streaming && (text || onRegenerate) ? (
        <MessageActions>
          {text ? <CopyAction text={text} /> : null}
          {onRegenerate ? (
            <MessageAction label="Answer again" onClick={onRegenerate}>
              <RotateCcw />
            </MessageAction>
          ) : null}
        </MessageActions>
      ) : null}
    </MessageFrame>
  );
}

// ── First run ──────────────────────────────────────────────────────────────

function FirstRun({ onAsk }: { onAsk: (text: string) => void }) {
  const { page, scope } = useAssistant();
  const kind = scope === 'everything' ? 'everything' : page.kind;
  const ideas =
    kind === 'entry'
      ? ['Summarize this entry', 'What changed since it was last published?', 'Suggest tags for it']
      : kind === 'content-type'
        ? ['Which of these are still drafts?', 'What fields does this content type have?']
        : ['What’s waiting to be published?', 'How do releases work?'];
  return (
    <Empty
      className="px-0 py-6"
      icon={<Mark className="text-ai" />}
      title="Ask about your content, or have it make a change."
      action={
        <Suggestions className="items-center">
          {ideas.map((t) => (
            <Suggestion key={t} suggestion={t} onClick={onAsk} />
          ))}
        </Suggestions>
      }
    >
      It works within your role, and asks before it changes anything. Edits you make on the page
      show here too.
    </Empty>
  );
}

// ── Composer ───────────────────────────────────────────────────────────────

function HeldMessages({
  held,
  onChange,
  onRemove,
}: {
  held: string[];
  onChange: (i: number, text: string) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <Queue className="mx-3 mt-2">
      <p className="caption px-1">Sends when this reply finishes</p>
      <QueueList>
        {held.map((t, i) => (
          // Held messages have no ids of their own; their order is their identity.
          <QueueItem key={i}>
            <input
              value={t}
              onChange={(e) => onChange(i, e.target.value)}
              aria-label="Queued message"
              className="h-7 min-w-0 flex-1 rounded-xl bg-transparent px-2 text-ui focus-visible:bg-background focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <QueueItemActions>
              <QueueItemAction label="Remove queued message" onClick={() => onRemove(i)}>
                <X className="size-3.5" />
              </QueueItemAction>
            </QueueItemActions>
          </QueueItem>
        ))}
      </QueueList>
    </Queue>
  );
}

function Composer({
  busy,
  down,
  onSend,
  onStop,
}: {
  busy: boolean;
  down: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const { focusToken } = useAssistant();
  const shortcut = useShortcutLabel('J');
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusToken) box.current?.focus();
  }, [focusToken]);
  return (
    <div className="shrink-0 p-3 in-data-keyboard:pb-2">
      <PromptInput
        aria-label="Message Coworker"
        onSubmit={() => {
          if (!text.trim() || down) return;
          onSend(text);
          setText('');
        }}
      >
        <PromptInputTextarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          // On a touch screen Return is a new line and the button sends; ⌘/Ctrl+Enter always sends.
          sendOnEnter={(e) => !coarse() || e.metaKey || e.ctrlKey}
          placeholder={busy ? 'Next message, sent after this reply' : 'Ask Coworker'}
          aria-label="Message Coworker"
        />
        <PromptInputFooter className="gap-1.5 pt-0">
          <ScopeChip />
          <span className="flex-1" />
          {/* While a reply runs, stop sits beside send, which holds the next message. */}
          {busy ? (
            <PromptInputSubmit status="streaming" onStop={onStop} className="touch:size-9" />
          ) : null}
          <PromptInputSubmit disabled={!text.trim() || down} className="touch:size-9" />
        </PromptInputFooter>
      </PromptInput>
      <p className="mt-1.5 hidden px-1 text-muted-foreground text-xs fine:block">
        Enter sends · Shift+Enter for a new line · {shortcut} opens and closes
      </p>
    </div>
  );
}
