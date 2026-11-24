import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import type { StepState } from '~/cms/lib/migrations';

/** Held while another step runs: drawn as waiting, so a press that does nothing never looks live. */
export const HELD = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

/** A step's button: disabled, with its reason, when the run can't take it; held while one runs. */
export function StepButton({
  ref,
  step,
  primary,
  busy,
  doing,
  describedBy,
  label,
  doingLabel,
  onClick,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  step: StepState;
  primary?: boolean;
  busy: boolean;
  doing?: boolean;
  describedBy: string;
  label: string;
  doingLabel?: string;
  onClick: () => void;
}) {
  return (
    <Button
      ref={ref}
      type="button"
      size="sm"
      variant={primary ? 'default' : 'outline'}
      disabled={!step.available}
      // Held, not disabled, while a step runs: the one pressed keeps focus.
      aria-disabled={busy || undefined}
      className={HELD}
      aria-describedby={step.available ? undefined : describedBy}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {doing && doingLabel ? doingLabel : label}
    </Button>
  );
}

/** Why a step waits, under its description; nothing while it can run. */
export function Why({ id, step, show }: { id: string; step: StepState; show: boolean }) {
  if (!show || step.available || !step.reason) return null;
  return (
    <span id={id} className="w-full">
      {step.reason}
    </span>
  );
}

/**
 * What stopped a step. A site that can't be read now is no fault of the run: a plain Alert, calm,
 * with Try again. Anything else is a destructive Alert, with Try again only where trying again can
 * change the answer.
 */
export function StepNotice({
  tone = 'bad',
  title,
  busy = false,
  onRetry,
  retryLabel = 'Try again',
  children,
}: {
  tone?: 'calm' | 'bad';
  title: string;
  busy?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <Alert variant={tone === 'calm' ? 'default' : 'destructive'}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p className="wrap-anywhere">{children}</p>
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`mt-2 ${HELD}`}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onRetry();
            }}
          >
            {retryLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** A reason as a sentence, with one full stop and a space after it; nothing when there's none. */
export const sentence = (reason: string) => {
  const r = reason.trim();
  return r ? `${/[.!?]$/.test(r) ? r : `${r}.`} ` : '';
};
