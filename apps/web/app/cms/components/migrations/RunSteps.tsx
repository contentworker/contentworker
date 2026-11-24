import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Catalog, CatalogFigure, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { Progress } from '@contentworker/ui/progress';
import { SkeletonPill } from '@contentworker/ui/skeleton';
import { useEffect, useId, useRef, useState } from 'react';
import { useClient } from '~/cms/lib/client-context';
import { count, plural } from '~/cms/lib/format';
import {
  ApiError,
  apiErrorMessage,
  type MigrationRunView,
  RequestTimeoutError,
} from '~/cms/lib/management';
import {
  type FetchOutcome,
  type FetchTotals,
  fetchUntilDone,
  isRetryableConflict,
  pendingPages,
  retryingConflicts,
  runSteps,
  type StepId,
  type StepState,
  siteUnavailableOf,
} from '~/cms/lib/migrations';
import { useStoppable } from '~/cms/lib/use-stoppable';

/** Pages one Fetch pages request takes: the API's most for a request. */
export const FETCH_BATCH = 10;

const DOING: Readonly<Record<StepId, string>> = {
  inventory: 'Inventorying…',
  fetch: 'Fetching…',
  cluster: 'Clustering…',
};

/**
 * What stopped a step, said above the steps until the next one starts. `loop` when it was Fetch
 * until done, so Try again repeats what was pressed: one batch stays one batch.
 */
type Notice = { readonly step: StepId; readonly loop?: boolean } & (
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly message: string; readonly retry: boolean }
);

/**
 * Answers worth asking again: none at all, one only time changes (too many, too slow, a server
 * fault) or a race still lost after the quiet resends. Not 501: an install that can't read source
 * sites won't on a second try.
 */
const retryable = (err: unknown) =>
  !(err instanceof ApiError) ||
  (err.status >= 500 && err.status !== 501) ||
  err.status === 408 ||
  err.status === 429 ||
  isRetryableConflict(err);

/** Held while another step runs: drawn as waiting, so a press that does nothing never looks live. */
const HELD = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const FAILED_TITLE: Readonly<Record<StepId, string>> = {
  inventory: 'The inventory didn’t finish',
  fetch: 'Fetching stopped',
  cluster: 'Clustering didn’t finish',
};

/** Buttons a step's row holds; `loop` is Fetch until done, `stop` its Stop. */
type ButtonId = StepId | 'loop' | 'stop';

/**
 * A run's three steps before template authoring, in order: inventory the source, fetch its pages,
 * cluster them into templates. Each is offered only as the run's state allows (the API's rule,
 * `runSteps`), the step it waits on drawn as the primary, the others outline, and one that can't
 * run says why. Fetch pages is one bounded request; Fetch until done asks again while the API says
 * `more`, with its progress and a Stop. A site that can't be read now is a calm notice with Try
 * again; a step that lost a race to another writer is sent again without a word.
 *
 * Without migration:run the steps are shown, not offered; until the role is known, each step's
 * action is drawn as a skeleton rather than offered and then taken back, or the reverse. After a step, focus goes to the step
 * that is next, else back to the button pressed, else to the line that says what happened.
 */
export function RunSteps({
  view,
  canRun,
  refresh,
  onUpdated,
  onClustered,
}: {
  view: MigrationRunView;
  /** Whether the person's role holds migration:run; undefined while that isn't known yet. */
  canRun: boolean | undefined;
  /**
   * Reads the run again, resolving with it once it has; with `lists`, its pages and templates too
   * (once a step is over, not after every batch of a fetch).
   */
  refresh: (opts?: { readonly lists?: boolean }) => Promise<MigrationRunView | undefined>;
  /** A step answered with the run's view: show it now. */
  onUpdated: (view: MigrationRunView) => void;
  /** The run was clustered: its templates are the news. */
  onClustered: () => void;
}) {
  const { client } = useClient();
  const id = useId();
  const { run, pages, templates } = view;
  const steps = runSteps(view);
  const [running, setRunning] = useState<StepId | null>(null);
  const [looping, setLooping] = useState(false);
  const [progress, setProgress] = useState<FetchTotals | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [said, setSaid] = useState('');
  const loop = useStoppable();
  const buttons = useRef<Partial<Record<ButtonId, HTMLButtonElement | null>>>({});
  const status = useRef<HTMLParagraphElement>(null);
  // Where focus goes once a step is over, as soon as `when` (the run read after it) is on screen:
  // a read resolves before the page shows it, and a button the new state enables must be.
  const [focusNext, setFocusNext] = useState<{
    readonly to: readonly ButtonId[];
    readonly when?: MigrationRunView;
  } | null>(null);
  const busy = running !== null;

  // Once the run's new state has rendered: the first of the asked-for buttons that can be pressed,
  // else the line that says what happened, so focus never falls to the page.
  useEffect(() => {
    if (!focusNext || (focusNext.when && focusNext.when !== view)) return;
    setFocusNext(null);
    const target = focusNext.to.map((b) => buttons.current[b]).find((el) => el && !el.disabled);
    (target ?? status.current)?.focus();
  }, [focusNext, view]);

  /** Reads the run again; a read that fails leaves the counts as they were. */
  const reread = (lists = true) => refresh({ lists }).catch(() => undefined);

  const failure = (step: StepId, err: unknown, loop = false): Notice => {
    const reason = siteUnavailableOf(err);
    if (reason !== undefined) return { kind: 'unavailable', step, loop, reason };
    const message =
      err instanceof RequestTimeoutError
        ? 'The step didn’t answer in time. It may still be running: the counts below show what it did.'
        : apiErrorMessage(err);
    // A refusal (the run moved on meanwhile) won't change on a second try; most else may.
    return { kind: 'failed', step, loop, message, retry: retryable(err) };
  };

  /** Runs one step, its lost races sent again, then reads the run so every count is current. */
  const take = async (
    step: StepId,
    act: () => Promise<string>,
    next: readonly ButtonId[] | null,
  ) => {
    setRunning(step);
    setNotice(null);
    setSaid('');
    try {
      const line = await retryingConflicts(act);
      setSaid(line);
    } catch (err) {
      setNotice(failure(step, err));
    } finally {
      const after = await reread();
      setRunning(null);
      if (next) setFocusNext({ to: next, when: after });
    }
  };

  const inventory = () =>
    take('inventory', async () => {
      const after = await client.inventoryMigrationRun(run.id);
      const inv = after.inventory;
      return inv
        ? `The inventory added ${plural(inv.added, 'page')} of the ${count(inv.discovered)} it found.`
        : 'The inventory finished.';
    }, ['loop', 'inventory']);

  const fetchOnce = () =>
    take('fetch', async () => {
      const r = await client.fetchMigrationPages(run.id, { limit: FETCH_BATCH });
      if (r.unavailable !== undefined) {
        setNotice({ kind: 'unavailable', step: 'fetch', reason: r.unavailable });
        return '';
      }
      return batchLine(r.fetched, r.failed, r.added);
    }, ['fetch', 'cluster']);

  const cluster = () =>
    take(
      'cluster',
      async () => {
        const after = await client.clusterMigrationRun(run.id);
        onUpdated(after);
        onClustered();
        const grouped = after.templates.reduce((n, t) => n + t.pageCount, 0);
        return `Grouped ${plural(grouped, 'page')} into ${plural(after.templates.length, 'template')}.`;
        // The templates take focus (onClustered); a clustering that failed keeps it on its button.
      },
      null,
    );

  const fetchAll = async () => {
    const signal = loop.start();
    setRunning('fetch');
    setLooping(true);
    setNotice(null);
    setSaid('');
    setProgress(null);
    setFocusNext({ to: ['stop'] });
    let outcome: FetchOutcome | null = null;
    try {
      outcome = await fetchUntilDone(
        (s) => client.fetchMigrationPages(run.id, { limit: FETCH_BATCH }, s),
        {
          signal,
          onBatch: async (_r, totals) => {
            setProgress(totals);
            await reread(false);
          },
        },
      );
      if (outcome.kind === 'unavailable') {
        setNotice({ kind: 'unavailable', step: 'fetch', loop: true, reason: outcome.reason });
      }
      setSaid(loopLine(outcome));
    } catch (err) {
      setNotice(failure('fetch', err, true));
    } finally {
      const after = await reread();
      setRunning(null);
      setLooping(false);
      setProgress(null);
      setFocusNext({ to: ['cluster', 'loop', 'fetch'], when: after });
    }
  };

  const again = (n: Notice) =>
    n.step === 'inventory'
      ? inventory()
      : n.step === 'cluster'
        ? cluster()
        : n.loop
          ? fetchAll()
          : fetchOnce();

  const done = pages.fetched + pages.failed;
  const pending = pendingPages(pages);
  const describe = (step: StepId) => `${id}-${step}-why`;

  return (
    <div className="space-y-3 p-4 pt-0">
      {notice ? (
        <StepNotice notice={notice} busy={busy} onRetry={() => void again(notice)} />
      ) : null}
      <Catalog aria-label="Steps" className="p-0">
        <CatalogRow
          media={<CatalogTile aria-hidden="true">1</CatalogTile>}
          title={<h3 className="font-medium">Inventory</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                {run.source.kind === 'crawl'
                  ? 'Adds the start page. Fetching follows its links.'
                  : 'Lists the sitemap’s pages that the include and exclude paths take. Safe to repeat: only new pages are added.'}
              </span>
              {run.inventory ? <InventoryReport inventory={run.inventory} /> : null}
              <Why id={describe('inventory')} step={steps.inventory} show={canRun === true} />
            </span>
          }
          aside={<CatalogFigure label="Pages">{count(pages.total)}</CatalogFigure>}
          actions={
            canRun ? (
              <StepButton
                ref={(el) => {
                  buttons.current.inventory = el;
                }}
                step={steps.inventory}
                primary={steps.next === 'inventory'}
                busy={busy}
                doing={running === 'inventory'}
                describedBy={describe('inventory')}
                label={run.status === 'created' ? 'Inventory' : 'Inventory again'}
                doingLabel={DOING.inventory}
                onClick={() => void inventory()}
              />
            ) : canRun === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : null
          }
        />
        <CatalogRow
          media={<CatalogTile aria-hidden="true">2</CatalogTile>}
          title={<h3 className="font-medium">Fetch pages</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                {`Reads ${FETCH_BATCH} pages a request, keeping to the site’s robots.txt and its crawl delay.`}
                {run.source.kind === 'crawl' ? ' Each page’s links join the run.' : ''}
              </span>
              {pages.total > 0 ? (
                <span>
                  {pending > 0 ? `${plural(pending, 'page')} to fetch` : 'Every page fetched'}
                </span>
              ) : null}
              <Why id={describe('fetch')} step={steps.fetch} show={canRun === true && !looping} />
            </span>
          }
          aside={
            <>
              <CatalogFigure label="Fetched">
                {count(pages.fetched)}
                <span className="font-normal text-muted-foreground"> of {count(pages.total)}</span>
              </CatalogFigure>
              {pages.failed > 0 ? (
                <CatalogFigure label="Failed">{count(pages.failed)}</CatalogFigure>
              ) : null}
            </>
          }
          actions={
            canRun ? (
              looping ? (
                <Button
                  ref={(el) => {
                    buttons.current.stop = el;
                  }}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={loop.stop}
                >
                  Stop
                </Button>
              ) : (
                <div className="flex flex-wrap justify-end gap-2">
                  <StepButton
                    ref={(el) => {
                      buttons.current.fetch = el;
                    }}
                    step={steps.fetch}
                    busy={busy}
                    doing={running === 'fetch'}
                    describedBy={describe('fetch')}
                    label="Fetch pages"
                    doingLabel={DOING.fetch}
                    onClick={() => void fetchOnce()}
                  />
                  <StepButton
                    ref={(el) => {
                      buttons.current.loop = el;
                    }}
                    step={steps.fetch}
                    primary={steps.next === 'fetch'}
                    busy={busy}
                    describedBy={describe('fetch')}
                    label="Fetch until done"
                    onClick={() => void fetchAll()}
                  />
                </div>
              )
            ) : canRun === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : null
          }
        />
        <CatalogRow
          media={<CatalogTile aria-hidden="true">3</CatalogTile>}
          title={<h3 className="font-medium">Cluster</h3>}
          meta={
            <span className="flex flex-wrap gap-x-2">
              <span className="w-full">
                Groups the fetched pages that share a structure into templates, replacing any
                earlier grouping.
              </span>
              <Why id={describe('cluster')} step={steps.cluster} show={canRun === true} />
            </span>
          }
          aside={<CatalogFigure label="Templates">{count(templates.length)}</CatalogFigure>}
          actions={
            canRun ? (
              <StepButton
                ref={(el) => {
                  buttons.current.cluster = el;
                }}
                step={steps.cluster}
                primary={steps.next === 'cluster'}
                busy={busy}
                doing={running === 'cluster'}
                describedBy={describe('cluster')}
                label={run.status === 'clustered' ? 'Cluster again' : 'Cluster'}
                doingLabel={DOING.cluster}
                onClick={() => void cluster()}
              />
            ) : canRun === undefined ? (
              <SkeletonPill aria-hidden="true" />
            ) : null
          }
        />
      </Catalog>
      {looping ? (
        <Progress
          value={pages.total ? Math.round((done / pages.total) * 100) : 0}
          aria-label="Fetch progress"
          aria-valuetext={`${count(done)} of ${count(pages.total)} pages`}
          className="h-1.5"
        />
      ) : null}
      {/* What the last step did, or how far fetching has got: heard as it changes, and where
          focus goes when the step's buttons can't take it. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="min-h-4 text-muted-foreground text-xs outline-none"
      >
        {looping
          ? `Fetching… ${count(done)} of ${count(pages.total)} pages${
              pages.failed ? `, ${count(pages.failed)} failed` : ''
            }${progress ? ` (${plural(progress.batches, 'batch', 'batches')} this time)` : ''}`
          : said}
      </p>
      {canRun === false ? (
        <p className="text-muted-foreground text-xs">
          Running a step takes migration:run. You can follow the run here.
        </p>
      ) : null}
    </div>
  );
}

/** A step's button: disabled, with its reason, when the run can't take it; held while one runs. */
function StepButton({
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
  ref: React.Ref<HTMLButtonElement>;
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
function Why({ id, step, show }: { id: string; step: StepState; show: boolean }) {
  if (!show || step.available || !step.reason) return null;
  return (
    <span id={id} className="w-full">
      {step.reason}
    </span>
  );
}

function InventoryReport({
  inventory,
}: {
  inventory: NonNullable<MigrationRunView['run']['inventory']>;
}) {
  const { skipped } = inventory;
  const left = [
    [skipped.robots, 'robots.txt disallows'],
    [skipped.filtered, 'the paths leave out'],
    [skipped.offOrigin, 'on another site'],
    [skipped.overLimit, 'over the most pages'],
    [skipped.invalid, 'not usable URLs'],
  ] as const;
  const skippedTotal = left.reduce((n, [k]) => n + k, 0);
  return (
    <>
      <span>
        Found {count(inventory.discovered)}, added {count(inventory.added)}
      </span>
      {skippedTotal > 0 ? (
        <span>
          Skipped{' '}
          {left
            .filter(([k]) => k > 0)
            .map(([k, why]) => `${count(k)} ${why}`)
            .join(', ')}
        </span>
      ) : null}
      {inventory.warnings.length > 0 ? (
        <span className="w-full">
          {plural(inventory.warnings.length, 'warning')}: {inventory.warnings.join(' · ')}
        </span>
      ) : null}
    </>
  );
}

/**
 * What stopped a step. A site that can't be read now is no fault of the run: a plain Alert, calm,
 * with Try again. Anything else is a destructive Alert, with Try again only where trying again can
 * change the answer.
 */
function StepNotice({
  notice,
  busy,
  onRetry,
}: {
  notice: Notice;
  busy: boolean;
  onRetry: () => void;
}) {
  const retry = notice.kind === 'unavailable' || notice.retry;
  return (
    <Alert variant={notice.kind === 'unavailable' ? 'default' : 'destructive'}>
      <AlertTitle>
        {notice.kind === 'unavailable'
          ? 'The site can’t be read right now'
          : FAILED_TITLE[notice.step]}
      </AlertTitle>
      <AlertDescription>
        <p>
          {notice.kind === 'unavailable'
            ? `${sentence(notice.reason)}Nothing was written. Try again in a few minutes.`
            : notice.message}
        </p>
        {retry ? (
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
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** A reason as a sentence, with one full stop and a space after it; nothing when there's none. */
const sentence = (reason: string) => {
  const r = reason.trim();
  return r ? `${/[.!?]$/.test(r) ? r : `${r}.`} ` : '';
};

const batchLine = (fetched: number, failed: number, added: number) =>
  [
    `Fetched ${plural(fetched, 'page')}`,
    failed ? `${count(failed)} failed` : '',
    added ? `the links added ${plural(added, 'page')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
    .concat('.');

function loopLine(outcome: FetchOutcome): string {
  const { fetched, failed, added } = outcome.totals;
  const did = batchLine(fetched, failed, added);
  switch (outcome.kind) {
    case 'done':
      return `${did} No pages are waiting.`;
    case 'stopped':
      return `Stopped. ${did} A batch under way may still finish; the counts show what it did.`;
    case 'stalled':
      return `${did} The site stopped giving pages, so fetching stopped.`;
    case 'unavailable':
      return outcome.totals.batches ? did : '';
  }
}
