import type { AppContext } from '@contentworker/application';
import {
  type AppOperationHostDeps,
  AppOperationWorkflowBase,
} from '@contentworker/platform/app-operations';

/**
 * What the test's operation instances run against: the test's in-memory store, with a fake plugin
 * runner standing in for Worker Loader (the sandbox has its own tests in packages/adapters).
 */
export const appOperationTestState: { ctx?: AppContext } = {};

export class AppOperationTestWorkflow extends AppOperationWorkflowBase<Cloudflare.Env> {
  protected override open(): AppOperationHostDeps {
    const { ctx } = appOperationTestState;
    if (!ctx) throw new Error('appOperationTestState is not set');
    return { ctx, close: async () => {} };
  }
}
