/**
 * The assistant's state, shared by the shell and the pages under it: whether the panel is open,
 * what the page in front of it is about (the context chip), and the edits pages hand it. The panel
 * lives in the shell, so a conversation and a card waiting for an answer survive navigation.
 *
 * A page's edit goes through the assistant (`act`): the exact MCP tool call for what was pressed,
 * no model, kept in the conversation. An action stops at a confirm card in the panel and the page
 * waits for the answer; anything else runs at once and leaves a line. When the assistant can't be
 * reached (switched off, or its socket down), `useAssistantEdit` says so with `null` and the page
 * makes the edit through the API itself, as it always did: an edit never depends on the panel.
 */

import type {
  AssistantContext,
  AssistantPage,
  AssistantScope,
  AssistantTool,
  BlockOp,
} from '@contentworker/domain';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { scopeArgs } from './assistant-client';
import { useClient } from './client-context';
import { useFeatures } from './features';
import type { Connection } from './management';

/** The page's own context, read when a message is sent or an edit made. */
type PageReader = () => AssistantPage;

type Scope = 'page' | 'everything';

/** How a page's edit ended: what the tool returned, or the person declined its card. */
export type ActResult<T = unknown> = { output: T } | { declined: true };

/** An edit a page handed to the assistant, waiting for the panel to send it. */
export interface QueuedAct {
  readonly tool: AssistantTool;
  readonly input: Record<string, unknown>;
  readonly context: AssistantContext;
  readonly about?: string;
  resolve(r: ActResult): void;
  reject(err: Error): void;
}

/**
 * A Coworker block patch waiting for (or just given) the person's answer, as its card read it:
 * the dry run's applied ops, every block keyed, for the entry's page to show as ghosts. Only a card
 * whose dry run would save as it stands has one. `pending` while it asks, `saving` once confirmed,
 * then `saved`; `declined` on Not now, a failure, or a newer request replacing it.
 */
export interface ProposedBlocks {
  readonly entryId: string;
  readonly spaceId: string;
  readonly environmentId: string;
  readonly ops: readonly BlockOp[];
  readonly state: 'pending' | 'saving' | 'saved' | 'declined';
}

/** A question a page asks as if typed, with what the page is about for that message alone. */
export interface PageAsk {
  readonly text: string;
  readonly page?: AssistantPage;
}

/**
 * The edit was never sent: the assistant is off, its panel didn't load, or its socket is down. The
 * page makes the edit itself; nothing reached the agent, so nothing runs twice.
 */
export class AssistantUnavailable extends Error {
  constructor() {
    super('Coworker can’t be reached');
    this.name = 'AssistantUnavailable';
  }
}

interface AssistantState {
  /** The `assistant` feature: off, there is no toggle, no panel, and pages edit directly. */
  readonly enabled: boolean;
  readonly open: boolean;
  setOpen(open: boolean): void;
  /** Opens the panel and puts the cursor in its prompt. */
  focus(): void;
  /**
   * Asks a question as if typed, opening the panel. `page` is what that message is about in place
   * of the page's own context (the canvas's slot to fill); later messages carry the page's again.
   */
  ask(text: string, page?: AssistantPage): void;
  readonly pendingAsk: PageAsk | null;
  takeAsk(): PageAsk | null;
  readonly focusToken: number;
  /** What the page in front is about, when it says; everything otherwise. */
  readonly page: AssistantPage;
  /** The context a message or an edit carries now: the scope, and the page or everything. */
  readContext(): AssistantContext;
  /** "page" follows the page in front; "everything" asks about the whole environment. */
  readonly scope: Scope;
  setScope(s: Scope): void;
  register(read: PageReader): () => void;
  /**
   * Makes an edit through the assistant: the exact tool call, with no model. Settles with the
   * tool's output, or `declined` when the person said Not now to its card; rejects with the refusal
   * to show, or with `AssistantUnavailable` when it was never sent.
   */
  act(tool: AssistantTool, input: Record<string, unknown>, about?: string): Promise<ActResult>;
  /** Edits waiting for the panel to send them (the panel mounts while there are any). */
  readonly acts: readonly QueuedAct[];
  takeActs(): QueuedAct[];
  /** A card `act` made, waiting for the person's answer, and the page waiting on it. */
  awaitAnswer(callId: string, act: QueuedAct): void;
  answered(callId: string, r: ActResult | Error): void;
  /**
   * Block patches Coworker proposed, by card, for an entry's page to show as ghosts while each
   * waits (`useProposedBlocks`). Cards publish theirs; nothing here saves.
   */
  readonly proposals: ReadonlyMap<string, ProposedBlocks>;
  setProposal(card: string, p: ProposedBlocks | null): void;
}

const EVERYTHING: AssistantPage = { kind: 'everything' };
const Ctx = createContext<AssistantState | null>(null);

const OPEN_KEY = 'cw-assistant-open';

/** The header's space, environment and locale, as the assistant's scope. */
const scopeOf = (c: Connection): AssistantScope => ({
  spaceId: c.space,
  environmentId: c.environment,
  ...(c.locale ? { locale: c.locale } : {}),
});

/**
 * How long an edit waits for the panel to take it (the panel's chunk loads on first use). Past it
 * the edit was never sent, so the page may make it itself.
 */
export const TAKE_TIMEOUT_MS = 8000;

/** What `act` accepts: an input of at most 256 KB, and a label of at most 200 characters. */
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_ABOUT = 200;

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const enabled = useFeatures().assistant;
  const { conn } = useClient();
  const [open, setOpenState] = useState(false);
  const [scope, setScope] = useState<Scope>('page');
  const [focusToken, setFocusToken] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<PageAsk | null>(null);
  const [page, setPage] = useState<AssistantPage>(EVERYTHING);
  const [proposals, setProposals] = useState<ReadonlyMap<string, ProposedBlocks>>(new Map());
  const setProposal = useCallback((card: string, p: ProposedBlocks | null) => {
    setProposals((was) => {
      const had = was.get(card);
      if (p === null ? !had : had && JSON.stringify(had) === JSON.stringify(p)) return was;
      const next = new Map(was);
      if (p) next.set(card, p);
      else next.delete(card);
      return next;
    });
  }, []);
  const reader = useRef<PageReader | null>(null);
  // The queue itself lives in a ref, so taking it empties it at once: an effect that runs twice
  // (React's strict mode, a remount) never sends the same edit twice. `acts` re-renders the panel.
  const queue = useRef<QueuedAct[]>([]);
  const [acts, setActs] = useState<readonly QueuedAct[]>([]);
  const waiting = useRef(new Map<string, QueuedAct>());

  // The context is read when something is sent, so it always carries the latest scope and page.
  const latest = useRef({ conn, scope });
  latest.current = { conn, scope };
  const readContext = useCallback((): AssistantContext => {
    const { conn: c, scope: s } = latest.current;
    return {
      scope: scopeOf(c),
      page: s === 'everything' ? EVERYTHING : (reader.current?.() ?? EVERYTHING),
    };
  }, []);

  // Reopen the column on the next visit if it was open; a convenience, so storage may fail. Only
  // where it is a column: a sheet that covers the page on arrival would be in the way.
  useEffect(() => {
    if (!enabled) return;
    try {
      if (
        localStorage.getItem(OPEN_KEY) === '1' &&
        window.matchMedia?.('(min-width: 1024px)').matches
      )
        setOpenState(true);
    } catch {
      // Storage blocked: the panel starts closed.
    }
  }, [enabled]);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Storage blocked: remembered for this visit only.
    }
  }, []);

  const register = useCallback((read: PageReader) => {
    reader.current = read;
    setPage(read());
    return () => {
      if (reader.current === read) {
        reader.current = null;
        setPage(EVERYTHING);
      }
    };
  }, []);

  const act = useCallback(
    (tool: AssistantTool, input: Record<string, unknown>, about?: string) =>
      new Promise<ActResult>((resolve, reject) => {
        // Too big for the agent to keep (a long entry's save): the page makes it itself.
        if (!enabled || new Blob([JSON.stringify(input)]).size > MAX_INPUT_BYTES) {
          reject(new AssistantUnavailable());
          return;
        }
        // The context is the page's as the edit was made, whatever the chip says.
        const context: AssistantContext = {
          scope: scopeOf(latest.current.conn),
          page: reader.current?.() ?? EVERYTHING,
        };
        const q: QueuedAct = {
          tool,
          input: { ...scopeArgs(context.scope), ...input },
          context,
          ...(about
            ? { about: about.length > MAX_ABOUT ? `${about.slice(0, MAX_ABOUT - 1)}…` : about }
            : {}),
          resolve,
          reject,
        };
        queue.current = [...queue.current, q];
        setActs(queue.current);
        // Untaken (the panel's chunk never arrived): it was never sent, so the page makes it.
        setTimeout(() => {
          if (!queue.current.includes(q)) return;
          queue.current = queue.current.filter((x) => x !== q);
          setActs(queue.current);
          reject(new AssistantUnavailable());
        }, TAKE_TIMEOUT_MS);
      }),
    [enabled],
  );

  const takeActs = useCallback(() => {
    const q = queue.current;
    queue.current = [];
    if (q.length) setActs([]);
    return q;
  }, []);

  const awaitAnswer = useCallback((callId: string, q: QueuedAct) => {
    waiting.current.set(callId, q);
  }, []);
  const answered = useCallback((callId: string, r: ActResult | Error) => {
    const q = waiting.current.get(callId);
    if (!q) return;
    waiting.current.delete(callId);
    if (r instanceof Error) q.reject(r);
    else q.resolve(r);
  }, []);

  const value = useMemo<AssistantState>(
    () => ({
      enabled,
      open: enabled && open,
      setOpen,
      focus: () => {
        setOpen(true);
        setFocusToken((n) => n + 1);
      },
      ask: (text, askPage) => {
        setPendingAsk({ text, ...(askPage ? { page: askPage } : {}) });
        setOpen(true);
        setFocusToken((n) => n + 1);
      },
      pendingAsk,
      takeAsk: () => {
        const t = pendingAsk;
        setPendingAsk(null);
        return t;
      },
      focusToken,
      page,
      readContext,
      scope,
      setScope,
      register,
      act,
      acts,
      takeActs,
      awaitAnswer,
      answered,
      proposals,
      setProposal,
    }),
    [
      enabled,
      open,
      setOpen,
      pendingAsk,
      focusToken,
      page,
      readContext,
      scope,
      register,
      act,
      acts,
      takeActs,
      awaitAnswer,
      answered,
      proposals,
      setProposal,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAssistant needs AssistantProvider (the shell renders it)');
  return v;
}

/** The assistant where the shell provides one; null outside it (a screen under test). */
export const useAssistantIfAny = (): AssistantState | null => useContext(Ctx);

/**
 * Tells the assistant what this page is about while it is mounted. `read` runs when a message is
 * sent or an edit made; `deps` re-announce the chip's label when they change.
 */
export function usePageContext(read: PageReader, deps: readonly unknown[]) {
  const register = useAssistantIfAny()?.register;
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => register?.(() => latest.current()), [register, ...deps]);
}

/**
 * A page's edit through the assistant: `edit(tool, input, about)` settles with the tool's output
 * or `declined`, or with `null` when the assistant isn't there to take it, and the page then makes
 * the edit itself. A refusal rejects with its words. The scope is added to the input here.
 */
export function useAssistantEdit() {
  const act = useAssistantIfAny()?.act;
  return useCallback(
    async <T = unknown>(
      tool: AssistantTool,
      input: Record<string, unknown>,
      about?: string,
    ): Promise<ActResult<T> | null> => {
      if (!act) return null;
      try {
        return (await act(tool, input, about)) as ActResult<T>;
      } catch (e) {
        if (e instanceof AssistantUnavailable) return null;
        throw e;
      }
    },
    [act],
  );
}

/** The label the chip shows for a page. */
export const contextLabel = (p: AssistantPage) =>
  p.kind === 'everything' ? 'Everything' : p.label;

/**
 * An edit's outcome, wherever it ran: the assistant's, or the page's own `direct` call when the
 * assistant wasn't there to take it.
 */
export async function orDirect<T>(
  r: ActResult<T> | null,
  direct: () => Promise<T>,
): Promise<ActResult<T>> {
  return r ?? { output: await direct() };
}

/**
 * The block patch Coworker proposes for `entryId` in the header's space and environment, while
 * its card waits (or saves): what the entry's page shows as ghosts. `onSaved` runs once when a
 * proposal this page saw waiting is saved, so the page reads the entry again.
 */
export function useProposedBlocks(
  entryId: string | undefined,
  onSaved?: () => void,
): ProposedBlocks | null {
  const proposals = useAssistantIfAny()?.proposals;
  const { conn } = useClient();
  const mine = [...(proposals ?? [])].filter(
    ([, p]) =>
      p.entryId === entryId && p.spaceId === conn.space && p.environmentId === conn.environment,
  );
  const seen = useRef(new Map<string, ProposedBlocks['state']>());
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const states = mine.map(([card, p]) => `${card}:${p.state}`).join('|');
  // Keyed on each card's state (states).
  useEffect(() => {
    for (const [card, p] of mine) {
      const was = seen.current.get(card);
      seen.current.set(card, p.state);
      if (p.state === 'saved' && (was === 'pending' || was === 'saving')) saved.current?.();
    }
  }, [states]);
  const live = mine.filter(([, p]) => p.state === 'pending' || p.state === 'saving');
  return live.at(-1)?.[1] ?? null;
}
