import {
  type AppOperationHostDeps,
  AppOperationWorkflowBase,
} from '@contentworker/platform/app-operations';
import type { EdgeEnv } from '@contentworker/platform/env';
import { wireEdge } from '@contentworker/platform/wire';

/**
 * Async plugin operations on Cloudflare Workflows (binding `APP_OPERATION_WF`): one instance per
 * job, started by the events consumer from `app_operation.requested`. Each invocation wires as a
 * request does (`wireEdge`), so the plugin runs on the same Worker Loader runtime, with the same
 * capabilities, as a sync call; only its budget is longer.
 *
 * This class is a composition-root export, deployed by the engine Worker (apps/engine).
 */
export class AppOperationWorkflow extends AppOperationWorkflowBase<EdgeEnv> {
  protected override open(): AppOperationHostDeps {
    const wired = wireEdge(this.env);
    return { ctx: wired.ctx, close: () => wired.close() };
  }
}
