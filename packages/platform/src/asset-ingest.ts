import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  type AppContext,
  type AssetIngestDeps,
  type IngestSummary,
  runAssetIngest,
} from '@contentworker/application';
import type {
  AssetIngestParams,
  AssetIngestQueue,
  AssetIngestStarter,
  WorkflowSteps,
} from '@contentworker/ports';
import type { AssetIngestMessage, ObjectCreatedMessage } from './messages';

/** Messages per `sendBatch` (the Queues limit). */
const SEND_BATCH = 100;

/**
 * The AssetIngestQueue port over the `contentworker-asset-events` producer. An upload's message
 * has the shape of R2's own notification, so the engine has one path for both.
 */
export function createAssetIngestQueue(queue: Pick<Queue, 'send' | 'sendBatch'>): AssetIngestQueue {
  return {
    async objectCreated(key) {
      const body: ObjectCreatedMessage = {
        action: 'PutObject',
        object: { key },
        eventTime: new Date().toISOString(),
      };
      await queue.send(body);
    },
    async request(requests) {
      const bodies = requests.map((r): AssetIngestMessage => ({ kind: 'asset.ingest', ...r }));
      for (let at = 0; at < bodies.length; at += SEND_BATCH) {
        await queue.sendBatch(bodies.slice(at, at + SEND_BATCH).map((body) => ({ body })));
      }
    },
  };
}

/** Workflows' answer for an instance id already in use. */
const alreadyExists = (err: unknown) => /already|exists/i.test(String(err));

/**
 * The AssetIngestStarter port over the `ASSET_INGEST_WF` binding. An id already used (by the
 * other trigger of the same upload, or a redelivery) is the run that exists, not an error.
 */
export class CloudflareAssetIngestStarter implements AssetIngestStarter {
  constructor(private readonly wf: Workflow) {}

  async start(instanceId: string, params: AssetIngestParams): Promise<void> {
    await this.wf.create({ id: instanceId, params }).catch((err: unknown) => {
      if (!alreadyExists(err)) throw err;
    });
  }
}

/** What one ingest invocation needs, opened per invocation and closed after it. */
export interface AssetIngestHostDeps {
  readonly ctx: AppContext;
  readonly deps: AssetIngestDeps;
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
      // The port is the slice of `WorkflowStep` the run uses; every step result is plain JSON.
      return await runAssetIngest(
        step as unknown as WorkflowSteps,
        host.ctx,
        host.deps,
        event.payload,
      );
    } finally {
      await host.close();
    }
  }
}
