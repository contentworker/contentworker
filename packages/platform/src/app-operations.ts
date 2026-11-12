import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type AppContext, runAppOperationJob } from '@contentworker/application';
import type {
  AppOperationJobParams,
  AppOperationJobStarter,
  WorkflowSteps,
} from '@contentworker/ports';
import { WORKFLOW_INSTANCE_EXISTS } from './asset-ingest';

/** The slice of the Workflows binding the starter uses. */
export type AppOperationWorkflowBinding = Pick<Workflow<AppOperationJobParams>, 'createBatch'>;

/**
 * The AppOperationJobStarter port over the `APP_OPERATION_WF` binding: one instance per job,
 * under the job's id, so a redelivered `app_operation.requested` finds the run that exists
 * (`false`) rather than starting a second. Any other error throws, and the event is retried.
 */
export class CloudflareAppOperationJobStarter implements AppOperationJobStarter {
  constructor(private readonly wf: AppOperationWorkflowBinding) {}

  async start(params: AppOperationJobParams): Promise<boolean> {
    const { created, errors } = await this.wf.createBatch({
      instances: [{ id: `appop-${params.jobId}`, params }],
    });
    if (created.length > 0) return true;
    const [error] = errors;
    if (error?.code === WORKFLOW_INSTANCE_EXISTS) return false;
    throw new Error(
      `Workflows did not start operation job ${params.jobId}: ${error ? `${error.code} ${error.message}` : 'no result'}`,
    );
  }
}

/** What one job's run needs, opened per invocation and closed after it. */
export interface AppOperationHostDeps {
  readonly ctx: AppContext;
  close(): Promise<void>;
}

/**
 * The durable host for async plugin operations: one Workflows instance per job. It hands
 * Cloudflare's `WorkflowStep` to `runAppOperationJob`, which owns every step; this class only
 * binds the ports, so the engine's class and the workerd test fixture share this body.
 */
export abstract class AppOperationWorkflowBase<Env = unknown> extends WorkflowEntrypoint<
  Env,
  AppOperationJobParams
> {
  protected abstract open(): AppOperationHostDeps | Promise<AppOperationHostDeps>;

  override async run(event: Readonly<WorkflowEvent<AppOperationJobParams>>, step: WorkflowStep) {
    const host = await this.open();
    try {
      return await runAppOperationJob(step as unknown as WorkflowSteps, host.ctx, event.payload);
    } finally {
      await host.close();
    }
  }
}
