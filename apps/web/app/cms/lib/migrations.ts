import {
  holdsScope,
  type MigrationPageStage,
  type MigrationRunStatus,
  type MigrationSourceKind,
  type MigrationTemplateStatus,
  SCOPES,
} from '@contentworker/domain';
import type { Tone } from './format';
import {
  ApiError,
  apiIssues,
  type MigrationApproval,
  type MigrationFetchResult,
  type MigrationPageCounts,
  type MigrationPageFailure,
  type MigrationRunView,
  type MigrationTemplateView,
} from './management';

/*
 * The Migrations screens' words and the rules they show, read from the run as the API states it.
 * Which step a run can take next is the API's rule (`inventorySite`, `clusterPages` refuse the
 * rest); the screen offers only what it would take, says why the others wait, and the API is still
 * what refuses.
 */

export const KIND_LABEL: Readonly<Record<MigrationSourceKind, string>> = {
  sitemap: 'Sitemap',
  crawl: 'Link crawl',
};

/** A run's status is the step that last finished: at rest until someone takes the next one. */
export const RUN_STATUS: Readonly<Record<MigrationRunStatus, { tone: Tone; label: string }>> = {
  created: { tone: 'idle', label: 'Created' },
  inventoried: { tone: 'idle', label: 'Inventoried' },
  clustered: { tone: 'idle', label: 'Clustered' },
  // Its background run ended without publishing; it can still be taken on by hand.
  stopped: { tone: 'wait', label: 'Stopped' },
  failed: { tone: 'bad', label: 'Failed' },
};

/** A page's stage, in the order a page goes through them. */
export const STAGES: readonly { id: MigrationPageStage; label: string; tone: Tone }[] = [
  { id: 'discovered', label: 'Discovered', tone: 'idle' },
  { id: 'clustered', label: 'Clustered', tone: 'idle' },
  { id: 'transformed', label: 'Transformed', tone: 'idle' },
  { id: 'validated', label: 'Validated', tone: 'ok' },
  // Scored under the run's threshold: someone fixes its template's script.
  { id: 'needs-fix', label: 'Needs fix', tone: 'wait' },
  { id: 'loaded', label: 'Loaded', tone: 'ok' },
  { id: 'published', label: 'Published', tone: 'ok' },
];

/** Pages one request lists at most: the API's `MIGRATION_PAGES_MAX`. */
export const MIGRATION_PAGES_MAX = 200;

export const stageOf = (id: string) => STAGES.find((s) => s.id === id);

export const isStage = (id: string | null | undefined): id is MigrationPageStage =>
  !!id && STAGES.some((s) => s.id === id);

/**
 * Where a template is on its way to a content type: waiting, being written, being approved (its
 * content type being created), or approved.
 */
export const TEMPLATE_STATUS: Readonly<
  Record<MigrationTemplateStatus, { tone: Tone; label: string }>
> = {
  pending: { tone: 'idle', label: 'Not authored' },
  // An agent drafts its model and script: a model's work, for someone to review.
  authoring: { tone: 'ai', label: 'Authoring' },
  approving: { tone: 'run', label: 'Approving' },
  approved: { tone: 'ok', label: 'Approved' },
};

/**
 * Pages whose fetch failed. The API counts every page whose last step failed, a transform's and a
 * load's too; those have their HTML, so the ones that don't are at most the pages without it.
 */
export const fetchFailures = (counts: MigrationPageCounts) =>
  Math.min(
    counts.failed,
    Math.max(0, counts.total - counts.fetched),
    counts.byStage.discovered ?? Number.POSITIVE_INFINITY,
  );

/** Pages not fetched yet: a page that failed keeps its error and is not tried again. */
export const pendingPages = (counts: MigrationPageCounts) =>
  Math.max(0, counts.total - counts.fetched - fetchFailures(counts));

export type StepId = 'inventory' | 'fetch' | 'cluster';

export interface StepState {
  readonly available: boolean;
  /** Why it isn't, in words, when it isn't. */
  readonly reason?: string;
}

export interface RunSteps {
  readonly inventory: StepState;
  readonly fetch: StepState;
  readonly cluster: StepState;
  /** The step the run is waiting on, if any: the one drawn as primary. */
  readonly next: StepId | null;
}

/**
 * What a run can do next, as the API decides it: an inventory before clustering and never on a
 * failed run (`inventorySite`), clustering after an inventory and never over a template past
 * `pending` (`clusterPages`). Fetching is refused by nothing but having no page left to fetch.
 */
export function runSteps(view: MigrationRunView): RunSteps {
  const { run, pages, templates } = view;
  const failed = run.status === 'failed';
  const pending = pendingPages(pages);
  const authoring = templates.some((t) => t.status !== 'pending');
  const stopped: StepState = { available: false, reason: 'The run failed.' };

  // A run whose background driver stopped was clustered first, and the API keeps it that way.
  const settled = run.status === 'clustered' || run.status === 'stopped';
  const inventory: StepState = failed
    ? stopped
    : settled
      ? { available: false, reason: 'The pages are grouped into templates, so the list is kept.' }
      : { available: true };
  const fetch: StepState =
    pages.total === 0
      ? { available: false, reason: 'Inventory the source first.' }
      : pending === 0
        ? { available: false, reason: 'No pages are waiting to be fetched.' }
        : { available: true };
  const cluster: StepState = failed
    ? stopped
    : run.status === 'stopped'
      ? { available: false, reason: 'Its background run stopped, so the grouping is kept.' }
      : run.status === 'created'
        ? { available: false, reason: 'Inventory the source first.' }
        : authoring
          ? {
              available: false,
              reason: 'A template is being authored or approved, so the grouping is kept.',
            }
          : { available: true };

  // The primary: inventory first, then fetching while pages wait, then clustering what was read.
  const next: StepId | null = failed
    ? null
    : run.status === 'created'
      ? 'inventory'
      : pending > 0
        ? 'fetch'
        : run.status === 'inventoried' && pages.fetched > 0 && cluster.available
          ? 'cluster'
          : null;
  return { inventory, fetch, cluster, next };
}

/** Path globs as typed, one per line: blank lines dropped, each trimmed. */
export const globsFrom = (text: string): string[] =>
  text
    .split('\n')
    .map((g) => g.trim())
    .filter(Boolean);

export type SourceField = 'url' | 'kind' | 'include' | 'exclude' | 'maxPages' | 'name';

/**
 * A refused run's issues, by the form field each names (`source.url` → `url`; a glob's index, as
 * `source.include[2]` or `source.include.2`, becomes its line), so they show beside the field. What
 * names no field of the form is `form`.
 */
export function sourceIssues(err: unknown): Partial<Record<SourceField | 'form', string>> {
  const out: Partial<Record<SourceField | 'form', string>> = {};
  for (const { field, message } of apiIssues(err)) {
    const m = /^(?:source\.)?(url|kind|include|exclude|maxPages|name)(?:\[(\d+)\]|\.(\d+))?$/.exec(
      field,
    );
    const key = (m?.[1] as SourceField | undefined) ?? 'form';
    const index = m?.[2] ?? m?.[3];
    out[key] ??= index !== undefined ? `Line ${Number(index) + 1}: ${message}` : message;
  }
  return out;
}

/** A write that lost a race and changed nothing (409, `retryable`): sending it again is safe. */
export function isRetryableConflict(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  return (err.body as { error?: { retryable?: unknown } } | undefined)?.error?.retryable === true;
}

/**
 * Why the source site can't be read now (503 `site_unavailable`), or undefined: the bare reason, as
 * a fetch batch's `unavailable` gives it. The API's message leads with "The site can't be read
 * now", which the notice's title already says.
 */
export function siteUnavailableOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.status !== 503 || err.code !== 'site_unavailable') return;
  const message = (err.body as { error?: { message?: string } } | undefined)?.error?.message ?? '';
  return message.replace(/^The site can['’]t be read now:\s*/i, '');
}

/** How many times a step that lost a race is sent again before the loss is said. */
const CONFLICT_TRIES = 3;

/**
 * Runs `step`, sending it again while it loses a race (another step wrote the run first): the API
 * read nothing stale and wrote nothing, so the next try reads the new state and goes ahead.
 */
export async function retryingConflicts<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (attempt >= CONFLICT_TRIES || !isRetryableConflict(err)) throw err;
    }
  }
}

export interface FetchTotals {
  readonly batches: number;
  readonly fetched: number;
  readonly failed: number;
  readonly added: number;
}

export type FetchOutcome =
  | { readonly kind: 'done'; readonly totals: FetchTotals }
  | { readonly kind: 'stopped'; readonly totals: FetchTotals }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly totals: FetchTotals }
  /** The API kept saying more without fetching anything: stop rather than ask forever. */
  | { readonly kind: 'stalled'; readonly totals: FetchTotals };

export const NO_FETCHES: FetchTotals = { batches: 0, fetched: 0, failed: 0, added: 0 };

/**
 * Fetches batch after batch while the API says `more`, until it says the site can't be read, or
 * `signal` stops it. Each batch is one bounded request; a lost race is sent again quietly. A stop
 * aborts the batch in flight: the server may still finish it, and the run's counts say what it did.
 */
export async function fetchUntilDone(
  batch: (signal: AbortSignal) => Promise<MigrationFetchResult>,
  opts: {
    readonly signal: AbortSignal;
    readonly onBatch?: (result: MigrationFetchResult, totals: FetchTotals) => void | Promise<void>;
  },
): Promise<FetchOutcome> {
  const { signal } = opts;
  let totals = NO_FETCHES;
  while (true) {
    if (signal.aborted) return { kind: 'stopped', totals };
    let result: MigrationFetchResult;
    try {
      result = await retryingConflicts(() => batch(signal));
    } catch (err) {
      if (signal.aborted) return { kind: 'stopped', totals };
      throw err;
    }
    if (result.unavailable !== undefined) {
      return { kind: 'unavailable', reason: result.unavailable, totals };
    }
    totals = {
      batches: totals.batches + 1,
      fetched: totals.fetched + result.fetched,
      failed: totals.failed + result.failed,
      added: totals.added + result.added,
    };
    await opts.onBatch?.(result, totals);
    if (!result.more) return { kind: 'done', totals };
    if (result.fetched + result.failed + result.added === 0) return { kind: 'stalled', totals };
  }
}

// --- authoring, loading and publishing ----------------------------------------

/** Pages one request of each step takes: the API's most for a request. */
export const TRANSFORM_BATCH = 10;
export const LOAD_BATCH = 10;
export const RELINK_BATCH = 50;
export const PUBLISH_BATCH = 50;
/** The largest import script a template keeps, as UTF-8 bytes: the API's `MIGRATION_SCRIPT_MAX`. */
export const SCRIPT_MAX_BYTES = 256 * 1024;

export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export const migrationTemplateKey = (run: string, template: string) =>
  ['migrations', 'run', run, 'template', template] as const;
export const templatePath = (run: string, template: string) =>
  `/migrations/${encodeURIComponent(run)}/templates/${encodeURIComponent(template)}`;

/** What a person's role in the space lets them do with a run, step for step as the API checks it. */
export interface MigrationRights {
  /** Propose, script, try, transform, start: `migration:run`. */
  readonly run: boolean;
  /** Approve a template, reopen one, write redirects: `content:manage`. */
  readonly manage: boolean;
  readonly load: boolean;
  readonly relink: boolean;
  readonly publish: boolean;
  readonly publishViaRelease: boolean;
}

/** Undefined until the role is known: an action is then drawn as a skeleton, never offered. */
export function migrationRights(scopes: readonly string[] | undefined) {
  if (scopes === undefined) return undefined;
  const has = (scope: string) => holdsScope(scopes, scope);
  const run = has(SCOPES.migrationRun);
  const write = has(SCOPES.contentWrite);
  const publish = has(SCOPES.contentPublish);
  const rights: MigrationRights = {
    run,
    manage: has(SCOPES.contentManage),
    load: run && write && has(SCOPES.assetsWrite),
    relink: run && write,
    publish,
    publishViaRelease: publish && write,
  };
  return rights;
}

/** Why a template's model and script can't be changed now, in words; undefined when they can. */
export function lockedReason(
  template: Pick<MigrationTemplateView, 'status'>,
  run: MigrationRunView['run'] | undefined,
): string | undefined {
  if (template.status === 'approved' && run?.status === 'failed')
    return 'This template is approved and the run failed, so its model and script can’t be changed.';
  if (template.status === 'approved')
    return 'This template is approved, so its model and script are held: its pages are transformed and loaded with what was approved. To change them, reopen it under Approve.';
  if (template.status === 'approving')
    return 'This template is being approved, so its model and script are held until that finishes.';
  if (run?.status === 'failed') return 'The run failed, so its templates can’t be changed.';
  return undefined;
}

/** Approved once and reopened: it holds the content type a new approval revises. */
export const isReopened = (t: Pick<MigrationTemplateView, 'status' | 'contentTypeId'>) =>
  t.status === 'authoring' && t.contentTypeId !== null;

/** What an approval told the run's background driver, in plain words. */
export function approvalLine(a: MigrationApproval): string {
  if (a.signalled) return 'Approved. Its background run was told and takes its pages from here.';
  switch (a.reason) {
    case 'driver-finished':
      return 'Approved. The run’s background run has already finished, so take its pages on here: transform them, then load them.';
    case 'unreachable':
      return 'Approved, but its background run couldn’t be reached. Tell it again, or take its pages on here.';
    default:
      return 'Approved. Nothing is running this in the background, so take its pages on here: transform them, then load them.';
  }
}

/** Up to this many of a step's failures are listed; the rest are counted. */
export const FAILURES_KEPT = 100;

export interface Failures {
  readonly items: readonly MigrationPageFailure[];
  readonly total: number;
}
export const NO_FAILURES: Failures = { items: [], total: 0 };
export const addFailures = (f: Failures, more: readonly MigrationPageFailure[]): Failures =>
  more.length === 0
    ? f
    : { items: [...f.items, ...more].slice(0, FAILURES_KEPT), total: f.total + more.length };

export type BatchOutcome<T> = { readonly batches: number; readonly totals: T } & (
  | { readonly kind: 'done' | 'stopped' | 'stalled' }
  /** A batch was refused or didn't answer; the ones before it stand. */
  | { readonly kind: 'failed'; readonly error: unknown }
);

/**
 * Sends batch after batch while the API says there is more, as {@link fetchUntilDone} does: each is
 * one bounded request, a lost race is sent again quietly, and `signal` stops it (the server may
 * still finish the batch in flight). A batch that moved nothing on, or a cursor that stands still,
 * stops it rather than asking forever. What the batches before a failure did is kept.
 */
export async function batchUntilDone<R, T>(
  batch: (after: string | undefined, signal: AbortSignal) => Promise<R>,
  opts: {
    readonly signal: AbortSignal;
    readonly start: T;
    readonly add: (totals: T, result: R) => T;
    /** Whether to ask again, from where, and whether this batch moved nothing on. */
    readonly next: (result: R) => {
      readonly more: boolean;
      readonly after?: string | undefined;
      readonly stalled?: boolean;
    };
    readonly onBatch?: (totals: T) => void | Promise<unknown>;
    /** Where a batch before this call left off. */
    readonly from?: string | undefined;
  },
): Promise<BatchOutcome<T>> {
  const { signal } = opts;
  let totals = opts.start;
  let batches = 0;
  let after = opts.from;
  while (true) {
    if (signal.aborted) return { kind: 'stopped', batches, totals };
    let result: R;
    try {
      const from = after;
      result = await retryingConflicts(() => batch(from, signal));
    } catch (error) {
      return signal.aborted
        ? { kind: 'stopped', batches, totals }
        : { kind: 'failed', batches, totals, error };
    }
    totals = opts.add(totals, result);
    batches += 1;
    await opts.onBatch?.(totals);
    const n = opts.next(result);
    if (!n.more) return { kind: 'done', batches, totals };
    if (n.stalled || (n.after !== undefined && n.after === after)) {
      return { kind: 'stalled', batches, totals };
    }
    after = n.after;
  }
}

/**
 * Answers worth asking again: none at all, one only time changes (too many, too slow, a server
 * fault) or a race still lost after the quiet resends. Not 501: an install that can't do a step
 * won't on a second try.
 */
export const worthRetrying = (err: unknown) =>
  !(err instanceof ApiError) ||
  (err.status >= 500 && err.status !== 501) ||
  err.status === 408 ||
  err.status === 429 ||
  isRetryableConflict(err);

/** Why the run's driver didn't take a start or a go-ahead, in plain words, when that is the answer. */
export function driverRefusal(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return;
  if (err.status === 501)
    return 'Running migrations in the background isn’t set up on this install.';
  if (err.status === 404 && err.code === 'not_found')
    return 'Nothing is running this in the background. Start it, or publish its entries step by step.';
  if (err.status !== 400 || err.code !== 'invalid_state') return;
  const message = (err.body as { error?: { message?: string } } | undefined)?.error?.message ?? '';
  if (/driver that has finished/.test(message))
    return 'Its background run has already finished and can’t be started or told anything again. Take the run on step by step.';
  if (/^The run has stopped/.test(message))
    return 'Its background run stopped, so it can’t be started again. Take the run on step by step.';
  if (/^The run has failed/.test(message))
    return 'The run failed, so it can’t go on in the background.';
  return;
}
