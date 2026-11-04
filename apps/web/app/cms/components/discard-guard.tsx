import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';

export interface DiscardGuard {
  /** Hand this to the Dialog or Sheet, and call it for Cancel: every way out goes through it. */
  readonly onOpenChange: (open: boolean) => void;
  readonly asking: boolean;
  readonly keep: () => void;
  readonly discard: () => void;
}

/**
 * Keeps a dirty form from going with a stray press outside it, Escape, the close button or Cancel.
 * All of them reach `onOpenChange(false)`, so that is the one place that asks; {@link DiscardAsk}
 * asks in place of the form's buttons. A successful save closes through the caller's own
 * `onOpenChange`, which doesn't ask.
 */
export function useDiscardGuard({
  open = true,
  dirty,
  busy = false,
  onOpenChange,
}: {
  open?: boolean;
  dirty: boolean;
  /** A save under way: nothing can be discarded now, so the form waits for it to settle. */
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
}): DiscardGuard {
  const [asking, setAsking] = useState(false);
  // A save that lands while the question is up answers it.
  useEffect(() => {
    if (!open || !dirty) setAsking(false);
  }, [open, dirty]);
  return {
    onOpenChange: (next) => {
      if (!next && busy) return;
      if (!next && dirty) setAsking(true);
      else onOpenChange(next);
    },
    asking,
    keep: () => setAsking(false),
    discard: () => {
      setAsking(false);
      onOpenChange(false);
    },
  };
}

/** The form's buttons, or while {@link useDiscardGuard} asks, the question in their place. */
export function DiscardAsk({
  guard,
  message,
  children,
}: {
  guard: DiscardGuard;
  /** The question, naming what goes: "Discard this content type?" */
  message: ReactNode;
  children: ReactNode;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  return (
    <span ref={slot} className={cn(guard.asking ? 'block w-full min-w-0' : 'contents')}>
      {guard.asking ? (
        <InlineConfirm
          message={message}
          note="Nothing has been saved."
          cancelLabel="Keep editing"
          onCancel={guard.keep}
          // The buttons it stood in for are new ones by then.
          returnFocus={() => slot.current?.querySelector('button')}
        >
          <Button type="button" size="sm" variant="destructive" onClick={guard.discard}>
            Discard
          </Button>
        </InlineConfirm>
      ) : (
        children
      )}
    </span>
  );
}
