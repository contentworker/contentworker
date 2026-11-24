import type { AppContext } from '@contentworker/application';
import {
  type MigrationHostDeps,
  MigrationTemplateAgentBase,
  MigrationWorkflowBase,
  type TemplateAgentWiring,
} from '@contentworker/platform/site-migration';
import type {
  AIProvider,
  BlobStore,
  ImportScriptSandbox,
  RemoteFetcher,
  SiteSource,
} from '@contentworker/ports';

/**
 * What the test's migration driver and template agents run against: the test's in-memory store,
 * a fake site, a scripted sandbox, model and fetcher, and a record of the agents the driver started.
 * Workers AI and Worker Loader can't run in the pool (see vitest.config.ts), so both are stubs.
 */
export const migrationTestState: {
  ctx?: AppContext;
  blob?: BlobStore;
  source?: SiteSource;
  sandbox?: ImportScriptSandbox;
  ai?: AIProvider;
  fetcher?: RemoteFetcher;
  started: string[];
} = { started: [] };

function required() {
  const { ctx, blob, source, sandbox } = migrationTestState;
  if (!ctx || !blob || !source || !sandbox) throw new Error('migrationTestState is not set');
  return { ctx, blob, source, sandbox };
}

export class MigrationTestWorkflow extends MigrationWorkflowBase<Cloudflare.Env> {
  protected override open(): MigrationHostDeps {
    const { ctx, blob, source, sandbox } = required();
    return {
      ctx,
      site: { source, blob },
      authoring: { blob, sandbox },
      agents: {
        async start(input) {
          migrationTestState.started.push(input.templateId);
        },
      },
      load: { blob, fetcher: migrationTestState.fetcher as RemoteFetcher },
      close: async () => {},
    };
  }
}

export class MigrationTestAgent extends MigrationTemplateAgentBase<Cloudflare.Env> {
  protected override wire(): TemplateAgentWiring {
    const { ctx, blob, sandbox } = required();
    const { ai } = migrationTestState;
    if (!ai) throw new Error('migrationTestState.ai is not set');
    return { ctx, deps: { ai, blob, sandbox }, close: async () => {} };
  }
}
