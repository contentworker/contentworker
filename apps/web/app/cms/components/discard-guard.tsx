import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';

export interface DiscardGuard {
  /** Hand this to the Dialog or Sheet, and call it for Cancel: every way out goes through it. */
  readonly onOpenChange: (open: boolean) => void;
  readonly asking: boolean;
  /** A save is under way, so there is nothing to discard and no way to leave yet. */
  readonly saving: boolean;
  /** Someone tried to leave during that save, and is told why nothing happened. */
  readonly waiting: boolean;
  readonly keep: () => void;
  readonly discard: () => void;
}

/**
 * Keeps a dirty form from going with a stray press outside it, Escape, the close button or Cancel.
 * All of them reach `onOpenChange(false)`, so that is the one place that asks; {@link DiscardAsk}
 * asks in place of the form's buttons. A successful save closes through the caller's own
 * `onOpenChange`, which doesn't ask.
 *
 * During a save there is no question to ask: it has been sent, and "Nothing has been saved" would
 * be untrue. The form holds, {@link GuardCancel} is disabled, and a try at leaving says so. Only a
 * save holds it: a read (a dry run, a fetch to inspect) stays closable, so leave it out of `saving`.
 */
export function useDiscardGuard({
  open = true,
  dirty,
  saving = false,
  onOpenChange,
}: {
  open?: boolean;
  dirty: boolean;
  /** This form's own write in flight. */
  saving?: boolean;
  onOpenChange: (open: boolean) => void;
}): DiscardGuard {
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!saving) setWaiting(false);
  }, [saving]);
  // A save that lands while the question is up answers it.
  useEffect(() => {
    if (!open || !dirty) setAsking(false);
  }, [open, dirty]);
  return {
    onOpenChange: (next) => {
      if (!next && saving) setWaiting(true);
      else if (!next && dirty) setAsking(true);
      else onOpenChange(next);
    },
    asking,
    saving,
    waiting: waiting && saving,
    keep: () => setAsking(false),
    discard: () => {
      setAsking(false);
      onOpenChange(false);
    },
  };
}

/** What a person was editing, in the dialog or sheet around `slot`. */
function useLastField(slot: RefObject<HTMLElement | null>) {
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const holder = slot.current?.closest('[role="dialog"]');
    const note = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.matches(FIELD)) {
        last.current = event.target;
      }
    };
    holder?.addEventListener('focusin', note);
    return () => holder?.removeEventListener('focusin', note);
  }, [slot]);
  return last;
}

const FIELD =
  'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"]';

/** The form's buttons, or while {@link useDiscardGuard} asks, the question in their place. */
export function DiscardAsk({
  guard,
  message,
  note = 'Nothing has been saved.',
  children,
}: {
  guard: DiscardGuard;
  /** The question, naming what goes: "Discard this content type?" */
  message: ReactNode;
  /** What is at stake, when part of the form has been saved. */
  note?: ReactNode;
  children: ReactNode;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  const field = useLastField(slot);
  return (
    <span ref={slot} className={cn(guard.asking ? 'block w-full min-w-0' : 'contents')}>
      {guard.asking ? (
        <InlineConfirm
          message={message}
          note={note}
          cancelLabel="Keep editing"
          onCancel={() => {
            // Keep editing means the field, wherever the asking came from.
            if (field.current?.isConnected) field.current.focus();
            guard.keep();
          }}
          // The buttons it stood in for are new ones by then.
          returnFocus={() => slot.current?.querySelector('button')}
        >
          <Button type="button" size="sm" variant="destructive" onClick={guard.discard}>
            Discard
          </Button>
        </InlineConfirm>
      ) : (
        <>
          {guard.waiting ? (
            <span role="status" className="mr-auto self-center text-muted-foreground text-ui">
              Still saving. This closes when it’s done.
            </span>
          ) : null}
          {children}
        </>
      )}
    </span>
  );
}

/** The form's Cancel: it goes through the guard, and waits while a save is under way. */
export function GuardCancel({ guard }: { guard: DiscardGuard }) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={guard.saving}
      onClick={() => guard.onOpenChange(false)}
    >
      Cancel
    </Button>
  );
}
