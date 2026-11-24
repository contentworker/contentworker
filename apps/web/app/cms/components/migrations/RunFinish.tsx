import { Catalog, CatalogFigure, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { SkeletonPill } from '@contentworker/ui/skeleton';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useClient } from '~/cms/lib/client-context';
import { count, plural } from '~/cms/lib/format';
import type {
  MigrationPublishTarget,
  MigrationRedirectsResult,
  MigrationRunView,
} from '~/cms/lib/management';
import {
  addFailures,
  batchUntilDone,
  type Failures,
  type MigrationRights,
  NO_FAILURES,
  PUBLISH_BATCH,
  RELINK_BATCH,
  type StepState,
} from '~/cms/lib/migrations';
import { useInvalidate } from '~/cms/lib/queries';
import { FailureList } from './FailureList';
import { PublishPlan } from './PublishPlan';
import { RunnerStatus, STOPPED, StopButton } from './RunnerParts';
import { StepButton, Why } from './step-parts';
import { useStepRunner } from './use-step-runner';

const NO_RELINKS = { checked: 0, relinked: 0, unresolvedLinks: 0, skipped: NO_FAILURES };
const NOT_PUBLISHED = {
  published: 0,
  added: 0,
  releaseId: undefined as string | undefined,
  failed: NO_FAILURES,
};

/**
 * A run's last steps, over every template's loaded pages: point their links at each other, redirect
 * their old addresses, and publish. Relinking and publishing go batch after batch with a Stop;
 * publishing only ever follows its own confirmation, on the page.
 */
export function RunFinish({
  view,
  rights,
  refresh,
}: {
  view: MigrationRunView;
  rights: MigrationRights | undefined;
  refresh: () => Promise<MigrationRunView | undefined>;
}) {
  const { client } = useClient();
  const invalidate = useInvalidate();
  const id = useId();
  const { run, pages } = view;
  const runner = useStepRunner(refresh);
  const [relink, setRelink] = useState<Failures>(NO_FAILURES);
  const [redirects, setRedirects] = useState<MigrationRedirectsResult | null>(null);
  const [publish, setPublish] = useState(NOT_PUBLISHED);
  // The number asked about; what is published never goes past it.
  const [asking, setAsking] = useState<number | null>(null);
  // A publish asked again after a failure starts from the answer given before.
  const last = useRef<MigrationPublishTarget>({});
  const loaded = pages.byStage.loaded ?? 0;
  const taken = loaded + (pages.byStage.published ?? 0);
  const relinkStep: StepState = loaded
    ? { available: true }
    : { available: false, reason: 'No loaded pages are waiting. Load a template’s pages first.' };
  const redirectStep: StepState = taken
    ? { available: true }
    : { available: false, reason: 'No pages are loaded yet.' };
  const publishStep: StepState = loaded
    ? { available: true }
    : { available: false, reason: 'No loaded entries are waiting to be published.' };

  const doRelink = () =>
    runner.run('relink', { title: 'Relinking stopped', loop: true }, async (signal) => {
      setRelink(NO_FAILURES);
      const outcome = await batchUntilDone(
        (after, s) =>
          client.relinkMigrationPages(
            run.id,
            { limit: RELINK_BATCH, ...(after ? { after } : {}) },
            s,
          ),
        {
          signal,
          start: NO_RELINKS,
          add: (a, r) => ({
            checked: a.checked + r.checked,
            relinked: a.relinked + r.relinked,
            unresolvedLinks: a.unresolvedLinks + r.unresolvedLinks,
            skipped: addFailures(a.skipped, r.skipped),
          }),
          next: (r) => ({ more: r.next !== undefined, after: r.next }),
          onBatch: (t) => {
            setRelink(t.skipped);
            runner.say(relinkLine(t));
          },
        },
      );
      const line = relinkLine(outcome.totals);
      return {
        line:
          outcome.kind === 'stopped'
            ? `Stopped. ${line} ${STOPPED}`
            : outcome.kind === 'stalled'
              ? `${line} The batches stopped moving on, so it stopped before the end.`
              : line,
        ...(outcome.kind === 'failed' ? { error: outcome.error } : {}),
      };
    });

  const doRedirects = () =>
    runner.run('redirects', { title: 'The redirects weren’t written' }, async (signal) => {
      setRedirects(null);
      const r = await client.importMigrationRedirects(run.id, signal);
      setRedirects(r);
      await invalidate(['redirects']);
      return {
        line: `Redirects: ${count(r.created)} created, ${count(r.updated)} updated, ${count(r.unchanged)} unchanged.`,
      };
    });

  /** The count in the question is read as it is asked. */
  const ask = () =>
    void runner.run('publish', { title: 'The count couldn’t be read' }, async () => {
      const v = await refresh();
      if (!v) throw new Error('The run couldn’t be read again, so nothing was asked. Try again.');
      if (!v.pages.byStage.loaded) return { line: 'No loaded entries are waiting.' };
      setAsking(v.pages.byStage.loaded);
      return { line: '' };
    });
  const doPublish = (target: MigrationPublishTarget, most: number) => {
    setAsking(null);
    last.current = target;
    return runner.run(
      'publish',
      {
        title: target.viaRelease ? 'Adding to the release stopped' : 'Publishing stopped',
        loop: true,
        focusStatus: true,
        again: () => ask(),
      },
      async (signal) => {
        setPublish(NOT_PUBLISHED);
        let left = most;
        let over = false;
        // A new release is made once: the batches after the first name the one it answered.
        let into = target;
        const outcome = await batchUntilDone(
          (after, s) =>
            client.publishMigrationPages(
              run.id,
              { ...into, limit: Math.min(PUBLISH_BATCH, left), ...(after ? { after } : {}) },
              s,
            ),
          {
            signal,
            start: NOT_PUBLISHED,
            add: (a, r) => ({
              published: a.published + r.published,
              added: a.added + r.added,
              releaseId: r.releaseId ?? a.releaseId,
              failed: addFailures(a.failed, r.failed),
            }),
            next: (r) => {
              if (r.releaseId) into = { viaRelease: true, releaseId: r.releaseId };
              left -= r.published + r.added + r.failed.length;
              // Pages loaded since the question weren't in it.
              over = left <= 0 && r.next !== undefined;
              return { more: r.next !== undefined && left > 0, after: r.next };
            },
            onBatch: (t) => {
              setPublish(t);
              runner.say(publishLine(t, target));
            },
          },
        );
        await invalidate(['entries'], ['entry'], ['releases'], ['release']);
        const line = over
          ? `${publishLine(outcome.totals, target)} Any more were loaded since: publish again for those.`
          : publishLine(outcome.totals, target);
        return {
          line:
            outcome.kind === 'stopped'
              ? `Stopped. ${line} ${STOPPED}`
              : outcome.kind === 'stalled'
                ? `${line} The batches stopped moving on, so it stopped before the end.`
                : line,
          ...(outcome.kind === 'failed' ? { error: outcome.error } : {}),
        };
      },
    );
  };

  const releaseId = publish.releaseId ?? run.releaseId;
  const lacks = rights
    ? [
        rights.relink ? '' : 'Relinking takes migration:run and content:write.',
        rights.manage ? '' : 'Redirects take content:manage.',
        rights.publish ? '' : 'Publishing takes content:publish.',
      ].filter(Boolean)
    : [];
  const skipped = redirects?.skipped;

  return (
    <div className="space-y-3">
      <Catalog aria-label="Finish the run" className="p-0">
        <CatalogRow
          media={<CatalogTile aria-hidden="true">1</CatalogTile>}
          title={<h3 className="font-medium">Relink</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                Points links between loaded pages at the entries they became. Do it once every
                template is loaded, before publishing: published pages aren’t relinked.
              </span>
              <Why id={`${id}-relink`} step={relinkStep} show={rights?.relink === true} />
            </span>
          }
          actions={
            rights === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : rights.relink ? (
              runner.looping === 'relink' ? (
                <StopButton runner={runner} />
              ) : (
                <StepButton
                  ref={runner.button('relink')}
                  step={relinkStep}
                  busy={runner.busy}
                  describedBy={`${id}-relink`}
                  label="Relink"
                  onClick={() => void doRelink()}
                />
              )
            ) : null
          }
        />
        <CatalogRow
          media={<CatalogTile aria-hidden="true">2</CatalogTile>}
          title={<h3 className="font-medium">Redirects</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                A permanent redirect (301) from each loaded page’s old path to its entry’s. Safe to
                repeat.
              </span>
              {redirects && skipped ? (
                <span className="w-full">
                  {[
                    `${count(redirects.created)} created`,
                    `${count(redirects.updated)} updated`,
                    `${count(redirects.unchanged)} unchanged`,
                    skipped.identity
                      ? `${count(skipped.identity)} skipped: the path didn’t move`
                      : '',
                    skipped.noUrlPattern
                      ? `${count(skipped.noUrlPattern)} skipped: the type has no URL pattern`
                      : '',
                    skipped.unresolved
                      ? `${count(skipped.unresolved)} skipped: no path could be made for the entry`
                      : '',
                    redirects.chains.length
                      ? `${plural(redirects.chains.length, 'redirect')} now ${redirects.chains.length === 1 ? 'leads' : 'lead'} to another redirect`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : null}
              <Why id={`${id}-redirects`} step={redirectStep} show={rights?.manage === true} />
            </span>
          }
          actions={
            rights === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : rights.manage ? (
              <StepButton
                ref={runner.button('redirects')}
                step={redirectStep}
                busy={runner.busy}
                doing={runner.running === 'redirects'}
                describedBy={`${id}-redirects`}
                label="Write redirects"
                doingLabel="Writing…"
                onClick={() => void doRedirects()}
              />
            ) : null
          }
        />
        <CatalogRow
          media={<CatalogTile aria-hidden="true">3</CatalogTile>}
          title={<h3 className="font-medium">Publish</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                Publishes the loaded entries, {PUBLISH_BATCH} a request, or adds them to a release.
                Entries a release ships read as published here after the next publish. If this run
                is in the background, give it the go-ahead below instead.
              </span>
              {releaseId ? (
                <span className="w-full">
                  <Link
                    to={`/releases?release=${encodeURIComponent(releaseId)}`}
                    className="hit-area text-link hover:underline"
                  >
                    Open the release
                  </Link>
                </span>
              ) : null}
              <Why id={`${id}-publish`} step={publishStep} show={rights?.publish === true} />
            </span>
          }
          aside={<CatalogFigure label="Loaded">{count(loaded)}</CatalogFigure>}
          actions={
            rights === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : rights.publish ? (
              runner.looping === 'publish' ? (
                <StopButton runner={runner} />
              ) : (
                <StepButton
                  ref={runner.button('publish')}
                  step={publishStep}
                  busy={runner.busy || asking !== null}
                  describedBy={`${id}-publish`}
                  label="Publish…"
                  onClick={ask}
                />
              )
            ) : null
          }
        />
      </Catalog>
      <RunnerStatus runner={runner} />
      {asking !== null ? (
        <PublishPlan
          run={run}
          entries={asking}
          initial={last.current}
          returnFocus={() => runner.buttonOf('publish')}
          viaRelease={rights?.publishViaRelease === true}
          onCancel={() => setAsking(null)}
          onConfirm={(t) => void doPublish(t, asking)}
        />
      ) : null}
      <FailureList title="Entries edited since, not relinked" failures={relink} />
      <FailureList title="Entries not published" failures={publish.failed} />
      {lacks.length > 0 ? <p className="text-muted-foreground text-xs">{lacks.join(' ')}</p> : null}
    </div>
  );
}

const relinkLine = (t: typeof NO_RELINKS) =>
  t.checked === 0
    ? 'No loaded entries to relink.'
    : `Relinked ${plural(t.relinked, 'entry', 'entries')} of ${count(t.checked)} read; ${
        t.unresolvedLinks
          ? `${plural(t.unresolvedLinks, 'link')} still to pages with no entry.`
          : 'every link has its entry.'
      }`;

const publishLine = (
  t: { published: number; added: number; failed: Failures },
  target: MigrationPublishTarget,
) =>
  (target.viaRelease
    ? `Added ${plural(t.added, 'entry', 'entries')} to the release`
    : `Published ${plural(t.published, 'entry', 'entries')}`) +
  (t.failed.total ? `; ${count(t.failed.total)} failed.` : '.');
