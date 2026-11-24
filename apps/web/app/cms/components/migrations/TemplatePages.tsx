import { Catalog, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Label } from '@contentworker/ui/label';
import { SkeletonPill } from '@contentworker/ui/skeleton';
import { useId, useRef, useState } from 'react';
import { useClient } from '~/cms/lib/client-context';
import { plural } from '~/cms/lib/format';
import type { MigrationTemplateView } from '~/cms/lib/management';
import {
  addFailures,
  batchUntilDone,
  type Failures,
  LOAD_BATCH,
  type MigrationRights,
  NO_FAILURES,
  type StepState,
  TRANSFORM_BATCH,
} from '~/cms/lib/migrations';
import { FailureList } from './FailureList';
import { LoopButtons, RunnerStatus, STOPPED } from './RunnerParts';
import { Why } from './step-parts';
import { useStepRunner } from './use-step-runner';

const NOTHING = { transformed: 0, validated: 0, needsFix: 0, failed: NO_FAILURES };
const NONE_LOADED = {
  loaded: 0,
  unresolvedLinks: 0,
  failed: NO_FAILURES,
  assetFailures: NO_FAILURES,
  deferred: NO_FAILURES,
};

/**
 * An approved template's pages: transformed by its script, then loaded as entries, each a bounded
 * batch a request, or batch after batch until done (with Stop). What a step couldn't take is listed
 * under it. Nothing here publishes: the entries a load makes are drafts.
 */
export function TemplatePages({
  template: t,
  rights,
  reload,
}: {
  template: MigrationTemplateView;
  rights: MigrationRights | undefined;
  reload: () => Promise<unknown>;
}) {
  const { client } = useClient();
  const id = useId();
  const runner = useStepRunner(reload);
  const [needsFix, setNeedsFix] = useState(false);
  const [failed, setFailed] = useState<Failures>(NO_FAILURES);
  const [load, setLoad] = useState(NONE_LOADED);
  // Where the last single transform left off, so the next one goes on from there.
  const cursor = useRef<string | undefined>(undefined);
  const step: StepState =
    t.status === 'approved'
      ? { available: true }
      : { available: false, reason: 'Approve the template first.' };

  const transform = (loop: boolean) =>
    runner.run(
      loop ? 'transform-loop' : 'transform',
      { title: 'Transforming stopped', loop },
      async (signal) => {
        setFailed(NO_FAILURES);
        if (loop) cursor.current = undefined;
        const outcome = await batchUntilDone(
          (after, s) =>
            client.transformMigrationPages(
              t.runId,
              t.id,
              { limit: TRANSFORM_BATCH, ...(after ? { after } : {}) },
              s,
            ),
          {
            signal,
            from: cursor.current,
            start: NOTHING,
            add: (a, r) => ({
              transformed: a.transformed + r.transformed,
              validated: a.validated + r.validated,
              needsFix: a.needsFix + r.needsFix,
              failed: addFailures(a.failed, r.failed),
            }),
            next: (r) => {
              if (!loop) cursor.current = r.more ? r.next : undefined;
              return { more: loop && r.more, after: r.next };
            },
            onBatch: (totals) => {
              setFailed(totals.failed);
              if (loop) runner.say(transformLine(totals));
            },
          },
        );
        const line = transformLine(outcome.totals);
        return {
          line:
            outcome.kind === 'stopped'
              ? `Stopped. ${line} ${STOPPED}`
              : outcome.kind === 'stalled'
                ? `${line} The batches stopped moving on, so it stopped.`
                : outcome.kind === 'done' && !loop && cursor.current
                  ? `${line} More pages follow.`
                  : line,
          ...(outcome.kind === 'failed' ? { error: outcome.error } : {}),
        };
      },
    );

  const loadPages = (loop: boolean) =>
    runner.run(loop ? 'load-loop' : 'load', { title: 'Loading stopped', loop }, async (signal) => {
      setLoad(NONE_LOADED);
      let more = false;
      const outcome = await batchUntilDone(
        (_after, s) =>
          client.loadMigrationPages(
            t.runId,
            t.id,
            { limit: LOAD_BATCH, ...(needsFix ? { includeNeedsFix: true } : {}) },
            s,
          ),
        {
          signal,
          start: NONE_LOADED,
          add: (a, r) => ({
            loaded: a.loaded + r.loaded,
            unresolvedLinks: a.unresolvedLinks + r.unresolvedLinks,
            failed: addFailures(a.failed, r.failed),
            assetFailures: addFailures(a.assetFailures, r.assetFailures),
            // Left for the next batch, which takes them again: the last batch's are what's left.
            deferred: addFailures(NO_FAILURES, r.deferred),
          }),
          next: (r) => {
            more = r.more;
            // Only deferred pages left: asking again now would only lose the same races.
            return { more: loop && r.more, stalled: r.loaded + r.failed.length === 0 };
          },
          onBatch: (totals) => {
            setLoad(totals);
            if (loop) runner.say(loadLine(totals));
          },
        },
      );
      const line = loadLine(outcome.totals);
      return {
        line:
          outcome.kind === 'stopped'
            ? `Stopped. ${line} ${STOPPED}`
            : outcome.kind === 'stalled'
              ? `${line} The pages left keep losing a race with another load. Try again in a moment.`
              : outcome.kind === 'done' && more
                ? `${line} More pages are waiting.`
                : line,
        ...(outcome.kind === 'failed' ? { error: outcome.error } : {}),
      };
    });

  return (
    <div className="flex flex-col gap-3 p-3">
      <Catalog aria-label="Take its pages in" className="p-0">
        <CatalogRow
          media={<CatalogTile aria-hidden="true">1</CatalogTile>}
          title={<h3 className="font-medium">Transform</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                Runs the approved script on its pages, {TRANSFORM_BATCH} a request, and scores each.
                Pages it already transformed are skipped.
              </span>
              <Why id={`${id}-transform`} step={step} show={rights?.run === true} />
            </span>
          }
          actions={
            rights === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : rights.run ? (
              <LoopButtons
                runner={runner}
                id="transform"
                step={step}
                label="Transform pages"
                loopLabel="Transform until done"
                doing="Transforming…"
                describedBy={`${id}-transform`}
                onOnce={() => void transform(false)}
                onLoop={() => void transform(true)}
              />
            ) : null
          }
        />
        <CatalogRow
          media={<CatalogTile aria-hidden="true">2</CatalogTile>}
          title={<h3 className="font-medium">Load</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                Makes its validated pages draft entries as you, {LOAD_BATCH} a request, with their
                assets. Loading a page again updates its entry.
              </span>
              {rights?.load ? (
                <span className="flex w-full items-center gap-2 pt-1">
                  <Checkbox
                    id={`${id}-needs-fix`}
                    aria-label="Include needs-fix pages"
                    checked={needsFix}
                    disabled={!step.available || runner.busy}
                    onCheckedChange={(v) => setNeedsFix(v === true)}
                  />
                  <Label htmlFor={`${id}-needs-fix`} className="font-normal text-xs">
                    Include needs-fix pages (the ones that only scored low)
                  </Label>
                </span>
              ) : null}
              <Why id={`${id}-load`} step={step} show={rights?.load === true} />
            </span>
          }
          actions={
            rights === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : rights.load ? (
              <LoopButtons
                runner={runner}
                id="load"
                step={step}
                label="Load pages"
                loopLabel="Load until done"
                doing="Loading…"
                describedBy={`${id}-load`}
                onOnce={() => void loadPages(false)}
                onLoop={() => void loadPages(true)}
              />
            ) : null
          }
        />
      </Catalog>
      <RunnerStatus runner={runner} />
      <FailureList title="Pages not transformed" failures={failed} />
      <FailureList title="Pages not loaded" failures={load.failed} />
      <FailureList title="Files not brought in" failures={load.assetFailures} />
      <FailureList title="Pages left for the next load" failures={load.deferred} />
      {rights && !(rights.run && rights.load) ? (
        <p className="px-1 text-muted-foreground text-xs">
          {rights.run
            ? 'Loading takes migration:run, content:write and assets:write.'
            : 'Transforming takes migration:run. Loading takes migration:run, content:write and assets:write.'}
        </p>
      ) : null}
      <p className="max-w-measure px-1 text-muted-foreground text-xs">
        An approved template’s script can’t be changed, so a needs-fix page can’t be transformed
        again. Load can still take the ones that only scored low; one with an error is left to bring
        in by hand.
      </p>
    </div>
  );
}

const transformLine = (t: { transformed: number; validated: number; needsFix: number }) =>
  t.transformed === 0
    ? 'No pages needed transforming.'
    : `Transformed ${plural(t.transformed, 'page')}: ${t.validated} validated, ${t.needsFix} ${
        t.needsFix === 1 ? 'needs' : 'need'
      } a fix.`;

const loadLine = (t: {
  loaded: number;
  unresolvedLinks: number;
  failed: Failures;
  assetFailures: Failures;
}) =>
  [
    `Loaded ${plural(t.loaded, 'page')}`,
    t.failed.total ? `${t.failed.total} not loaded` : '',
    t.assetFailures.total ? `${plural(t.assetFailures.total, 'file')} not brought in` : '',
    t.unresolvedLinks ? `${plural(t.unresolvedLinks, 'link')} left for Relink` : '',
  ]
    .filter(Boolean)
    .join('; ')
    .concat('.');
