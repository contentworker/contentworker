import {
  DomainError,
  InvalidStateError,
  isMigrationActor,
  type MigrationActor,
  MigrationApprovalChangedError,
  type MigrationGoAhead,
  type MigrationPublishTarget,
  type MigrationRun,
  migrationPublishTarget,
  NotFoundError,
  type Principal,
  type Scope,
  sameMigrationActor,
  scopesForKind,
} from '@contentworker/domain';
import {
  type MigrationPublishApproved,
  type MigrationRunParams,
  type MigrationTemplateApproved,
  TransactionConflictError,
  type WorkflowStepEvent,
  type WorkflowSteps,
} from '@contentworker/ports';
import { type AppContext, actingAs } from './context';
import { resolveStarter } from './job-starter';
import { recordDelivered, recordDriver } from './site-migration-driver';
import {
  importMigrationRedirects,
  loadTemplatePages,
  MIGRATION_LOAD_BATCH_MAX,
  MIGRATION_RELINK_BATCH_MAX,
  type MigrationLoadDeps,
  publishMigration,
  relinkMigratedPages,
} from './site-migration-load';
import {
  MIGRATION_TRANSFORM_BATCH_MAX,
  type TemplateAuthoringDeps,
  transformTemplatePages,
} from './site-migration-templates';
import { assertSameApproval } from './site-migration-version';
import {
  fetchSourcePages,
  inventorySite,
  MIGRATION_FETCH_BATCH_MAX,
  type SiteMigrationDeps,
  SiteUnavailableError,
  takeClustering,
} from './site-migrations';

/**
 * A site migration run, driven start to finish: one Workflow instance per run.
 *
 * inventory → fetch the pages a batch per step (waiting out a site that can't be read now) →
 * cluster, taking the templates on ({@link takeClustering}) → one template agent per template, to propose its model and write its script → for
 * each template, wait for a person to approve it, then transform its pages a batch per step and
 * load them → wait for the go-ahead to publish → publish. A template that is reopened on the way is
 * waited for again, and its newer version taken through ({@link DrivenTemplate}).
 *
 * The run is created before its driver starts (`createMigrationRun`, which checks the source),
 * so a caller hears about a bad source at once, and the driver's instance is named for the run.
 * Every effect is a use-case inside a step, each safe to run again: a step replayed after a crash
 * redoes nothing a finished one did, and one retried after a failure goes on from what the store
 * says. A lost compare-and-set (`TransactionConflictError`) inside a step means another writer
 * moved the run first: the step reads again and goes on.
 *
 * The agents only author: they can't approve, load or publish. Approvals and the go-ahead come
 * from people, as events ({@link migrationTemplateApprovedEvent}, {@link MIGRATION_PUBLISH_EVENT}).
 * Each is a wake-up: who approved is read from the template (`approvedBy`), and the go-ahead from the
 * run (`goAhead`), never from the event. A go-ahead sent before they were recorded names who gave it
 * itself, and is recorded as it is taken. Every actor (the run's starter too) is resolved
 * again before each step that acts for them.
 */

/** The event a template's approval is delivered as. Workflows event types take `[A-Za-z0-9_-]`. */
export const migrationTemplateApprovedEvent = (templateId: string) =>
  `template-approved-${templateId}`;
/** The event the go-ahead to publish is delivered as. */
export const MIGRATION_PUBLISH_EVENT = 'publish-approved';
/** How long a template waits for a person to approve it, and a run for the go-ahead. */
export const MIGRATION_APPROVAL_TIMEOUT = '14 days';
/** Approvals of one template the driver takes through: the first, and each after a reopening. */
export const MIGRATION_APPROVAL_ROUNDS = 8;
/**
 * Waits for one template's approval in all. A wait that ends with nothing to take through (an
 * approval told twice, fourteen days without one) isn't a round, and the driver listens on.
 */
export const MIGRATION_APPROVAL_WAITS = 24;
/** Templates a run's driver takes through (largest first); the rest are left to its callers. */
export const MIGRATION_DRIVEN_TEMPLATES = 50;
/** Templates a run starts an agent for (largest first); a person authors the rest. */
export const MIGRATION_AGENTS_PER_RUN = 20;
/** How long a step waits before reading a site that couldn't be read again. */
const UNAVAILABLE_WAIT = '10 minutes';
/** Times a site that can't be read is waited out, in all, before the run fails. */
const UNAVAILABLE_ATTEMPTS = 12;
/** Run statuses a failure is never recorded over. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['failed', 'stopped']);
/**
 * The step budget. Workflows allows an instance 10,000 steps on Workers Paid (configurable to
 * 25,000; 1,024 on Workers Free), and `step.sleep` doesn't count. Every loop here takes the
 * use-case's largest batch, so a run of `MIGRATION_MAX_PAGES` (10,000) pages takes about 200 fetch,
 * 200 transform and 200 load steps, 100 relink and 50 publish steps, plus a few per template (at
 * most {@link MIGRATION_DRIVEN_TEMPLATES}) and the waits: under 1,500. A round after a reopening
 * adds at most that template's share of the transform and load steps and a few more, and a wait
 * two, so every template at the last of {@link MIGRATION_APPROVAL_ROUNDS} and
 * {@link MIGRATION_APPROVAL_WAITS} stays under 9,000. Each loop is also capped (`MAX_BATCHES`) so a use-case that kept saying `more` can't run the instance out
 * of steps.
 */
const MAX_BATCHES = 400;
const STEP = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;
/** A fetch batch at a site's longest crawl delay, with slow pages, takes longer than most steps. */
const FETCH_STEP = { ...STEP, timeout: '30 minutes' } as const;
const MAX_ERROR_LENGTH = 500;

/** Starts a template's authoring agent; starting one that runs already changes nothing. */
export interface TemplateAgentStarter {
  start(input: {
    readonly scope: Scope;
    readonly runId: string;
    readonly templateId: string;
    readonly startedBy: MigrationActor;
  }): Promise<void>;
}

export interface SiteMigrationRunHost {
  readonly ctx: AppContext;
  readonly site: SiteMigrationDeps;
  readonly authoring: TemplateAuthoringDeps;
  readonly agents: TemplateAgentStarter;
  /** The load's ports: the blob store, the fetcher assets are brought in with, asset ingest. */
  readonly load: MigrationLoadDeps;
}

export interface TemplateOutcome {
  readonly templateId: string;
  /**
   * `reopened`: waiting to be approved again when the driver ended; what it had loaded stays loaded.
   * `not-driven`: past {@link MIGRATION_DRIVEN_TEMPLATES}, left for its callers to take through.
   */
  readonly status: 'loaded' | 'reopened' | 'timed-out' | 'failed' | 'not-driven';
  readonly error?: string;
  /** Who approved it. */
  readonly approvedBy?: MigrationActor;
}

export interface SiteMigrationRunResult {
  readonly status: 'published' | 'loaded' | 'clustered' | 'failed' | 'gone';
  readonly templates: readonly TemplateOutcome[];
  readonly error?: string;
}

/** A step's outcome: its value, or why it can't succeed on a retry (returned, never retried). */
type Settled<T> = { readonly ok: T } | { readonly failed: string };

/**
 * Runs `fn`, once more from a fresh read when it loses a compare-and-set. A `DomainError` (the
 * run is gone, in the wrong state, the actor lost access) is a failure no retry fixes: returned
 * as one, so the step is recorded and not retried. Anything else throws, and the step retries.
 */
async function settle<T>(
  fn: () => Promise<T>,
  /** What the last lost race is: a failure, or thrown, for the step's own retries to take over. */
  lost: 'fails' | 'throws' = 'fails',
): Promise<Settled<T>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: await fn() };
    } catch (err) {
      if (err instanceof TransactionConflictError) {
        if (attempt < 3) continue;
        if (lost === 'throws') throw err;
      }
      if (err instanceof DomainError) return { failed: err.message.slice(0, MAX_ERROR_LENGTH) };
      throw err;
    }
  }
}

class RunFailure extends Error {}

function unwrap<T>(settled: Settled<T>): T {
  if ('failed' in settled) throw new RunFailure(settled.failed);
  return settled.ok;
}

/**
 * Who `actor` acts as in the run's space now: a key or a team member resolved from the store as
 * their next request would be, or the deployment's own authority. Null when they no longer act
 * there (a key revoked, a person removed).
 */
export async function migrationActorPrincipal(
  ctx: AppContext,
  scope: Scope,
  actor: MigrationActor,
): Promise<Principal | null> {
  if (actor.kind === 'deployment') {
    return { spaceId: scope.spaceId, kind: 'admin', scopes: scopesForKind('cma') };
  }
  return resolveStarter(ctx, scope.spaceId, actor);
}

/** The Workflow body for one run ({@link SiteMigrationRunHost} binds its ports). */
export async function runSiteMigration(
  steps: WorkflowSteps,
  host: SiteMigrationRunHost,
  params: MigrationRunParams,
): Promise<SiteMigrationRunResult> {
  const { ctx } = host;
  const { scope, runId } = params;
  // Recorded in the step every instance takes first, and only for one whose go-aheads are recorded
  // too: one that began before this was, or was started by an api from before it, never is.
  const loaded = await steps.do('read run', STEP, async () =>
    params.recorded
      ? recordDriver(ctx, scope, runId, params.startedBy)
      : ctx.store.migrations.getRun(scope, runId),
  );
  if (!loaded) return { status: 'gone', templates: [] };
  const outcomes: TemplateOutcome[] = [];
  try {
    if (loaded.status === 'failed') throw new RunFailure(loaded.error ?? 'the run failed');
    await inventoryAndFetch(steps, host, params, loaded);
    const templates = unwrap(
      await steps.do('cluster', STEP, () =>
        settle(async () => {
          await principalFor(ctx, scope, params.startedBy);
          // Held from here on: what is waited for below is these templates, by id.
          const taken = await takeClustering(ctx, scope, runId);
          return taken.map((t) => ({
            id: t.id,
            status: t.status,
            // Held by an approval: reopened by hand before the driver started.
            held: t.contentTypeId !== null,
          }));
          // Templates being written, or grouped again, as it takes them are no reason to fail.
        }, 'throws'),
      ),
    );
    if (templates.length === 0) return { status: 'clustered', templates: [] };
    // Largest first (as clustering returns them). A site of many one-off pages is many templates:
    // agents and the driver's waits are kept to the ones that cover most of it.
    const driven = templates.slice(0, MIGRATION_DRIVEN_TEMPLATES);
    const skipped: TemplateOutcome[] = templates
      .slice(MIGRATION_DRIVEN_TEMPLATES)
      .map((t) => ({ templateId: t.id, status: 'not-driven' }));

    for (const t of driven.slice(0, MIGRATION_AGENTS_PER_RUN)) {
      // A reopened template is its person's to change: no agent writes over what they approved.
      if (t.status === 'approved' || t.held) continue;
      unwrap(
        await steps.do(`start agent ${t.id}`, STEP, () =>
          settle(async () => {
            await principalFor(ctx, scope, params.startedBy);
            await host.agents.start({
              scope,
              runId,
              templateId: t.id,
              startedBy: params.startedBy,
            });
            return true;
          }),
        ),
      );
    }

    // Templates are approved in any order and each waits on its own; their pages are processed
    // one template at a time, so a run holds at most one batch of scripts in flight.
    const work = new SerialWork();
    const chains = driven.map((t, i) => new DrivenTemplate(steps, host, params, t, i, work));
    const report = () => {
      outcomes.splice(0, outcomes.length, ...chains.map((c) => c.outcome), ...skipped);
    };
    try {
      return await finishRun(steps, host, params, chains, work, (status) => {
        report();
        return { status, templates: [...outcomes] };
      });
    } catch (err) {
      report();
      throw err;
    } finally {
      // Nothing new is started, and what is running finishes: a step left in flight as the
      // instance ends would be cut short.
      await work.close();
    }
  } catch (err) {
    // Any failure is recorded on the run: a step that ran out of retries rethrows a serialized
    // error (not the class it threw), and a run left in flight for ever helps nobody.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
    await steps.do('record failure', STEP, async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const run = await ctx.store.migrations.getRun(scope, runId);
        // A terminal status is never written over.
        if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return true;
        try {
          await ctx.store.migrations.saveRun(
            scope,
            {
              ...run,
              status: 'failed',
              error: message,
              version: run.version + 1,
              updatedAt: ctx.clock.now().toISOString(),
            },
            run.version,
          );
          return true;
        } catch (e) {
          // The last lost race is thrown, so the step's own retries take over from a fresh read.
          if (!(e instanceof TransactionConflictError) || attempt === 3) throw e;
        }
      }
      return true;
    });
    return { status: 'failed', templates: inOrder(outcomes), error: message };
  }
}

/**
 * The run once its templates are being driven: what is in is relinked, the go-ahead waited for,
 * and the loaded entries published.
 *
 * It waits for every template to be loaded, or to time out or fail. One reopened on the way isn't
 * waited for once another is in: it goes on waiting for its approval while the rest go on to the
 * go-ahead. Nothing here reads how far a template's later rounds have got, which a replay could
 * find in another order; only their first outcomes, which are recorded.
 *
 * The go-ahead publishes every entry loaded by then, a reopened template's too: those are approved
 * content, and reopening changed none of it. Its pages not loaded yet aren't published, and don't
 * hold up the rest; the driver ends, and they are taken on step by step once it is approved again.
 */
async function finishRun(
  steps: WorkflowSteps,
  host: SiteMigrationRunHost,
  params: MigrationRunParams,
  chains: readonly DrivenTemplate[],
  work: SerialWork,
  ended: (status: SiteMigrationRunResult['status']) => SiteMigrationRunResult,
): Promise<SiteMigrationRunResult> {
  const { ctx } = host;
  const { scope, runId } = params;
  // Links between templates' pages are pointed at each other once the templates are in, as
  // whoever approved the first of them, in the templates' order (relinking edits only the run's
  // own entries): a replay resolves its waits in call order, and every relink step must act as the
  // same person.
  const approver = (outcomes: readonly TemplateOutcome[]) =>
    outcomes.find((o) => o.status === 'loaded')?.approvedBy;
  const relinker =
    approver(await Promise.all(chains.map((c) => c.first))) ??
    approver(await Promise.all(chains.map((c) => c.settled)));
  if (!relinker) {
    // Nothing was approved in time (or loaded): nothing to wait for a go-ahead on.
    await recordStop(steps, ctx, scope, runId, 'No template was approved and loaded in time');
    return ended('clustered');
  }
  unwrap(await relinkAll(steps, host, params, relinker, 'relink'));

  let event: WorkflowStepEvent<MigrationPublishApproved> | null = null;
  try {
    event = await steps.waitForEvent<MigrationPublishApproved>('publish approval', {
      type: MIGRATION_PUBLISH_EVENT,
      timeout: MIGRATION_APPROVAL_TIMEOUT,
    });
  } catch {
    // Not told of one in time.
  }
  const sent = event?.payload;
  // Fails closed: a go-ahead that names nobody publishes nothing.
  if (event && !sent?.recorded && !isMigrationActor(sent?.approvedBy)) {
    throw new RunFailure('The go-ahead to publish names no approver');
  }
  // The rounds begun by now are finished first, so what they load is published; none is begun after.
  // Recorded, because a replay finds the go-ahead and the approvals in another order.
  const rounds = () => steps.do('go-ahead rounds', STEP, async () => chains.map((c) => c.begun));
  let go: GoAhead | null = null;
  let begun: readonly number[];
  if (sent) {
    work.goAhead = rounds();
    begun = await work.goAhead;
    go = unwrap(
      await steps.do('go-ahead', STEP, () =>
        settle(() =>
          sent.recorded
            ? recordedGoAhead(ctx, scope, runId)
            : adoptGoAhead(ctx, scope, runId, sent, event?.timestamp),
        ),
      ),
    );
    // A wake-up for a go-ahead the run doesn't hold is nobody's go-ahead.
    if (!go) {
      await recordStop(steps, ctx, scope, runId, 'The go-ahead to publish isn’t on record');
      return ended('loaded');
    }
  } else {
    // One given but never delivered is still the run's: it is taken now rather than said not to
    // have come. Set at once, as above, so no round begins between it and what it counts.
    const late = recordStop(
      steps,
      ctx,
      scope,
      runId,
      'The go-ahead to publish never came',
      (run) => run.goAhead,
    );
    // Stopped, no round begins at all.
    work.goAhead = late.then((given) => (given ? rounds() : chains.map(() => 0)));
    begun = await work.goAhead;
    const given = await late;
    if (!given) return ended('loaded');
    // Read again, which records that it was acted on.
    const held = await steps.do('go-ahead', STEP, () =>
      settle(() => recordedGoAhead(ctx, scope, runId)),
    );
    go = unwrap(held) ?? asGoAhead(given);
  }
  const { approvedBy, target } = go;
  await Promise.all(chains.map((c, i) => c.finished(begun[i] ?? 0)));
  // Neither holds up the go-ahead: a link left as it is, is still a link, and what either leaves
  // undone can be run by hand.
  await relinkAll(steps, host, params, relinker, 'relink to publish').catch(() => undefined);
  await steps
    .do('redirects to publish', STEP, () =>
      settle(async () => {
        // A template reopened as it loaded has entries about to be live and no redirects to them:
        // its round ended with its approval. Written as whoever gave the go-ahead.
        const principal = await principalFor(ctx, scope, approvedBy);
        for (const t of await ctx.store.migrations.listTemplates(scope, runId)) {
          if (t.status !== 'authoring' || t.contentTypeId === null) continue;
          await importMigrationRedirects(actingAs(ctx, principal), principal, scope, {
            runId,
            templateId: t.id,
          });
        }
        return true;
      }),
    )
    .catch(() => undefined);
  let cursor: string | undefined;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const published = unwrap(
      await steps.do(`publish ${i}`, STEP, () =>
        settle(async () => {
          const principal = await principalFor(ctx, scope, approvedBy);
          const { published, next } = await publishMigration(
            actingAs(ctx, principal),
            principal,
            scope,
            {
              runId,
              ...target,
              ...(cursor ? { after: cursor } : {}),
            },
          );
          return { published, ...(next ? { next } : {}) };
        }),
      ),
    );
    cursor = published.next;
    if (!cursor) break;
  }
  return ended('published');
}

/** The go-ahead a driver acts on. */
interface GoAhead {
  readonly approvedBy: MigrationActor;
  readonly target: MigrationPublishTarget;
}

/** Fails closed, as an event's does: a record that names nobody publishes nothing. */
function asGoAhead({ approvedBy, target }: MigrationGoAhead): GoAhead {
  if (!isMigrationActor(approvedBy)) {
    throw new InvalidStateError('The go-ahead to publish names no approver');
  }
  return { approvedBy, target };
}

/** The go-ahead the run holds, recorded as having reached its driver; null when it holds none. */
async function recordedGoAhead(
  ctx: AppContext,
  scope: Scope,
  runId: string,
): Promise<GoAhead | null> {
  const run = await recordDelivered(ctx, scope, runId);
  return run?.goAhead ? asGoAhead(run.goAhead) : null;
}

/**
 * A go-ahead sent before they were recorded: it is what it says, as it was then, so an instance
 * that began publishing under it goes on under it. Recorded over any the run holds, which came
 * after this one had been sent and was never taken: the record says what is being done.
 */
async function adoptGoAhead(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  sent: MigrationPublishApproved,
  sentAt: Date | string | undefined,
): Promise<GoAhead> {
  const { approvedBy } = sent;
  const target = migrationPublishTarget(sent);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const run = await ctx.store.migrations.getRun(scope, runId);
    if (!run) break;
    const now = ctx.clock.now().toISOString();
    try {
      await ctx.store.migrations.saveRun(
        scope,
        {
          ...run,
          goAhead: {
            approvedBy,
            at: sentAt ? new Date(sentAt).toISOString() : now,
            target,
            deliveredAt: now,
          },
          version: run.version + 1,
          updatedAt: now,
        },
        run.version,
      );
      break;
    } catch (err) {
      // The record is for readers: one that keeps losing its race doesn't hold up the publish.
      if (!(err instanceof TransactionConflictError)) throw err;
    }
  }
  return { approvedBy, target };
}

/** A pass over the run's links, a batch per step named `name`; why it stopped, if it failed. */
async function relinkAll(
  steps: WorkflowSteps,
  host: SiteMigrationRunHost,
  params: MigrationRunParams,
  actor: MigrationActor,
  name: string,
): Promise<Settled<true>> {
  const { ctx } = host;
  const { scope, runId } = params;
  let after: string | undefined;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const relinked = await steps.do(`${name} ${i}`, STEP, () =>
      settle(async () => {
        const principal = await principalFor(ctx, scope, actor);
        const { next } = await relinkMigratedPages(actingAs(ctx, principal), principal, scope, {
          runId,
          batchSize: MIGRATION_RELINK_BATCH_MAX,
          ...(after ? { after } : {}),
        });
        return next ? { next } : {};
      }),
    );
    if ('failed' in relinked) return relinked;
    after = relinked.ok.next;
    if (!after) break;
  }
  return { ok: true };
}

/** Work done one piece at a time, in the order it was asked for, until it is closed. */
class SerialWork {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Set by the go-ahead: how many of each template's waits had ended as it came, in their order. */
  goAhead: Promise<readonly number[]> | null = null;

  /** `fn`'s result once its turn comes; null, without running it, once the work is closed. */
  run<T>(fn: () => Promise<T>): Promise<T | null> {
    const next = this.queue.then(() => (this.closed ? null : fn()));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Lets what is running finish; what is queued behind it isn't run. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}

/**
 * One template's way through a run, on its own, for as long as the run is driven. It waits for
 * `template-approved-<id>` (the first time not at all, when it was approved before the driver came
 * to it), then reads the template: approved at a version the driver hasn't taken through, its pages
 * are transformed and loaded, which is a round; anything else (the event of an earlier approval, or
 * of one reopened since) is nothing to do, and it waits again. An event is only ever a wake-up, so
 * one buffered from an earlier round can't stand in for a later approval, whatever order they are
 * read in.
 *
 * A step that finds the template no longer approved as its round began stops that round, with
 * nothing of the step recorded, and the template waits for its next approval. A template that is
 * in, or failed or timed out, is listened for as long as the run goes on: approved again, its newer
 * version is taken through. Waits are named apart (`… round 2`), and so are the steps after each,
 * so no step of one answers for another.
 */
class DrivenTemplate {
  /** The last round's outcome. */
  outcome: TemplateOutcome;
  /** Waits that have ended. */
  begun = 0;
  /** The first round's outcome, which may be that it was reopened. */
  readonly first: Promise<TemplateOutcome>;
  /** The first outcome that isn't that: loaded, failed or timed out. */
  readonly settled: Promise<TemplateOutcome>;
  private resolveFirst!: (outcome: TemplateOutcome) => void;
  private resolveSettled!: (outcome: TemplateOutcome) => void;
  private done = 0;
  private readonly watchers: { readonly waits: number; readonly resolve: () => void }[] = [];

  constructor(
    private readonly steps: WorkflowSteps,
    private readonly host: SiteMigrationRunHost,
    private readonly params: MigrationRunParams,
    private readonly template: { readonly id: string; readonly status: string },
    /** Its place among the run's templates. */
    private readonly index: number,
    private readonly work: SerialWork,
  ) {
    this.outcome = { templateId: template.id, status: 'timed-out' };
    this.first = new Promise((resolve) => {
      this.resolveFirst = resolve;
    });
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });
    void this.drive();
  }

  /** Once what followed its first `waits` waits is done. */
  finished(waits: number): Promise<void> {
    if (this.done >= waits) return Promise.resolve();
    return new Promise((resolve) => this.watchers.push({ waits, resolve }));
  }

  private report(outcome: TemplateOutcome): void {
    this.outcome = outcome;
    this.resolveFirst(outcome);
    if (outcome.status !== 'reopened') this.resolveSettled(outcome);
  }

  private async drive(): Promise<void> {
    const { id: templateId, status } = this.template;
    // The approval taken through last, as the template's version.
    let handled = 0;
    let rounds = 0;
    for (
      let wait = 0;
      wait < MIGRATION_APPROVAL_WAITS && rounds < MIGRATION_APPROVAL_ROUNDS;
      wait++
    ) {
      const woken = (wait === 0 && status === 'approved') || (await this.wait(wait));
      this.begun = wait + 1;
      if (woken) {
        const taken = await this.work.run(() =>
          processTemplate(
            this.steps,
            this.host,
            this.params,
            templateId,
            wait,
            handled,
            async () =>
              wait >= ((await this.work.goAhead)?.[this.index] ?? Number.POSITIVE_INFINITY),
          ),
        );
        if (taken) {
          if (taken.version !== handled) rounds += 1;
          handled = taken.version;
          this.report(taken.outcome);
        }
      } else if (this.outcome.status === 'reopened' || this.outcome.status === 'timed-out') {
        // What an earlier round took in stays as it was reported.
        this.report({ templateId, status: 'timed-out' });
      }
      this.done = wait + 1;
      for (const w of this.watchers) if (w.waits <= this.done) w.resolve();
    }
    if (this.outcome.status === 'reopened' || this.outcome.status === 'timed-out') {
      this.report({
        templateId,
        status: 'failed',
        error: 'Reopened more often than a background run waits for: take it on step by step',
      });
    }
  }

  /** Whether an event came: a wake-up only, so nothing of it is read. */
  private async wait(wait: number): Promise<boolean> {
    const { id } = this.template;
    try {
      await this.steps.waitForEvent<MigrationTemplateApproved>(inRound(`approval ${id}`, wait), {
        type: migrationTemplateApprovedEvent(id),
        timeout: MIGRATION_APPROVAL_TIMEOUT,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** A step's name in a round. The first keeps the bare name, which running instances recorded. */
const inRound = (name: string, round: number) =>
  round === 0 ? name : `${name} round ${round + 1}`;

/**
 * Records that the driver ended without publishing (`stopped`, with why), so starting the run
 * again is refused rather than finding the finished instance. A terminal status is kept as it is.
 * With `unless`, a run that gives something then isn't stopped, and answers it: the same
 * compare-and-set decides, so what is recorded on the run meanwhile is never stopped over.
 */
async function recordStop<T extends object>(
  steps: WorkflowSteps,
  ctx: AppContext,
  scope: Scope,
  runId: string,
  why: string,
  unless?: (run: MigrationRun) => T | null,
): Promise<T | null> {
  // `true` is what it recorded before `unless`, and when it stopped the run.
  const result = await steps.do('record stop', STEP, async (): Promise<T | true> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const run = await ctx.store.migrations.getRun(scope, runId);
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return true;
      const instead = unless?.(run);
      if (instead) return instead;
      try {
        await ctx.store.migrations.saveRun(
          scope,
          {
            ...run,
            status: 'stopped',
            error: why,
            version: run.version + 1,
            updatedAt: ctx.clock.now().toISOString(),
          },
          run.version,
        );
        return true;
      } catch (e) {
        if (!(e instanceof TransactionConflictError) || attempt === 3) throw e;
      }
    }
    return true;
  });
  return result === true ? null : result;
}

/** Inventory (once), then fetch every page a batch per step, waiting out an unreadable site. */
async function inventoryAndFetch(
  steps: WorkflowSteps,
  host: SiteMigrationRunHost,
  params: MigrationRunParams,
  run: MigrationRun,
): Promise<void> {
  const { ctx, site } = host;
  const { scope, runId } = params;
  if (run.status === 'clustered') return;
  for (let attempt = 0; ; attempt++) {
    const inventoried = unwrap(
      await steps.do(`inventory ${attempt}`, STEP, () =>
        settle(async () => {
          await principalFor(ctx, scope, params.startedBy);
          const now = await requireRun(ctx, scope, runId);
          if (now.status !== 'created') return { unavailable: null };
          try {
            await inventorySite(ctx, site, scope, runId);
            return { unavailable: null };
          } catch (err) {
            if (err instanceof SiteUnavailableError) return { unavailable: err.message };
            throw err;
          }
          // What is recorded on the run meanwhile (its go-ahead, say) is no reason to fail.
        }, 'throws'),
      ),
    );
    if (!inventoried.unavailable) break;
    if (attempt + 1 >= UNAVAILABLE_ATTEMPTS) throw new RunFailure(inventoried.unavailable);
    await steps.sleep(`inventory wait ${attempt}`, UNAVAILABLE_WAIT);
  }
  let waits = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const fetched = unwrap(
      await steps.do(`fetch ${i}`, FETCH_STEP, () =>
        settle(async () => {
          await principalFor(ctx, scope, params.startedBy);
          return fetchSourcePages(ctx, site, scope, runId, { limit: MIGRATION_FETCH_BATCH_MAX });
        }),
      ),
    );
    if (fetched.unavailable) {
      waits += 1;
      if (waits >= UNAVAILABLE_ATTEMPTS) throw new RunFailure(fetched.unavailable);
      await steps.sleep(`fetch wait ${i}`, UNAVAILABLE_WAIT);
      continue;
    }
    if (!fetched.more) return;
  }
}

/** A template as one round left it: the approval it took through, and what came of it. */
interface RoundResult {
  readonly version: number;
  readonly outcome: TemplateOutcome;
}

/** Who approved it, as recorded before rounds existed, and the version they approved. */
type Approval = MigrationActor & { readonly version?: number };

/** A step's value, or that the template isn't approved any more as its round began. */
const underApproval = async <T>(fn: () => Promise<T>): Promise<T | { readonly reopened: true }> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MigrationApprovalChangedError) return { reopened: true };
    throw err;
  }
};

/**
 * A round of an approved template: its pages transformed, then loaded, then its redirects imported.
 * Null when it holds no approval newer than `handled`. Reopened before a batch, the round stops
 * there; the next one, or the go-ahead, redirects the pages loaded by then.
 */
async function processTemplate(
  steps: WorkflowSteps,
  host: SiteMigrationRunHost,
  params: MigrationRunParams,
  templateId: string,
  round: number,
  handled: number,
  /** Whether the go-ahead came before this round: nothing is begun after it. */
  tooLate: () => Promise<boolean>,
): Promise<RoundResult | null> {
  const { ctx, authoring, load } = host;
  const { scope, runId } = params;
  const named = (name: string) => inRound(name, round);
  let version = handled;
  try {
    // The store's word, not the event's: `approveTemplate` records who approved it.
    const approval = unwrap(
      await steps.do(named(`approver ${templateId}`), STEP, () =>
        settle(async (): Promise<Approval | 'too-late' | null> => {
          if (await tooLate()) return 'too-late';
          const template = await ctx.store.migrations.getTemplate(scope, runId, templateId);
          if (template?.status !== 'approved') return null;
          if (!isMigrationActor(template.approvedBy)) {
            throw new InvalidStateError('The template has no recorded approval');
          }
          return { ...template.approvedBy, version: template.version };
        }),
      ),
    );
    if (approval === 'too-late') return null;
    if (!approval) return { version, outcome: { templateId, status: 'reopened' } };
    if (approval.version === handled) return null;
    const { version: recorded, ...approvedBy } = approval;
    version = recorded ?? handled;
    // A run driven since before templates could be reopened recorded only who approved it: its
    // round is held to the template as it is, if it is still theirs, and the next approval it hears
    // of counts as newer.
    const held =
      recorded ??
      unwrap(
        await steps.do(named(`approval held ${templateId}`), STEP, () =>
          settle(async () => {
            const t = await ctx.store.migrations.getTemplate(scope, runId, templateId);
            return t?.status === 'approved' && sameMigrationActor(t.approvedBy, approvedBy)
              ? t.version
              : null;
          }),
        ),
      );
    if (held === null) return { version, outcome: { templateId, status: 'reopened' } };
    const under = { approval: held };
    let after: string | undefined;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = unwrap(
        await steps.do(named(`transform ${templateId} ${i}`), STEP, () =>
          settle(() =>
            underApproval(() =>
              transformTemplatePages(ctx, authoring, scope, {
                runId,
                templateId,
                ...under,
                batchSize: MIGRATION_TRANSFORM_BATCH_MAX,
                ...(after ? { after } : {}),
              }),
            ),
          ),
        ),
      );
      if ('reopened' in batch) return { version, outcome: { templateId, status: 'reopened' } };
      after = batch.next;
      if (!batch.more) break;
    }
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = unwrap(
        await steps.do(named(`load ${templateId} ${i}`), STEP, () =>
          settle(() =>
            underApproval(async () => {
              const principal = await principalFor(ctx, scope, approvedBy);
              const { loaded, more } = await loadTemplatePages(
                actingAs(ctx, principal),
                load,
                principal,
                scope,
                { runId, templateId, ...under, batchSize: MIGRATION_LOAD_BATCH_MAX },
              );
              return { loaded, more };
            }),
          ),
        ),
      );
      if ('reopened' in batch) return { version, outcome: { templateId, status: 'reopened' } };
      if (!batch.more) break;
    }
    // Redirects are live at once, so they too are written only under the approval.
    const redirected = unwrap(
      await steps.do(named(`redirects ${templateId}`), STEP, () =>
        settle(() =>
          underApproval(async () => {
            const t = await ctx.store.migrations.getTemplate(scope, runId, templateId);
            if (!t) throw new NotFoundError('Migration template', templateId);
            assertSameApproval(t, held);
            const principal = await principalFor(ctx, scope, approvedBy);
            await importMigrationRedirects(actingAs(ctx, principal), principal, scope, {
              runId,
              templateId,
            });
            return {};
          }),
        ),
      ),
    );
    if (typeof redirected === 'object' && 'reopened' in redirected) {
      return { version, outcome: { templateId, status: 'reopened' } };
    }
    return { version, outcome: { templateId, status: 'loaded', approvedBy } };
  } catch (err) {
    // One template's failure (its script, its approver's access, a step out of retries) leaves
    // the others to finish.
    const error = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
    return { version, outcome: { templateId, status: 'failed', error } };
  }
}

async function principalFor(
  ctx: AppContext,
  scope: Scope,
  actor: MigrationActor,
): Promise<Principal> {
  const principal = await migrationActorPrincipal(ctx, scope, actor);
  if (!principal) {
    throw new InvalidStateError('Whoever this step acts for no longer has access to the space');
  }
  return principal;
}

/** Outcomes in a stable order (by template id), whatever order they resolved in. */
const inOrder = (outcomes: TemplateOutcome[]): TemplateOutcome[] =>
  [...outcomes].sort((a, b) =>
    a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0,
  );

async function requireRun(ctx: AppContext, scope: Scope, id: string): Promise<MigrationRun> {
  const run = await ctx.store.migrations.getRun(scope, id);
  if (!run) throw new NotFoundError('Migration run', id);
  return run;
}
