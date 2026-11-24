import type {
  MigrationPageStage,
  MigrationRunStatus,
  MigrationSourceKind,
} from '@contentworker/domain';
import type { Tone } from './format';
import {
  ApiError,
  apiIssues,
  type MigrationFetchResult,
  type MigrationPageCounts,
  type MigrationRunView,
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

/** Pages not fetched yet: a page that failed keeps its error and is not tried again. */
export const pendingPages = (counts: MigrationPageCounts) =>
  Math.max(0, counts.total - counts.fetched - counts.failed);

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

  const inventory: StepState = failed
    ? stopped
    : run.status === 'clustered'
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
