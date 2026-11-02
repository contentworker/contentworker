import { type AppContext, auditActor, recordAudit } from '@contentworker/application';
import type { Principal } from '@contentworker/domain';

/**
 * The MCP half of the audit trail. REST's `auditMiddleware` records every successful mutating
 * request; a tool call is the same capability reached another way, so a tool that changed
 * something records the same row: who, what, which space and environment, which target. The
 * action is `MCP <tool>` where REST's is `<METHOD> <route>`.
 *
 * Reads never write here (one writer per database: no per-request writes on read paths). A tool
 * is a write unless it is listed below, so a new tool is audited until someone decides otherwise.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'docs_list',
  'docs_read',
  'docs_search',
  // Fetches oEmbed metadata and returns it; writes nothing in the space.
  'embed_resolve',
  'model_list_content_types',
  'model_get_content_type',
  'model_entry_counts',
  'model_typescript',
  'entries_suggest',
  'entries_query',
  'entries_get',
  'entries_list_trashed',
  'entries_list_versions',
  'entries_diff_versions',
  'content_search',
  'content_semantic_search',
  'content_related',
  'content_duplicates',
  'search_index_health',
  'scheduler_status',
  'generate_draft',
  'entry_from_canvas',
  'bulk_job_status',
  'bulk_job_report',
  'roles_list',
  'role_presets_list',
  'team_list',
  'plugins_list',
  'plugin_get_settings',
  'import_sources',
  'import_analyze',
  'environment_export',
  'environments_compare',
  'environment_aliases_list',
  'oauth_connections_list',
  'webhooks_list',
  'webhook_deliveries',
  'functions_list',
  'app_extensions_list',
  'ai_actions_list',
  'releases_list',
  'releases_get',
  'comments_list',
  'tasks_list',
  'workflow_list',
  'workflow_versions',
  'workflow_validate',
  'workflow_copilot',
  'workflow_run_list',
  'workflow_run_get',
  'workflow_task_list',
  'taxonomy_list_tags',
  'taxonomy_list_concepts',
  'agent_schedule_list',
  'agent_review_list',
  'approvals_count',
  'audit_log_list',
  'assets_list',
  'assets_search',
  'asset_preview_list',
  'asset_preview_get',
  'asset_folders_list',
  'asset_collections_list',
  'asset_collections_get',
  'asset_collection_assets_list',
  'share_links_list',
  'share_link_get',
  'asset_zip_get',
  'asset_zips_list',
  'asset_renditions_list',
  'asset_versions_list',
  'asset_usage',
  'asset_transform_url',
  'asset_upload_parts',
  'spaces_list',
  'promotion_list',
  'promotion_get',
]);

type Args = Record<string, unknown>;

/** Tools that write only when asked to; otherwise they return a proposal or a report. */
const WRITES_WHEN: Readonly<Record<string, (args: Args) => boolean>> = {
  entry_translate: (a) => a.apply === true,
  entry_summarize: (a) => a.apply === true,
  entry_autofill_field: (a) => a.apply === true,
  entry_suggest_tags: (a) => a.apply === true,
  entry_audit: (a) => a.createTasks === true,
  ai_action_run: (a) => a.apply === true,
  asset_generate_alt_text: (a) => a.apply === true,
  asset_auto_tag: (a) => a.apply === true,
  environment_import: (a) => a.dryRun !== true,
  environment_clone: (a) => a.dryRun !== true,
};

/** Whether a call to `tool` with `args` changes anything, and so belongs in the audit trail. */
export function toolMutates(tool: string, args: Args): boolean {
  if (READ_ONLY_TOOLS.has(tool)) return false;
  return WRITES_WHEN[tool]?.(args) ?? true;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Which of a tool's arguments its input schema declares (a Zod object's shape). */
export function declaredArgs(inputSchema: unknown): ReadonlySet<string> {
  const shape = (inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return new Set(shape ? Object.keys(shape) : []);
}

export interface ToolAuditInput {
  readonly tool: string;
  /** The arguments after environment resolution: an alias already names its target. */
  readonly args: Args;
  /** The arguments the tool's schema declares, to tell a defaulted scope from no scope. */
  readonly declared: ReadonlySet<string>;
  readonly principal: Principal;
  readonly defaultSpace: string;
  readonly defaultEnvironment: string;
}

/**
 * Records one successful mutating tool call. The space and environment are the ones the tool
 * acted in (the server's defaults when the call left them out, as `scopeOf` does); a tool with
 * no space (none declared, no `spaceId` named) has nowhere to file a row and records none. Like
 * REST's, a failed audit write never fails the call.
 */
export async function auditToolCall(ctx: AppContext, input: ToolAuditInput): Promise<void> {
  const { tool, args, declared } = input;
  if (!toolMutates(tool, args)) return;
  const spaceId = declared.has('space')
    ? (str(args.space) ?? input.defaultSpace)
    : str(args.spaceId);
  if (!spaceId) return;
  try {
    await recordAudit(ctx, {
      spaceId,
      environmentId: declared.has('environment')
        ? (str(args.environment) ?? input.defaultEnvironment)
        : undefined,
      actor: auditActor(input.principal),
      action: `MCP ${tool}`,
      targetId: str(args.id) ?? str(args.apiId) ?? str(args.alias),
      status: 200,
    });
  } catch {
    /* auditing must never break the tool call */
  }
}
