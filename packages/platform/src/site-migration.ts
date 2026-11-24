import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import {
  type AppContext,
  MIGRATION_PUBLISH_EVENT,
  migrationTemplateApprovedEvent,
  newTemplateAgentState,
  releaseAgentTokens,
  runSiteMigration,
  type SiteMigrationRunHost,
  type TemplateAgentDeps,
  type TemplateAgentStart,
  type TemplateAgentStarter,
  type TemplateAgentState,
  templateAgentTurn,
} from '@contentworker/application';
import {
  InvalidStateError,
  MigrationDriverFinishedError,
  type MigrationDriverStatus,
  NotFoundError,
  type Scope,
} from '@contentworker/domain';
import type {
  ChatMessage,
  ImportScriptSandbox,
  MigrationDriverState,
  MigrationPublishApproved,
  MigrationRunner,
  MigrationRunParams,
  MigrationTemplateApproved,
  WorkflowSteps,
} from '@contentworker/ports';
import { WORKFLOW_INSTANCE_EXISTS } from './asset-ingest';

/**
 * Site migrations on Cloudflare: the run's driver (`MigrationWorkflow`, one Workflows instance
 * per run), the client that starts and signals it, and the template agents (one Durable Object
 * per template) the driver starts.
 */

/** The driver instance of a run: Workflows instance ids are account-wide, run ids are UUIDv7s. */
export const migrationInstanceId = (runId: string) => `migration-${runId}`;

/** The slice of the Workflows binding the runner uses. */
export type MigrationWorkflowBinding = Pick<Workflow<MigrationRunParams>, 'createBatch' | 'get'>;

/**
 * The `MigrationRunner` port over the `MIGRATION_WF` binding. A caller checks the run is in its
 * scope (and the approver's authority) before signalling: the instance is named for the run, and
 * the driver re-reads the template's status from the store before it transforms anything, so an
 * event never stands in for an approval the store doesn't hold.
 */
export class CloudflareMigrationRunner implements MigrationRunner {
  constructor(private readonly wf: MigrationWorkflowBinding) {}

  async start(params: MigrationRunParams): Promise<MigrationDriverState> {
    const { created, errors } = await this.wf.createBatch({
      instances: [{ id: migrationInstanceId(params.runId), params }],
    });
    if (created.length > 0) return 'started';
    const [error] = errors;
    if (error?.code === WORKFLOW_INSTANCE_EXISTS) {
      // The id is taken until Workflows' retention passes, whether or not the instance still runs.
      return (await this.finished(await this.driver(params.runId))) ? 'finished' : 'running';
    }
    throw new Error(
      `Workflows did not start migration ${params.runId}: ${error ? `${error.code} ${error.message}` : 'no result'}`,
    );
  }

  async templateApproved(
    _scope: Scope,
    runId: string,
    templateId: string,
    event: MigrationTemplateApproved,
  ): Promise<void> {
    const instance = await this.waiting(runId);
    await instance.sendEvent({ type: migrationTemplateApprovedEvent(templateId), payload: event });
  }

  async publishApproved(
    _scope: Scope,
    runId: string,
    event: MigrationPublishApproved,
  ): Promise<void> {
    const instance = await this.waiting(runId);
    await instance.sendEvent({ type: MIGRATION_PUBLISH_EVENT, payload: event });
  }

  async status(_scope: Scope, runId: string): Promise<MigrationDriverStatus> {
    let instance: WorkflowInstance;
    try {
      instance = await this.driver(runId);
    } catch (err) {
      if (err instanceof NotFoundError) return 'none';
      throw err;
    }
    const { status } = await instance.status();
    if (FINISHED.has(status)) return 'finished';
    // A status this list doesn't know (`unknown`, or a newer one) is said as unknown.
    return INSTANCE_STATUS[status] ?? 'unknown';
  }

  /**
   * The run's instance. `get` throws for an id with no instance (a run driven by hand, never
   * started, or one past its retention), with no code, only `instance.not_found` in its message:
   * that is a `NotFoundError` here, so a caller can tell "nothing to signal" from a refusal. Any
   * other failure (the binding unreachable) is rethrown as it is, never read as "no driver".
   */
  private async driver(runId: string) {
    try {
      return await this.wf.get(migrationInstanceId(runId));
    } catch (err) {
      if (err instanceof Error && err.message.includes('instance.not_found')) {
        throw new NotFoundError('Migration driver', runId);
      }
      throw err;
    }
  }

  /** An instance that can still take an event: a finished one would drop it unread. */
  private async waiting(runId: string) {
    const instance = await this.driver(runId);
    if (await this.finished(instance)) throw new MigrationDriverFinishedError(runId);
    return instance;
  }

  private async finished(instance: WorkflowInstance): Promise<boolean> {
    return FINISHED.has((await instance.status()).status);
  }
}

/** Instance statuses that run no further: completed, failed or terminated. */
const FINISHED: ReadonlySet<string> = new Set(['complete', 'errored', 'terminated']);

/** The statuses of an instance that can still go on, as the run's driver reads. */
const INSTANCE_STATUS: Readonly<Record<string, MigrationDriverStatus>> = {
  queued: 'running',
  running: 'running',
  waiting: 'waiting',
  paused: 'paused',
  waitingForPause: 'paused',
};

/** What one driver invocation needs, opened per invocation and closed after it. */
export interface MigrationHostDeps extends SiteMigrationRunHost {
  close(): Promise<void>;
}

/**
 * The durable driver of a site migration run. It hands Cloudflare's `WorkflowStep` to
 * `runSiteMigration`, which owns every step; this class only binds the ports, so the engine's
 * class and the workerd test fixture share this body.
 */
export abstract class MigrationWorkflowBase<Env = unknown> extends WorkflowEntrypoint<
  Env,
  MigrationRunParams
> {
  protected abstract open(): MigrationHostDeps | Promise<MigrationHostDeps>;

  override async run(event: Readonly<WorkflowEvent<MigrationRunParams>>, step: WorkflowStep) {
    const host = await this.open();
    try {
      return await runSiteMigration(step as unknown as WorkflowSteps, host, event.payload);
    } finally {
      await host.close();
    }
  }
}

/**
 * Where import scripts can't run (no PLUGIN_LOADER): every run is refused as a domain error, so a
 * try says why and a transform step fails its template rather than retrying for ever.
 */
export const unavailableImportScriptSandbox: ImportScriptSandbox = {
  async run() {
    throw new InvalidStateError(
      'Import scripts run in Worker Loader isolates, and this install has no PLUGIN_LOADER binding',
    );
  },
};

// --- template agents --------------------------------------------------------

/** The object of one template: one agent per template of a run, whoever starts it. */
export const templateAgentName = (
  input: Pick<TemplateAgentStart, 'scope' | 'runId' | 'templateId'>,
) => `${input.scope.spaceId}:${input.scope.environmentId}:${input.runId}:${input.templateId}`;

/** What a template agent reports of itself; the conversation stays in the object. */
export interface TemplateAgentStatus {
  readonly status: TemplateAgentState['status'];
  readonly turns: number;
  readonly tokens: number;
  readonly tier: TemplateAgentState['tier'];
  readonly summary?: string;
}

/** What one turn needs, opened per alarm and closed after it. */
export interface TemplateAgentWiring {
  readonly ctx: AppContext;
  readonly deps: TemplateAgentDeps;
  close(): Promise<void>;
}

const META = 'meta';
const MESSAGE = (i: number) => `m:${String(i).padStart(5, '0')}`;
/** Turns one alarm takes before it hands over to the next (each is a model call and its tools). */
const TURNS_PER_ALARM = 3;
/** How often an agent that ended tells the run its tokens, when that failed, and how many times. */
const UNSETTLED_RETRY_MS = 5 * 60_000;
const UNSETTLED_TRIES = 24;
/** Alarms in a row that fail before the agent stops. */
const MAX_FAILURES = 5;
/** Wall time an alarm starts turns in. */
const ALARM_BUDGET_MS = 5 * 60_000;
/** How long a finished agent keeps its conversation, for a reviewer to read, before it is deleted. */
const RETAIN_MS = 30 * 24 * 60 * 60_000;

type StoredMeta = Omit<TemplateAgentState, 'messages'> & {
  readonly messageCount: number;
  readonly failures: number;
};

/**
 * One template's authoring agent, as a Durable Object: `start` records its state and sets an
 * alarm, and each alarm takes a few turns of the agent loop (`templateAgentTurn`) and sets the
 * next, until the agent is done or out of budget. Its state lives in the object's storage, each
 * message under its own key (a value has a size limit, a conversation doesn't), so an evicted or
 * restarted object goes on from its last finished turn, and counts a model call it had begun toward
 * its run's token cap. Thirty days after it finishes, its storage
 * is deleted.
 *
 * It has no fetch handler and no route: the engine's driver starts it over RPC, and nothing else
 * reaches it.
 */
export abstract class MigrationTemplateAgentBase<Env = unknown> extends DurableObject<Env> {
  protected abstract wire(
    state: TemplateAgentStart,
  ): TemplateAgentWiring | Promise<TemplateAgentWiring>;

  /**
   * Starts the agent; false when it has been started already. A running agent that has lost its
   * alarm (an alarm that couldn't set the next) gets one again, so starting is also a repair.
   */
  async start(input: TemplateAgentStart): Promise<{ started: boolean }> {
    const meta = await this.ctx.storage.get<StoredMeta>(META);
    if (meta) {
      if (meta.status === 'running' && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now());
      }
      return { started: false };
    }
    await this.save(newTemplateAgentState(input), 0, 0);
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true };
  }

  async status(): Promise<TemplateAgentStatus | null> {
    const meta = await this.ctx.storage.get<StoredMeta>(META);
    if (!meta) return null;
    return {
      status: meta.status,
      turns: meta.turns,
      tokens: meta.tokens,
      tier: meta.tier,
      ...(meta.summary ? { summary: meta.summary } : {}),
    };
  }

  override async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<StoredMeta>(META);
    if (!meta) return;
    if (meta.status !== 'running') {
      if (meta.unsettled && meta.failures < UNSETTLED_TRIES) {
        await this.settleEnded(meta);
        return;
      }
      // The alarm set when it finished: its conversation has been kept long enough.
      await this.ctx.storage.deleteAll();
      return;
    }
    let state: TemplateAgentState = { ...meta, messages: [] };
    let failures = meta.failures;
    // Messages in storage now: grows with each turn saved, so a failure after a saved turn keeps it.
    let savedCount = meta.messageCount;
    let wired: TemplateAgentWiring | undefined;
    // Turns stop starting past this, well inside an alarm's 15 minutes of wall time: a turn is a
    // model call (90 s at most) and its tools (a try is a few sandbox runs).
    const deadline = Date.now() + ALARM_BUDGET_MS;
    try {
      state = await this.load(meta);
      wired = await this.wire(state);
      for (
        let i = 0;
        i < TURNS_PER_ALARM && state.status === 'running' && Date.now() < deadline;
        i++
      ) {
        const next = await templateAgentTurn(wired.ctx, wired.deps, state, async (now) => {
          // A model call begins or ends: kept before it goes on, so a call cut short is counted.
          state = now;
          await this.saveMeta(now, savedCount, failures);
        });
        await this.save(next, savedCount, 0);
        state = next;
        failures = 0;
        savedCount = next.messages.length;
        if (state.retryAfterSeconds !== undefined) break;
      }
    } catch (err) {
      // Caught, so the alarm is never left to the runtime's few retries: a failure here is
      // counted, kept, and tried again later, until there have been too many in a row.
      failures += 1;
      // A wait an earlier turn asked for isn't this failure's: backed off instead, so nothing the
      // turn may hold is slept on.
      state = { ...state, retryAfterSeconds: undefined };
      console.error('migration template agent: a turn failed', {
        templateId: meta.templateId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (failures >= MAX_FAILURES) {
        state = { ...state, status: 'stopped', summary: 'Stopped after repeated errors' };
        state = wired ? await releaseAgentTokens(wired.ctx, state) : { ...state, unsettled: true };
      }
      try {
        // The turns this alarm saved stay: the meta names every message in storage.
        await this.saveMeta(state, savedCount, state.status === 'running' ? failures : 0);
      } catch (e) {
        console.error('migration template agent: saving its state failed', {
          templateId: meta.templateId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      await wired?.close().catch(() => undefined);
      // Always a next alarm: while it runs, the next turn (with backoff after a failure); once it
      // has finished, the one that deletes its conversation.
      const wait =
        state.status !== 'running'
          ? state.unsettled
            ? UNSETTLED_RETRY_MS
            : RETAIN_MS
          : state.retryAfterSeconds !== undefined
            ? state.retryAfterSeconds * 1000
            : failures > 0
              ? 30_000 * failures
              : 0;
      await this.ctx.storage.setAlarm(Date.now() + wait);
    }
  }

  /**
   * Tells the run what an agent that has ended used, when that failed as it ended; then its
   * retention begins. `failures` counts the tries from 0 (see {@link UNSETTLED_TRIES}).
   */
  private async settleEnded(meta: StoredMeta): Promise<void> {
    let wait = UNSETTLED_RETRY_MS;
    let wired: TemplateAgentWiring | undefined;
    const tries = meta.failures + 1;
    let state: TemplateAgentState = { ...meta, messages: [] };
    try {
      wired = await this.wire(state);
      state = await releaseAgentTokens(wired.ctx, state);
    } catch (err) {
      console.error('migration template agent: settling its tokens failed', {
        templateId: meta.templateId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await wired?.close().catch(() => undefined);
      if (!state.unsettled || tries >= UNSETTLED_TRIES) wait = RETAIN_MS;
      await this.saveMeta(state, meta.messageCount, tries);
      await this.ctx.storage.setAlarm(Date.now() + wait);
    }
  }

  /** Writes only the meta: the messages it names are those already stored. */
  private async saveMeta(
    state: TemplateAgentState,
    messageCount: number,
    failures: number,
  ): Promise<void> {
    const { messages: _, ...rest } = state;
    await this.ctx.storage.put(META, { ...rest, messageCount, failures } satisfies StoredMeta);
  }

  private async load(meta: StoredMeta): Promise<TemplateAgentState> {
    const keys = Array.from({ length: meta.messageCount }, (_, i) => MESSAGE(i));
    const messages: ChatMessage[] = [];
    // `get` takes at most 128 keys at a time.
    for (let at = 0; at < keys.length; at += 128) {
      const got = await this.ctx.storage.get<ChatMessage>(keys.slice(at, at + 128));
      for (const key of keys.slice(at, at + 128)) {
        const m = got.get(key);
        if (m) messages.push(m);
      }
    }
    const { messageCount: _, failures: __, ...rest } = meta;
    return { ...rest, messages };
  }

  /** Writes the messages from `from` on, and the state's meta, in one batch. */
  private async save(state: TemplateAgentState, from: number, failures: number): Promise<void> {
    const { messages, ...rest } = state;
    const entries: Record<string, unknown> = {
      [META]: { ...rest, messageCount: messages.length, failures } satisfies StoredMeta,
    };
    messages.slice(from).forEach((m, i) => {
      entries[MESSAGE(from + i)] = m;
    });
    // `put` takes at most 128 entries at a time; the meta goes last, so it never names a
    // message that isn't written yet.
    const all = Object.entries(entries).reverse();
    for (let at = 0; at < all.length; at += 128) {
      await this.ctx.storage.put(Object.fromEntries(all.slice(at, at + 128)));
    }
  }
}

/** The slice of a Durable Object namespace the starter uses. */
export interface TemplateAgentNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { start(input: TemplateAgentStart): Promise<{ started: boolean }> };
}

/** Starts template agents over the `MIGRATION_AGENT` namespace, one object per template. */
export function templateAgentStarter(ns: TemplateAgentNamespace): TemplateAgentStarter {
  return {
    async start(input) {
      await ns.get(ns.idFromName(templateAgentName(input))).start(input);
    },
  };
}
