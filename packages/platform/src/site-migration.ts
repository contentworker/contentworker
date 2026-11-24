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
  runSiteMigration,
  type SiteMigrationRunHost,
  type TemplateAgentDeps,
  type TemplateAgentStart,
  type TemplateAgentStarter,
  type TemplateAgentState,
  templateAgentTurn,
} from '@contentworker/application';
import { InvalidStateError, type Scope } from '@contentworker/domain';
import type {
  ChatMessage,
  ImportScriptSandbox,
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

  async start(params: MigrationRunParams): Promise<boolean> {
    const { created, errors } = await this.wf.createBatch({
      instances: [{ id: migrationInstanceId(params.runId), params }],
    });
    if (created.length > 0) return true;
    const [error] = errors;
    if (error?.code === WORKFLOW_INSTANCE_EXISTS) return false;
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
    const instance = await this.wf.get(migrationInstanceId(runId));
    await instance.sendEvent({ type: migrationTemplateApprovedEvent(templateId), payload: event });
  }

  async publishApproved(
    _scope: Scope,
    runId: string,
    event: MigrationPublishApproved,
  ): Promise<void> {
    const instance = await this.wf.get(migrationInstanceId(runId));
    await instance.sendEvent({ type: MIGRATION_PUBLISH_EVENT, payload: event });
  }
}

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
/** Alarms in a row that fail before the agent stops (the alarm's own retries come first). */
const MAX_FAILURES = 5;

type StoredMeta = Omit<TemplateAgentState, 'messages'> & {
  readonly messageCount: number;
  readonly failures: number;
};

/**
 * One template's authoring agent, as a Durable Object: `start` records its state and sets an
 * alarm, and each alarm takes a few turns of the agent loop (`templateAgentTurn`) and sets the
 * next, until the agent is done or out of budget. Its state lives in the object's storage, each
 * message under its own key (a value has a size limit, a conversation doesn't), so an evicted or
 * restarted object goes on from its last finished turn.
 *
 * It has no fetch handler and no route: the engine's driver starts it over RPC, and nothing else
 * reaches it.
 */
export abstract class MigrationTemplateAgentBase<Env = unknown> extends DurableObject<Env> {
  protected abstract wire(
    state: TemplateAgentStart,
  ): TemplateAgentWiring | Promise<TemplateAgentWiring>;

  /** Starts the agent; false (and nothing changed) when it has been started already. */
  async start(input: TemplateAgentStart): Promise<{ started: boolean }> {
    if (await this.ctx.storage.get<StoredMeta>(META)) return { started: false };
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
    if (meta?.status !== 'running') return;
    let state = await this.load(meta);
    let failures = meta.failures;
    const wired = await this.wire(state);
    try {
      for (let i = 0; i < TURNS_PER_ALARM && state.status === 'running'; i++) {
        const before = state.messages.length;
        state = await templateAgentTurn(wired.ctx, wired.deps, state);
        failures = 0;
        await this.save(state, before, failures);
        if (state.retryAfterSeconds !== undefined) break;
      }
    } catch (err) {
      failures += 1;
      console.error('migration template agent: a turn failed', {
        templateId: state.templateId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (failures >= MAX_FAILURES) {
        state = { ...state, status: 'stopped', summary: 'Stopped after repeated errors' };
      }
      await this.save(state, state.messages.length, failures);
    } finally {
      await wired.close();
    }
    if (state.status !== 'running') return;
    const wait =
      state.retryAfterSeconds !== undefined
        ? state.retryAfterSeconds * 1000
        : failures > 0
          ? 30_000 * failures
          : 0;
    await this.ctx.storage.setAlarm(Date.now() + wait);
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
