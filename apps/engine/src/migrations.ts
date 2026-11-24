/**
 * Site migrations on the engine: the run's driver (`MigrationWorkflow`, binding `MIGRATION_WF`)
 * and the template agents it starts (`MigrationTemplateAgent`, binding `MIGRATION_AGENT`). Each
 * wires as a request does (`wireEdge`), so a script runs on the same Worker Loader sandbox and a
 * template is written through the same use-cases as an operator's call.
 *
 * Both classes are composition-root exports, deployed by the engine Worker.
 */
import { doAgentCostGuardFromEnv } from '@contentworker/platform/do/cost-guard';
import { type EdgeEnv, withJurisdiction } from '@contentworker/platform/env';
import {
  type MigrationHostDeps,
  MigrationTemplateAgentBase,
  MigrationWorkflowBase,
  type TemplateAgentWiring,
  templateAgentStarter,
  unavailableImportScriptSandbox,
} from '@contentworker/platform/site-migration';
import { wireEdge } from '@contentworker/platform/wire';

export class MigrationWorkflow extends MigrationWorkflowBase<EdgeEnv> {
  protected override open(): MigrationHostDeps {
    const env = withJurisdiction(this.env);
    const wired = wireEdge(env);
    if (!env.MIGRATION_AGENT)
      throw new Error('MigrationWorkflow needs the MIGRATION_AGENT binding');
    return {
      ctx: wired.ctx,
      site: { source: wired.siteSource, blob: wired.blob },
      authoring: {
        blob: wired.blob,
        sandbox: wired.importScriptSandbox ?? unavailableImportScriptSandbox,
      },
      agents: templateAgentStarter(env.MIGRATION_AGENT),
      // The load, relink, redirect and publish steps are bound here once the load use-cases land.
      close: () => wired.close(),
    };
  }
}

export class MigrationTemplateAgent extends MigrationTemplateAgentBase<EdgeEnv> {
  protected override wire(): TemplateAgentWiring {
    const env = withJurisdiction(this.env);
    const wired = wireEdge(env);
    // Background work: with AI_AGENT_* ceilings set, it spends the agent window, not the one
    // people's requests draw on.
    const costGuard = doAgentCostGuardFromEnv(env) ?? wired.ctx.costGuard;
    return {
      ctx: { ...wired.ctx, ...(costGuard ? { costGuard } : {}) },
      deps: {
        ai: wired.ai,
        blob: wired.blob,
        sandbox: wired.importScriptSandbox ?? unavailableImportScriptSandbox,
      },
      close: () => wired.close(),
    };
  }
}
