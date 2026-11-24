import { Button } from '@contentworker/ui/button';
import type { StepState } from '~/cms/lib/migrations';
import { StepButton, StepNotice } from './step-parts';
import type { StepRunner } from './use-step-runner';

/** Said of a loop that was stopped with a batch in flight. */
export const STOPPED = 'A batch under way may still finish; the counts show what it did.';

/** What the last step did, or how far one has got, and what stopped it. */
export function RunnerStatus({ runner }: { runner: StepRunner }) {
  return (
    <>
      {runner.notice ? (
        <StepNotice
          title={runner.notice.title}
          busy={runner.busy}
          {...(runner.notice.retry ? { onRetry: runner.notice.retry } : {})}
        >
          {runner.notice.message}
        </StepNotice>
      ) : null}
      <p
        ref={runner.status}
        tabIndex={-1}
        role="status"
        className="min-h-4 text-muted-foreground text-xs outline-none wrap-anywhere"
      >
        {runner.said}
      </p>
    </>
  );
}

/** A looping step's Stop, in its button's place while it runs. */
export function StopButton({ runner }: { runner: StepRunner }) {
  return (
    <Button
      ref={runner.button('stop')}
      type="button"
      size="sm"
      variant="outline"
      onClick={runner.stop}
    >
      Stop
    </Button>
  );
}

/** One bounded batch, or batch after batch until done (then a Stop). */
export function LoopButtons({
  runner,
  id,
  step,
  label,
  loopLabel,
  doing,
  describedBy,
  onOnce,
  onLoop,
}: {
  runner: StepRunner;
  id: string;
  step: StepState;
  label: string;
  loopLabel: string;
  doing: string;
  describedBy: string;
  onOnce: () => void;
  onLoop: () => void;
}) {
  if (runner.looping === `${id}-loop`) return <StopButton runner={runner} />;
  return (
    <div className="flex flex-wrap justify-end gap-2 touch:gap-5">
      <StepButton
        ref={runner.button(id)}
        step={step}
        busy={runner.busy}
        doing={runner.running === id}
        describedBy={describedBy}
        label={label}
        doingLabel={doing}
        onClick={onOnce}
      />
      <StepButton
        ref={runner.button(`${id}-loop`)}
        step={step}
        busy={runner.busy}
        describedBy={describedBy}
        label={loopLabel}
        onClick={onLoop}
      />
    </div>
  );
}
