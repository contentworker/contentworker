import { SkeletonPill } from '@contentworker/ui/skeleton';
import { useId, useState } from 'react';
import { useClient } from '~/cms/lib/client-context';
import {
  ApiError,
  type MigrationPublishTarget,
  type MigrationRunView,
  refusedSave,
} from '~/cms/lib/management';
import { driverRefusal, type MigrationRights, type StepState } from '~/cms/lib/migrations';
import { PublishPlan } from './PublishPlan';
import { RunnerStatus } from './RunnerParts';
import { StepButton, Why } from './step-parts';
import { useStepRunner } from './use-step-runner';

/**
 * The whole run in the background: start it, and later the go-ahead to publish. The API doesn't say
 * whether a run has a driver, so both are offered while the run can take them and the answer is said
 * in words (already running, finished, never started, not set up here).
 */
export function RunBackground({
  view,
  rights,
  refresh,
  onStarted,
}: {
  view: MigrationRunView;
  rights: MigrationRights | undefined;
  refresh: () => Promise<MigrationRunView | undefined>;
  /** Its driver is running: the page follows it. */
  onStarted: () => void;
}) {
  const { client } = useClient();
  const id = useId();
  const { run } = view;
  const runner = useStepRunner(refresh);
  const [asking, setAsking] = useState<number | null>(null);
  // The driver takes one go-ahead, the first: once one was sent (or may have been), another can't
  // replace it, so none is offered as if it could.
  const [sent, setSent] = useState<{ target: MigrationPublishTarget; sure: boolean } | null>(null);
  const step: StepState =
    run.status === 'stopped'
      ? {
          available: false,
          reason:
            'Its background run stopped, so it can’t be started or told anything again. Take it on step by step here.',
        }
      : run.status === 'failed'
        ? { available: false, reason: 'The run failed, so it can’t go on in the background.' }
        : { available: true };

  const start = () =>
    runner.run(
      'start',
      { title: 'The background run didn’t start', explain: driverRefusal },
      async () => {
        const { started } = await client.startMigrationRun(run.id);
        onStarted();
        return {
          line: started
            ? 'Started. It pauses for each template’s approval and for the go-ahead to publish.'
            : 'It was already running in the background.',
        };
      },
    );

  const goAhead = (target: MigrationPublishTarget) => {
    setAsking(null);
    return runner.run(
      'go-ahead',
      {
        title: 'The go-ahead wasn’t taken',
        explain: (err) =>
          refusedSave(err) || (err instanceof ApiError && err.status === 501)
            ? driverRefusal(err)
            : 'It didn’t answer, so the go-ahead may have been taken. Another can’t replace it.',
        focusStatus: true,
      },
      async () => {
        try {
          await client.approveMigrationPublish(run.id, target);
        } catch (err) {
          if (!refusedSave(err) && !(err instanceof ApiError && err.status === 501))
            setSent({ target, sure: false });
          throw err;
        }
        setSent({ target, sure: true });
        onStarted();
        return {
          line: target.viaRelease
            ? 'Go-ahead given. It adds its entries to the release once its pages are loaded.'
            : 'Go-ahead given. It publishes as you once its pages are loaded.',
        };
      },
    );
  };

  /** Read as it is asked: a run that ended meanwhile has nothing to tell. */
  const ask = () =>
    void runner.run('go-ahead', { title: 'The run couldn’t be read' }, async () => {
      const v = await refresh();
      if (!v) throw new Error('The run couldn’t be read again, so nothing was asked. Try again.');
      if (v.run.status !== 'stopped' && v.run.status !== 'failed')
        setAsking(v.pages.byStage.loaded ?? 0);
      return { line: '' };
    });

  const lacks = rights
    ? [
        rights.run ? '' : 'Starting it takes migration:run.',
        rights.publish ? '' : 'The go-ahead to publish takes content:publish.',
      ].filter(Boolean)
    : [];

  return (
    <div className="space-y-3">
      <p className="max-w-measure text-muted-foreground text-sm">
        Start drives the whole run for you in the background, as you, and pauses for each template’s
        approval and for the go-ahead to publish.
      </p>
      <RunnerStatus runner={runner} />
      <div className="flex flex-wrap items-center gap-2 touch:gap-5">
        {rights === undefined ? (
          <SkeletonPill aria-hidden="true" />
        ) : (
          <>
            {rights.run ? (
              <StepButton
                ref={runner.button('start')}
                step={step}
                busy={runner.busy}
                doing={runner.running === 'start'}
                describedBy={`${id}-why`}
                label="Start"
                doingLabel="Starting…"
                onClick={() => void start()}
              />
            ) : null}
            {rights.publish && !sent?.sure ? (
              <StepButton
                ref={runner.button('go-ahead')}
                step={step}
                busy={runner.busy || asking !== null}
                doing={runner.running === 'go-ahead'}
                describedBy={`${id}-why`}
                label={sent ? 'Send the go-ahead again…' : 'Give the go-ahead to publish…'}
                doingLabel="Telling it…"
                onClick={ask}
              />
            ) : null}
          </>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        <Why
          id={`${id}-why`}
          step={step}
          show={rights !== undefined && (rights.run || rights.publish)}
        />
      </p>
      {asking !== null && step.available ? (
        <PublishPlan
          run={run}
          entries={asking}
          // One that may have been taken is sent again as it was, never as something else.
          fixed={sent !== null}
          initial={sent?.target ?? {}}
          returnFocus={() => runner.buttonOf('go-ahead')}
          driven
          viaRelease={rights?.publishViaRelease === true}
          onCancel={() => setAsking(null)}
          onConfirm={(t) => void goAhead(t)}
        />
      ) : null}
      {lacks.length > 0 ? <p className="text-muted-foreground text-xs">{lacks.join(' ')}</p> : null}
    </div>
  );
}
