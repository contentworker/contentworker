import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  type AppContext,
  type AssetIngestDeps,
  type IngestSummary,
  importDocumentInbox,
  runAssetIngest,
} from '@contentworker/application';
import type {
  AssetIngestParams,
  AssetIngestQueue,
  AssetIngestStarter,
  WorkflowSteps,
} from '@contentworker/ports';

/** Workflows' code for "an instance with this ID already exists" (createBatch's per-entry error). */
export const WORKFLOW_INSTANCE_EXISTS = 10405;

/** The slice of the Workflows binding the starter uses. */
export type AssetIngestWorkflowBinding = Pick<Workflow<AssetIngestParams>, 'createBatch'>;

/**
 * The AssetIngestStarter port over the `ASSET_INGEST_WF` binding. It creates through the object
 * form of `createBatch`, which reports an id already in use as a per-entry error with a stable
 * code rather than throwing: that one answer (the other trigger of the same upload, or a
 * redelivery) is the run that exists, so `false`. Every other error throws, and the queue
 * message that asked is retried.
 */
export class CloudflareAssetIngestStarter implements AssetIngestStarter {
  constructor(private readonly wf: AssetIngestWorkflowBinding) {}

  async start(instanceId: string, params: AssetIngestParams): Promise<boolean> {
    const { created, errors } = await this.wf.createBatch({
      instances: [{ id: instanceId, params }],
    });
    if (created.length > 0) return true;
    const [error] = errors;
    if (error?.code === WORKFLOW_INSTANCE_EXISTS) return false;
    throw new Error(
      `Workflows did not start ${instanceId}: ${error ? `${error.code} ${error.message}` : 'no result'}`,
    );
  }
}

/** What one ingest invocation needs, opened per invocation and closed after it. */
export interface AssetIngestHostDeps {
  readonly ctx: AppContext;
  readonly deps: AssetIngestDeps;
  readonly queue?: AssetIngestQueue;
  readonly starter?: AssetIngestStarter;
  close(): Promise<void>;
}

/**
 * The durable host for asset ingest: one Workflows instance per file version (see
 * `assetIngestInstanceId`), whose payload names the scope, the asset and the version. It hands
 * Cloudflare's `WorkflowStep` to `runAssetIngest`, which owns every step; this class only binds
 * the ports. Wiring is abstract so the engine's class (D1, R2, Images, Workers AI, Vectorize, the
 * search shards) and the workerd test fixture (fakes) share this body.
 */
export abstract class AssetIngestWorkflowBase<Env = unknown> extends WorkflowEntrypoint<
  Env,
  AssetIngestParams
> {
  protected abstract open(): AssetIngestHostDeps | Promise<AssetIngestHostDeps>;

  override async run(
    event: Readonly<WorkflowEvent<AssetIngestParams>>,
    step: WorkflowStep,
  ): Promise<IngestSummary> {
    const host = await this.open();
    try {
      if (event.payload.inbox) {
        if (!host.queue) throw new Error('Document inbox requires the asset queue');
        await importDocumentInbox(
          step as unknown as WorkflowSteps,
          host.ctx,
          host.deps.blob,
          host.queue,
          event.payload,
        );
        return { outcome: 'continued' };
      }
      // The port is the slice of `WorkflowStep` the run uses; every step result is plain JSON.
      return await runAssetIngest(
        step as unknown as WorkflowSteps,
        host.ctx,
        host.starter
          ? { ...host.deps, continuation: { starter: host.starter, instanceId: event.instanceId } }
          : host.deps,
        event.payload,
      );
    } finally {
      await host.close();
    }
  }
}
