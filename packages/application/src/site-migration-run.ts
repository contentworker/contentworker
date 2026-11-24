import {
  DomainError,
  InvalidStateError,
  type MigrationRun,
  NotFoundError,
  type Principal,
  type Scope,
  scopesForKind,
} from '@contentworker/domain';
import {
  type MigrationActor,
  type MigrationPublishApproved,
  type MigrationRunParams,
  type MigrationTemplateApproved,
  TransactionConflictError,
  type WorkflowSteps,
} from '@contentworker/ports';
import type { AppContext } from './context';
import { resolveStarter } from './job-starter';
import { type TemplateAuthoringDeps, transformTemplatePages } from './site-migration-templates';
import {
  clusterPages,
  fetchSourcePages,
  inventorySite,
  type SiteMigrationDeps,
  SiteUnavailableError,
} from './site-migrations';

/**
 * A site migration run, driven start to finish: one Workflow instance per run.
 *
 * inventory → fetch the pages a batch per step (waiting out a site that can't be read now) →
 * cluster → one template agent per template, to propose its model and write its script → for
 * each template, wait for a person to approve it, then transform its pages a batch per step and
 * load them → wait for the go-ahead to publish → publish.
 *
 * The run is created before its driver starts (`createMigrationRun`, which checks the source),
 * so a caller hears about a bad source at once, and the driver's instance is named for the run.
 * Every effect is a use-case inside a step, each safe to run again: a step replayed after a crash
 * redoes nothing a finished one did, and one retried after a failure goes on from what the store
 * says. A lost compare-and-set (`TransactionConflictError`) inside a step means another writer
 * moved the run first: the step reads again and goes on.
 *
 * The agents only author: they can't approve, load or publish. Approvals and the go-ahead come
 * from people, as events ({@link migrationTemplateApprovedEvent}, {@link MIGRATION_PUBLISH_EVENT})
 * carrying who decided, and the loads and the publish act as them, resolved again at each step.
 */

/** The event a template's approval is delivered as. Workflows event types take `[A-Za-z0-9_-]`. */
export const migrationTemplateApprovedEvent = (templateId: string) =>
  `template-approved-${templateId}`;
/** The event the go-ahead to publish is delivered as. */
export const MIGRATION_PUBLISH_EVENT = 'publish-approved';
/** How long a template waits for a person to approve it, and a run for the go-ahead. */
export const MIGRATION_APPROVAL_TIMEOUT = '14 days';
/** How long a step waits before reading a site that couldn't be read again. */
const UNAVAILABLE_WAIT = '10 minutes';
/** Times a site that can't be read is waited out, in all, before the run fails. */
const UNAVAILABLE_ATTEMPTS = 12;
/** Batches the fetch, transform and load loops take at most (well over any run's pages). */
const MAX_BATCHES = 1_000;
const STEP = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;
const MAX_ERROR_LENGTH = 500;

/**
 * The load, relink, redirect and publish steps, over the use-cases that do them (they come with
 * the site migration load). Each acts as `principal`, who must hold what the use-case asks.
 */
export interface MigrationLoadSteps {
  loadTemplatePages(
    principal: Principal,
    scope: Scope,
    input: { readonly runId: string; readonly templateId: string },
  ): Promise<{ readonly loaded: number; readonly more: boolean }>;
  relinkMigratedPages(
    principal: Principal,
    scope: Scope,
    input: { readonly runId: string; readonly after?: string },
  ): Promise<{ readonly next?: string }>;
  importMigrationRedirects(
    principal: Principal,
    scope: Scope,
    input: { readonly runId: string; readonly templateId?: string },
  ): Promise<unknown>;
  publishMigration(
    principal: Principal,
    scope: Scope,
    input: {
      readonly runId: string;
      readonly viaRelease?: boolean;
      readonly releaseId?: string;
      readonly releaseTitle?: string;
      readonly after?: string;
    },
  ): Promise<{ readonly published: number; readonly next?: string }>;
}

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
  /** Absent: approved templates are transformed, and loading and publishing wait for it. */
  readonly load?: MigrationLoadSteps;
}

export interface TemplateOutcome {
  readonly templateId: string;
  readonly status: 'loaded' | 'transformed' | 'timed-out' | 'failed';
  readonly error?: string;
  /** Who approved it. */
  readonly approvedBy?: MigrationActor;
}

export interface SiteMigrationRunResult {
  readonly status: 'published' | 'loaded' | 'transformed' | 'clustered' | 'failed' | 'gone';
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
async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: await fn() };
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < 3) continue;
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
  const loaded = await steps.do('read run', STEP, async () =>
    ctx.store.migrations.getRun(scope, runId),
  );
  if (!loaded) return { status: 'gone', templates: [] };
  const outcomes: TemplateOutcome[] = [];
  try {
    if (loaded.status === 'failed') throw new RunFailure(loaded.error ?? 'the run failed');
    await inventoryAndFetch(steps, host, params, loaded);
    const templates = unwrap(
      await steps.do('cluster', STEP, () =>
        settle(async () => {
          const run = await requireRun(ctx, scope, runId);
          const view =
            run.status === 'clustered'
              ? { templates: await ctx.store.migrations.listTemplates(scope, runId) }
              : await clusterPages(ctx, scope, runId);
          return view.templates.map((t) => ({ id: t.id, status: t.status }));
        }),
      ),
    );
    if (templates.length === 0) return { status: 'clustered', templates: [] };

    for (const t of templates) {
      if (t.status === 'approved') continue;
      await steps.do(`start agent ${t.id}`, STEP, async () => {
        await host.agents.start({ scope, runId, templateId: t.id, startedBy: params.startedBy });
        return true;
      });
    }

    // Templates are approved in any order and each waits on its own; their pages are processed
    // one template at a time, so a run holds at most one batch of scripts in flight.
    let queue = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = queue.then(fn);
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    await Promise.all(
      templates.map(async (t) => {
        let approvedBy: MigrationActor = params.startedBy;
        if (t.status !== 'approved') {
          try {
            const event = await steps.waitForEvent<MigrationTemplateApproved>(`approval ${t.id}`, {
              type: migrationTemplateApprovedEvent(t.id),
              timeout: MIGRATION_APPROVAL_TIMEOUT,
            });
            approvedBy = event.payload?.approvedBy ?? params.startedBy;
          } catch {
            outcomes.push({ templateId: t.id, status: 'timed-out' });
            return;
          }
        }
        outcomes.push(await serial(() => processTemplate(steps, host, params, t.id, approvedBy)));
      }),
    );

    const load = host.load;
    // Links between templates' pages are pointed at each other once every template is in, as
    // whoever approved the first (relinking edits only the run's own entries).
    const relinker = outcomes.find((o) => o.status === 'loaded')?.approvedBy;
    if (!load || !relinker) {
      return {
        status: outcomes.some((o) => o.status === 'transformed') ? 'transformed' : 'clustered',
        templates: outcomes,
      };
    }
    let after: string | undefined;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const relinked = unwrap(
        await steps.do(`relink ${i}`, STEP, () =>
          settle(async () => {
            const principal = await actingAs(ctx, scope, relinker);
            return load.relinkMigratedPages(principal, scope, {
              runId,
              ...(after ? { after } : {}),
            });
          }),
        ),
      );
      after = relinked.next;
      if (!after) break;
    }

    let go: MigrationPublishApproved;
    try {
      const event = await steps.waitForEvent<MigrationPublishApproved>('publish approval', {
        type: MIGRATION_PUBLISH_EVENT,
        timeout: MIGRATION_APPROVAL_TIMEOUT,
      });
      go = event.payload;
    } catch {
      return { status: 'loaded', templates: outcomes };
    }
    let cursor: string | undefined;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const published = unwrap(
        await steps.do(`publish ${i}`, STEP, () =>
          settle(async () => {
            const principal = await actingAs(ctx, scope, go.approvedBy);
            return load.publishMigration(principal, scope, {
              runId,
              ...(go.viaRelease ? { viaRelease: true } : {}),
              ...(go.releaseId ? { releaseId: go.releaseId } : {}),
              ...(go.releaseTitle ? { releaseTitle: go.releaseTitle } : {}),
              ...(cursor ? { after: cursor } : {}),
            });
          }),
        ),
      );
      cursor = published.next;
      // A release takes every entry in one call.
      if (!cursor || go.viaRelease) break;
    }
    return { status: 'published', templates: outcomes };
  } catch (err) {
    if (!(err instanceof RunFailure)) throw err;
    await steps.do('record failure', STEP, async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const run = await ctx.store.migrations.getRun(scope, runId);
        if (!run || run.status === 'failed') return true;
        try {
          await ctx.store.migrations.saveRun(
            scope,
            {
              ...run,
              status: 'failed',
              error: err.message,
              version: run.version + 1,
              updatedAt: ctx.clock.now().toISOString(),
            },
            run.version,
          );
          return true;
        } catch (e) {
          if (!(e instanceof TransactionConflictError)) throw e;
        }
      }
      return false;
    });
    return { status: 'failed', templates: outcomes, error: err.message };
  }
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
          const now = await requireRun(ctx, scope, runId);
          if (now.status !== 'created') return { unavailable: null };
          try {
            await inventorySite(ctx, site, scope, runId);
            return { unavailable: null };
          } catch (err) {
            if (err instanceof SiteUnavailableError) return { unavailable: err.message };
            throw err;
          }
        }),
      ),
    );
    if (!inventoried.unavailable) break;
    if (attempt + 1 >= UNAVAILABLE_ATTEMPTS) throw new RunFailure(inventoried.unavailable);
    await steps.sleep(`inventory wait ${attempt}`, UNAVAILABLE_WAIT);
  }
  let waits = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const fetched = unwrap(
      await steps.do(`fetch ${i}`, STEP, () =>
        settle(() => fetchSourcePages(ctx, site, scope, runId)),
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

/** An approved template: its pages transformed, then loaded and redirected (when it can load). */
async function processTemplate(
  steps: WorkflowSteps,
  host: SiteMigrationRunHost,
  params: MigrationRunParams,
  templateId: string,
  approvedBy: MigrationActor,
): Promise<TemplateOutcome> {
  const { ctx, authoring, load } = host;
  const { scope, runId } = params;
  try {
    let after: string | undefined;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = unwrap(
        await steps.do(`transform ${templateId} ${i}`, STEP, () =>
          settle(() =>
            transformTemplatePages(ctx, authoring, scope, {
              runId,
              templateId,
              ...(after ? { after } : {}),
            }),
          ),
        ),
      );
      after = batch.next;
      if (!batch.more) break;
    }
    if (!load) return { templateId, status: 'transformed', approvedBy };
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = unwrap(
        await steps.do(`load ${templateId} ${i}`, STEP, () =>
          settle(async () =>
            load.loadTemplatePages(await actingAs(ctx, scope, approvedBy), scope, {
              runId,
              templateId,
            }),
          ),
        ),
      );
      if (!batch.more) break;
    }
    unwrap(
      await steps.do(`redirects ${templateId}`, STEP, () =>
        settle(async () => {
          await load.importMigrationRedirects(await actingAs(ctx, scope, approvedBy), scope, {
            runId,
            templateId,
          });
          return true;
        }),
      ),
    );
    return { templateId, status: 'loaded', approvedBy };
  } catch (err) {
    // One template's failure (its script, its approver's access) leaves the others to finish.
    if (!(err instanceof RunFailure)) throw err;
    return { templateId, status: 'failed', error: err.message };
  }
}

async function actingAs(ctx: AppContext, scope: Scope, actor: MigrationActor): Promise<Principal> {
  const principal = await migrationActorPrincipal(ctx, scope, actor);
  if (!principal) {
    throw new InvalidStateError('Whoever this step acts for no longer has access to the space');
  }
  return principal;
}

async function requireRun(ctx: AppContext, scope: Scope, id: string): Promise<MigrationRun> {
  const run = await ctx.store.migrations.getRun(scope, id);
  if (!run) throw new NotFoundError('Migration run', id);
  return run;
}
