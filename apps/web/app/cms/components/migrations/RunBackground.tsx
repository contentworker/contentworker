import { holdsScope, SCOPES } from '@contentworker/domain';
import { focusIsAdrift } from '@contentworker/ui/lib/focus-return';
import { SkeletonPill } from '@contentworker/ui/skeleton';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { ToneBadge } from '~/cms/components/status';
import { useClient } from '~/cms/lib/client-context';
import type {
  MigrationDriver,
  MigrationPublishTarget,
  MigrationRunView,
} from '~/cms/lib/management';
import {
  DRIVER_STATE,
  driverOf,
  driverRefusal,
  type MigrationRights,
  mayHear,
  migrationActorName,
  type StepState,
} from '~/cms/lib/migrations';
import { useScopedQuery } from '~/cms/lib/queries';
import { PublishPlan } from './PublishPlan';
import { RunnerStatus } from './RunnerParts';
import { StepButton } from './step-parts';
import { stepFailure, useStepRunner } from './use-step-runner';

const GIVEN_MEANWHILE = 'A go-ahead was given meanwhile, so nothing was asked.';
const ENDED_MEANWHILE = 'The background run ended meanwhile, so nothing was asked.';

/** Offered only while it applies, so its button is never drawn disabled. */
const OFFERED: StepState = { available: true };

/**
 * The whole run in the background: where its driver is and who started it, the go-ahead to publish
 * and who gave it for what, and what applies next: starting it, giving the go-ahead, or sending one
 * of the person's own again when it isn't known to have arrived. All of it is the run's own read, so
 * it is the same after a reload and for whoever else is looking.
 */
export function RunBackground({
  view,
  rights,
  scopes,
  refresh,
}: {
  view: MigrationRunView;
  rights: MigrationRights | undefined;
  scopes: readonly string[] | undefined;
  refresh: () => Promise<MigrationRunView | undefined>;
}) {
  const { client } = useClient();
  const { run } = view;
  const driver = driverOf(view);
  const runner = useStepRunner(refresh);
  const [asking, setAsking] = useState<number | null>(null);
  const given = driver.goAhead.status === 'given' ? driver.goAhead : null;
  const startable =
    driver.state === 'none' || (driver.state === 'unknown' && driver.startedBy === null);
  const mine = given?.byYou && !given.delivered ? given : null;
  const offersGoAhead = mayHear(driver) && !given;
  const offersAgain = mayHear(driver) && mine !== null;

  // Given meanwhile (by someone else, or in another tab), the question has no answer left.
  const { status, say } = runner;
  const gone = given ? GIVEN_MEANWHILE : ENDED_MEANWHILE;
  useEffect(() => {
    if (asking === null || offersGoAhead) return;
    setAsking(null);
    say(gone);
    // Someone typing elsewhere keeps their place.
    if (focusIsAdrift()) status.current?.focus();
  }, [asking, offersGoAhead, gone, say, status]);

  const start = () =>
    runner.run(
      'start',
      // Its button goes once it has started, so focus goes to what is said of it.
      { title: 'The background run didn’t start', explain: driverRefusal, focusStatus: 'done' },
      async () => {
        const { started } = await client.startMigrationRun(run.id);
        return {
          line: started
            ? 'Started. It pauses for each template’s approval and for the go-ahead to publish.'
            : 'It was already running in the background.',
        };
      },
    );

  const goAhead = (target: MigrationPublishTarget, again: boolean) => {
    setAsking(null);
    return runner.run(
      'go-ahead',
      {
        title: 'The go-ahead wasn’t confirmed',
        // Sent again, its own button is what tries again; given, it is asked again.
        explain: (err) => driverRefusal(err) ?? (again ? stepFailure(err) : undefined),
        focusStatus: 'done',
        again: ask,
      },
      async () => {
        const { signalled } = await client.approveMigrationPublish(run.id, target);
        return {
          line:
            signalled === false
              ? 'Go-ahead recorded, but its background run couldn’t be reached. Send it again.'
              : target.viaRelease
                ? 'Go-ahead given. It adds its entries to the release once its pages are loaded.'
                : 'Go-ahead given. It publishes as you once its pages are loaded.',
        };
      },
    );
  };

  /** Read as it is asked: a run that ended, or was given one, meanwhile has nothing to be asked. */
  const ask = () =>
    void runner.run('go-ahead', { title: 'The run couldn’t be read' }, async () => {
      const v = await refresh();
      if (!v) throw new Error('The run couldn’t be read again, so nothing was asked. Try again.');
      const now = driverOf(v);
      if (now.goAhead.status === 'given') return { line: GIVEN_MEANWHILE };
      if (!mayHear(now)) return { line: ENDED_MEANWHILE };
      setAsking(v.pages.byStage.loaded ?? 0);
      return { line: '' };
    });

  const lacks = rights
    ? [
        startable && !rights.run ? 'Starting it takes migration:run.' : '',
        (offersGoAhead || offersAgain) && !rights.publish
          ? 'The go-ahead to publish takes content:publish.'
          : '',
      ].filter(Boolean)
    : [];

  return (
    <div className="flex flex-col gap-3">
      {startable ? (
        <p className="max-w-measure text-muted-foreground text-sm">
          Start drives the whole run for you in the background, as you, and pauses for each
          template’s approval and for the go-ahead to publish.
        </p>
      ) : null}
      <DriverFacts view={view} driver={driver} scopes={scopes} />
      <RunnerStatus runner={runner} />
      {startable || offersGoAhead || offersAgain ? (
        <div className="flex flex-wrap items-center gap-2 touch:gap-5">
          {rights === undefined ? (
            <SkeletonPill aria-hidden="true" />
          ) : (
            <>
              {startable && rights.run ? (
                <StepButton
                  ref={runner.button('start')}
                  step={OFFERED}
                  busy={runner.busy}
                  doing={runner.running === 'start'}
                  label="Start"
                  doingLabel="Starting…"
                  onClick={() => void start()}
                />
              ) : null}
              {offersGoAhead && rights.publish ? (
                <StepButton
                  ref={runner.button('go-ahead')}
                  step={OFFERED}
                  busy={runner.busy || asking !== null}
                  doing={runner.running === 'go-ahead'}
                  label="Give the go-ahead to publish…"
                  doingLabel="Working…"
                  onClick={ask}
                />
              ) : null}
              {offersAgain && mine && rights.publish ? (
                <StepButton
                  ref={runner.button('go-ahead')}
                  step={OFFERED}
                  busy={runner.busy}
                  doing={runner.running === 'go-ahead'}
                  label="Send the go-ahead again"
                  doingLabel="Telling it…"
                  // The one on record, as it was: confirmed when it was given.
                  onClick={() => void goAhead(targetOf(mine), true)}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {asking !== null && offersGoAhead ? (
        <PublishPlan
          run={run}
          entries={asking}
          initial={{}}
          returnFocus={() => runner.buttonOf('go-ahead')}
          driven
          viaRelease={rights?.publishViaRelease === true}
          onCancel={() => setAsking(null)}
          onConfirm={(t) => void goAhead(t, false)}
        />
      ) : null}
      {lacks.length > 0 ? <p className="text-muted-foreground text-xs">{lacks.join(' ')}</p> : null}
    </div>
  );
}

const targetOf = (t: MigrationPublishTarget): MigrationPublishTarget => ({
  ...(t.viaRelease ? { viaRelease: true } : {}),
  ...(t.releaseId ? { releaseId: t.releaseId } : {}),
  ...(t.releaseTitle ? { releaseTitle: t.releaseTitle } : {}),
});

/** Where it is, who started it and when, and its go-ahead: only what is known, and what isn't. */
function DriverFacts({
  view,
  driver,
  scopes,
}: {
  view: MigrationRunView;
  driver: MigrationDriver;
  scopes: readonly string[] | undefined;
}) {
  const { client } = useClient();
  const { startedBy, startedAt, goAhead } = driver;
  // Names are the team's, which only an administrator of the space may read.
  const named = startedBy !== null || goAhead.status === 'given';
  const team = useScopedQuery(['team'], () => client.getTeam(), {
    silent: true,
    enabled: named && scopes !== undefined && holdsScope(scopes, SCOPES.spaceAdmin),
  }).data;
  const state = DRIVER_STATE[driver.state];
  const says =
    view.run.status === 'failed'
      ? 'The run failed, so it can’t go on in the background.'
      : driver.state === 'waiting' && goAhead.status === 'given'
        ? 'For a template’s approval, or the source site.'
        : state.says;
  const releaseId =
    goAhead.status === 'given' && goAhead.viaRelease
      ? (goAhead.releaseId ?? view.run.releaseId)
      : null;
  return (
    <dl className="grid max-w-measure grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-2 text-sm">
      <dt className="caption">State</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ToneBadge tone={state.tone} label={state.label} />
        {says ? <span className="text-muted-foreground">{says}</span> : null}
      </dd>
      {startedBy ? (
        <>
          <dt className="caption">Started</dt>
          <dd className="min-w-0 wrap-anywhere">
            <Ago at={startedAt} /> by {migrationActorName(startedBy, driver.startedByYou, team)}
          </dd>
        </>
      ) : driver.state === 'none' || driver.state === 'unknown' ? null : (
        <>
          <dt className="caption">Started</dt>
          <dd className="text-muted-foreground">Who started it, and when, wasn’t recorded.</dd>
        </>
      )}
      {goAhead.status === 'given' ? (
        <>
          <dt className="caption">Go-ahead</dt>
          <dd className="min-w-0 wrap-anywhere">
            Given <Ago at={goAhead.approvedAt} /> by{' '}
            {migrationActorName(goAhead.approvedBy, goAhead.byYou, team)},{' '}
            {goAhead.viaRelease
              ? goAhead.releaseTitle
                ? `to add its entries to a release, “${goAhead.releaseTitle}”`
                : 'to add its entries to a release'
              : 'to publish its entries'}
            .{' '}
            {releaseId ? (
              <Link
                to={`/releases?release=${encodeURIComponent(releaseId)}`}
                className="hit-area text-link hover:underline"
              >
                Open the release
              </Link>
            ) : null}
            {goAhead.delivered ? null : (
              <span className="block text-muted-foreground">
                It isn’t known to have reached the background run.
              </span>
            )}
          </dd>
        </>
      ) : goAhead.status === 'unknown' && mayHear(driver) ? (
        <>
          <dt className="caption">Go-ahead</dt>
          <dd className="text-muted-foreground">
            Not known. One given before go-aheads were recorded stands, and another won’t replace
            it.
          </dd>
        </>
      ) : driver.startedBy && mayHear(driver) ? (
        <>
          <dt className="caption">Go-ahead</dt>
          <dd className="text-muted-foreground">Not given yet.</dd>
        </>
      ) : null}
    </dl>
  );
}
