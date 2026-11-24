import { focusIsAdrift } from '@contentworker/ui/lib/focus-return';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, RequestTimeoutError } from '~/cms/lib/management';
import { worthRetrying } from '~/cms/lib/migrations';
import { useStoppable } from '~/cms/lib/use-stoppable';

/** What a step that ended has to say; with `error`, what stopped it part-way. */
export interface StepEnd {
  readonly line: string;
  readonly error?: unknown;
}

interface Running {
  readonly id: string;
  /** It asks batch after batch, so its button is a Stop while it runs. */
  readonly loop: boolean;
}

interface Notice {
  readonly title: string;
  readonly message: string;
  readonly retry?: () => void;
}

/** A step's failure in words: a time-out never says nothing happened. */
export const stepFailure = (err: unknown) =>
  err instanceof RequestTimeoutError
    ? 'The step didn’t answer in time. It may still be running: the counts show what it did.'
    : apiErrorMessage(err);

/**
 * Runs a screen's steps one at a time: which is running, what the last one did, and what stopped
 * it (with Try again where that can change the answer). A loop's button turns into Stop, which
 * takes focus as it arrives; when a step is over focus goes back to its button, else to the line
 * that says what happened. Leaving the page stops a loop.
 */
export function useStepRunner(after: () => Promise<unknown>) {
  const [running, setRunning] = useState<Running | null>(null);
  const [said, setSaid] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const { start, stop } = useStoppable();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const status = useRef<HTMLParagraphElement>(null);
  const [focusTo, setFocusTo] = useState<string | null>(null);
  const held = useRef(false);
  const afterRef = useRef(after);
  afterRef.current = after;

  useEffect(() => {
    if (!focusTo) return;
    setFocusTo(null);
    // Only focus that has nowhere to be, or sits on this runner's own buttons: someone typing
    // elsewhere while a long loop runs keeps their place.
    const at = document.activeElement;
    const own = [...buttons.current.values()].some((b) => b === at);
    if (!own && !focusIsAdrift(at)) return;
    const el = buttons.current.get(focusTo);
    (el && !el.disabled ? el : status.current)?.focus();
  }, [focusTo]);

  const button = useCallback(
    (id: string) => (el: HTMLButtonElement | null) => {
      if (el) buttons.current.set(id, el);
      else buttons.current.delete(id);
    },
    [],
  );

  const run = async (
    id: string,
    opts: {
      /** Said over a failure: "Loading stopped". */
      readonly title: string;
      readonly loop?: boolean;
      /** Its failure in words, where the screen knows better than the API's message. */
      readonly explain?: (err: unknown) => string | undefined;
      /** The step's last word is where focus goes, not its button; `done`, only when it did it. */
      readonly focusStatus?: boolean | 'done';
      /** What Try again does, when it isn't the same act at once (a publish asks again). */
      readonly again?: () => void;
    },
    act: (signal: AbortSignal) => Promise<StepEnd>,
  ): Promise<void> => {
    if (held.current) return;
    held.current = true;
    const signal = start();
    setRunning({ id, loop: !!opts.loop });
    setNotice(null);
    setSaid('');
    if (opts.loop) setFocusTo('stop');
    let end: StepEnd;
    try {
      end = await act(signal);
    } catch (error) {
      end = { line: '', error };
    }
    await afterRef.current().catch(() => undefined);
    held.current = false;
    setSaid(end.line);
    if (end.error !== undefined) {
      const known = opts.explain?.(end.error);
      setNotice({
        title: opts.title,
        message: known ?? stepFailure(end.error),
        ...(known === undefined && worthRetrying(end.error)
          ? { retry: opts.again ?? (() => void run(id, opts, act)) }
          : {}),
      });
    }
    setRunning(null);
    const toStatus =
      opts.focusStatus === 'done' ? end.error === undefined : opts.focusStatus === true;
    setFocusTo(toStatus ? 'status' : id);
  };

  return {
    busy: running !== null,
    running: running?.id ?? null,
    looping: running?.loop ? running.id : null,
    said,
    say: setSaid,
    notice,
    run,
    stop,
    button,
    buttonOf: (id: string) => buttons.current.get(id),
    status,
  };
}

export type StepRunner = ReturnType<typeof useStepRunner>;
