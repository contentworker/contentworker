import {
  DomainError,
  InvalidStateError,
  type MigrationActor,
  type MigrationRun,
  NotFoundError,
  type Principal,
  type Scope,
  scopesForKind,
} from '@contentworker/domain';
import {
  type MigrationPublishApproved,
  type MigrationRunParams,
  type MigrationTemplateApproved,
  TransactionConflictError,
  type WorkflowSteps,
} from '@contentworker/ports';
import { type AppContext, actingAs } from './context';
import { resolveStarter } from './job-starter';
import {
  importMigrationRedirects,
  loadTemplatePages,
  type MigrationLoadDeps,
  publishMigration,
  relinkMigratedPages,
} from './site-migration-load';
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
 * from people, as events ({@link migrationTemplateApprovedEvent}, {@link MIGRATION_PUBLISH_EVENT}).
 * An approval is a wake-up: who approved is read from the template (`approvedBy`), never from
 * the event. The go-ahead names who gave it. Every actor (the run's starter too) is resolved
 * again before each step that acts for them.
 */

/** The event a template's approval is delivered as. Workflows event types take `[A-Za-z0-9_-]`. */
export const migrationTemplateApprovedEvent = (templateId: string) =>
  `template-approved-${templateId}`;
/** The event the go-ahead to publish is delivered as. */
export const MIGRATION_PUBLISH_EVENT = 'publish-approved';
/** How long a template waits for a person to approve it, and a run for the go-ahead. */
export const MIGRATION_APPROVAL_TIMEOUT = '14 days';
/** Templates a run's driver takes through (largest first); the rest are left to its callers. */
export const MIGRATION_DRIVEN_TEMPLATES = 50;
/** Templates a run starts an agent for (largest first); a person authors the rest. */
export const MIGRATION_AGENTS_PER_RUN = 20;
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
  /** `not-driven`: past {@link MIGRATION_DRIVEN_TEMPLATES}, left for its callers to take through. */
  readonly status: 'loaded' | 'timed-out' | 'failed' | 'not-driven';
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
          await principalFor(ctx, scope, params.startedBy);
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
    // Largest first (as clustering returns them). A site of many one-off pages is many templates:
    // agents and the driver's waits are kept to the ones that cover most of it.
    const driven = templates.slice(0, MIGRATION_DRIVEN_TEMPLATES);
    const skipped: TemplateOutcome[] = templates
      .slice(MIGRATION_DRIVEN_TEMPLATES)
      .map((t) => ({ templateId: t.id, status: 'not-driven' }));

    for (const t of driven.slice(0, MIGRATION_AGENTS_PER_RUN)) {
      if (t.status === 'approved') continue;
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
      driven.map(async (t) => {
        if (t.status !== 'approved') {
          try {
            // A wake-up only: who approved it is read from the template.
            await steps.waitForEvent<MigrationTemplateApproved>(`approval ${t.id}`, {
              type: migrationTemplateApprovedEvent(t.id),
              timeout: MIGRATION_APPROVAL_TIMEOUT,
            });
          } catch {
            outcomes.push({ templateId: t.id, status: 'timed-out' });
            return;
          }
        }
        outcomes.push(await serial(() => processTemplate(steps, host, params, t.id)));
      }),
    );
    outcomes.push(...skipped);

    // Links between templates' pages are pointed at each other once every template is in, as
    // whoever approved the first (relinking edits only the run's own entries).
    // In the templates' order, not the order approvals came in: a replay resolves its waits in
    // call order, and every relink step must act as the same person.
    const ordered = templates.flatMap((t) => outcomes.filter((o) => o.templateId === t.id));
    outcomes.splice(0, outcomes.length, ...ordered);
    const relinker = outcomes.find((o) => o.status === 'loaded')?.approvedBy;
    if (!relinker) {
      return { status: 'clustered', templates: outcomes };
    }
    let after: string | undefined;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const relinked = unwrap(
        await steps.do(`relink ${i}`, STEP, () =>
          settle(async () => {
            const principal = await principalFor(ctx, scope, relinker);
            const { next } = await relinkMigratedPages(actingAs(ctx, principal), principal, scope, {
              runId,
              ...(after ? { after } : {}),
            });
            return next ? { next } : {};
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
    // Fails closed: a go-ahead that names nobody publishes nothing.
    if (!isActor(go?.approvedBy)) throw new RunFailure('The go-ahead to publish names no approver');
    let cursor: string | undefined;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const published = unwrap(
        await steps.do(`publish ${i}`, STEP, () =>
          settle(async () => {
            const principal = await principalFor(ctx, scope, go.approvedBy);
            const { published, next } = await publishMigration(
              actingAs(ctx, principal),
              principal,
              scope,
              {
                runId,
                ...(go.viaRelease ? { viaRelease: true } : {}),
                ...(go.releaseId ? { releaseId: go.releaseId } : {}),
                ...(go.releaseTitle ? { releaseTitle: go.releaseTitle } : {}),
                ...(cursor ? { after: cursor } : {}),
              },
            );
            return { published, ...(next ? { next } : {}) };
          }),
        ),
      );
      cursor = published.next;
      // A release takes every entry in one call.
      if (!cursor || go.viaRelease) break;
    }
    return { status: 'published', templates: outcomes };
  } catch (err) {
    // Any failure is recorded on the run: a step that ran out of retries rethrows a serialized
    // error (not the class it threw), and a run left in flight for ever helps nobody.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
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
              error: message,
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
    return { status: 'failed', templates: inOrder(outcomes), error: message };
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
      await steps.do(`fetch ${i}`, FETCH_STEP, () =>
        settle(async () => {
          await principalFor(ctx, scope, params.startedBy);
          return fetchSourcePages(ctx, site, scope, runId);
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

/** An approved template: its pages transformed, then loaded, then its redirects imported. */
async function processTemplate(
  steps: WorkflowSteps,
  host: SiteMigrationRunHost,
  params: MigrationRunParams,
  templateId: string,
): Promise<TemplateOutcome> {
  const { ctx, authoring, load } = host;
  const { scope, runId } = params;
  try {
    // The store's word, not the event's: `approveTemplate` records who approved it.
    const approvedBy = unwrap(
      await steps.do(`approver ${templateId}`, STEP, () =>
        settle(async () => {
          const template = await ctx.store.migrations.getTemplate(scope, runId, templateId);
          if (template?.status !== 'approved' || !isActor(template.approvedBy)) {
            throw new InvalidStateError('The template has no recorded approval');
          }
          return template.approvedBy;
        }),
      ),
    );
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
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = unwrap(
        await steps.do(`load ${templateId} ${i}`, STEP, () =>
          settle(async () => {
            const principal = await principalFor(ctx, scope, approvedBy);
            const { loaded, more } = await loadTemplatePages(
              actingAs(ctx, principal),
              load,
              principal,
              scope,
              { runId, templateId },
            );
            return { loaded, more };
          }),
        ),
      );
      if (!batch.more) break;
    }
    unwrap(
      await steps.do(`redirects ${templateId}`, STEP, () =>
        settle(async () => {
          const principal = await principalFor(ctx, scope, approvedBy);
          await importMigrationRedirects(actingAs(ctx, principal), principal, scope, {
            runId,
            templateId,
          });
          return true;
        }),
      ),
    );
    return { templateId, status: 'loaded', approvedBy };
  } catch (err) {
    // One template's failure (its script, its approver's access, a step out of retries) leaves
    // the others to finish.
    const error = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
    return { templateId, status: 'failed', error };
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

const isActor = (v: unknown): v is MigrationActor => {
  const a = v as Partial<Record<string, unknown>> | null | undefined;
  return (
    (a?.kind === 'key' && typeof a.keyId === 'string') ||
    (a?.kind === 'member' && typeof a.memberId === 'string') ||
    a?.kind === 'deployment'
  );
};

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
