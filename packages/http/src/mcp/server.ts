import {
  getPreviewEntry,
  resolveEnvironment,
  resolveWritableEnvironment,
} from '@contentworker/application';
import {
  authorize,
  authorizeContent,
  type ContentAction,
  inScope,
  type PermissionScope,
  type Principal,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import { redactCredentials } from '@contentworker/redaction';
import { McpServer } from '@modelcontextprotocol/server';
import type { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { toHttpError } from '../api/http';
import { auditToolCall, declaredArgs, declaresReadOnly } from './audit';
import type { McpDeps } from './deps';
import { registerAgentTools } from './tools/agents';
import { registerAiActionTools } from './tools/ai-actions';
import { registerAiContentTools } from './tools/ai-content';
import { registerAppExtensionTools } from './tools/app-extensions';
import { registerAssetCollectionTools } from './tools/asset-collections';
import { registerAssetVersionTools } from './tools/asset-versions';
import { registerAssetTools } from './tools/assets';
import { registerAuditLogTools } from './tools/audit-log';
import { registerCollaborationTools } from './tools/collaboration';
import { registerDocsTools } from './tools/docs';
import { registerEnvironmentAliasTools } from './tools/environment-aliases';
import { registerEnvironmentMergeTools } from './tools/environment-merge';
import { registerFunctionTools } from './tools/functions';
import { registerImportTools } from './tools/imports';
import { registerInviteTools } from './tools/invites';
import { registerOAuthConnectionTools } from './tools/oauth-connections';
import { registerPluginTools } from './tools/plugins';
import { registerPromotionTools } from './tools/promotions';
import { registerReadTools } from './tools/read';
import { registerRedirectTools } from './tools/redirects';
import { registerReleaseTools } from './tools/releases';
import { registerRoleTools } from './tools/roles';
import { DEFAULT_ENV, DEFAULT_SPACE, ok, type ToolContext } from './tools/shared';
import { registerSnapshotTools } from './tools/snapshots';
import { registerSpaceExportTools } from './tools/space-export';
import { registerSpaceTools } from './tools/spaces';
import { registerTaxonomyTools } from './tools/taxonomy';
import { registerTrashTools } from './tools/trash';
import { registerVersionTools } from './tools/versions';
import { registerWebhookTools } from './tools/webhooks';
import { registerWorkflowTools } from './tools/workflows';
import { registerWriteTools } from './tools/write';

/**
 * What a tool call that failed inside the server says, in place of the failure, as REST does: a
 * domain error (not found, forbidden, invalid, a conflict, not configured) keeps its own words,
 * which REST shows too; anything else (a database's, a binding's error) is REST's
 * "Internal server error", and its words never reach the caller.
 */
export const INTERNAL_TOOL_ERROR = 'Internal server error';

/** A tool handler's failure as the caller may see it; internal ones are logged here instead. */
function toolFailure(tool: string, err: unknown): unknown {
  if ((toHttpError(err).body as { error?: { code?: string } }).error?.code !== 'internal')
    return err;
  console.error(JSON.stringify({ msg: 'mcp: tool failed', tool, error: redactCredentials(err) }));
  return new Error(INTERNAL_TOOL_ERROR);
}

/**
 * A validation failure as a tool result rather than a thrown error: a thrown error reaches the
 * caller as its message alone, and "One or more fields are invalid" tells an agent nothing it can
 * fix. The text is REST's 422 body, so each issue names its field path (`body[0].heading`), its
 * locale and what is wrong, exactly as an HTTP client sees it.
 */
function validationResult(err: ValidationError) {
  return { ...ok(toHttpError(err).body), isError: true as const };
}

/**
 * Every area's tools, in registration order (the order tools/list returns them in). A new
 * area adds its own file under `tools/` and one line here.
 */
const TOOL_AREAS: readonly ((server: McpServer, t: ToolContext) => void)[] = [
  registerDocsTools,
  registerReadTools,
  registerAiContentTools,
  registerRoleTools,
  registerPluginTools,
  registerImportTools,
  registerSpaceExportTools,
  registerSnapshotTools,
  registerOAuthConnectionTools,
  registerWebhookTools,
  registerFunctionTools,
  registerAppExtensionTools,
  registerAiActionTools,
  registerWriteTools,
  registerTrashTools,
  registerVersionTools,
  registerReleaseTools,
  registerCollaborationTools,
  registerWorkflowTools,
  registerRedirectTools,
  registerTaxonomyTools,
  registerAgentTools,
  registerAuditLogTools,
  registerAssetTools,
  registerAssetCollectionTools,
  registerAssetVersionTools,
  registerEnvironmentMergeTools,
  registerInviteTools,
  registerSpaceTools,
  registerPromotionTools,
  registerEnvironmentAliasTools,
];

/**
 * 2026-07-28 clients cache list results for `ttlMs`, saving a round trip per
 * call. The tool set only changes on deploy, so a few minutes of staleness is
 * the whole cost. `private`: every request is authenticated.
 */
const CACHE_HINTS = {
  'tools/list': { ttlMs: 5 * 60_000, cacheScope: 'private' },
  'server/discover': { ttlMs: 5 * 60_000, cacheScope: 'private' },
} as const;

/**
 * Builds the MCP server for a resolved principal. Each tool authorizes the
 * caller's scopes against the target space before delegating to a core
 * use-case — so MCP enforces the SAME RBAC as the HTTP API.
 *
 * `skills` is the process-wide catalog from `loadSkillCatalog()`. Like the docs
 * tools, skills describe the product rather than any space's content, so
 * being authenticated is the only gate.
 */
export function buildServer(
  deps: McpDeps,
  principal: Principal,
  skills?: SkillsExtension,
): McpServer {
  const { ctx, ai, rag, agents } = deps;
  const server = new McpServer(
    { name: 'contentworker', version: '0.1.0' },
    { cacheHints: CACHE_HINTS },
  );
  // Every tool's failures pass through `toolFailure`, so no handler can leak an internal error,
  // and a validation failure comes back with its field issues (`validationResult`). Every
  // successful call that changed something is audited here, once for all tools (`auditToolCall`).
  // And every tool's `environment` argument resolves the way an HTTP `:env` does: an alias names
  // its target, and a name that is neither an alias nor an environment is refused
  // (`NotFoundError`), so a typo'd or deleted environment never collects rows. Two tools take the
  // name as given: deleting refuses an alias name itself, and a deleted environment's audit
  // history stays readable.
  const LITERAL_ENVIRONMENT = new Set(['environment_delete', 'audit_log_list']);
  // The `environment` each call named, before resolution, keyed by the resolved args object: a tool
  // that must not pin anything to an alias's current target (the webhook tools) reads it back.
  const requestedEnvironment = new WeakMap<object, string>();
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, handler: (...a: unknown[]) => unknown) => {
    const declared = declaredArgs((config as { inputSchema?: unknown }).inputSchema);
    const readOnly = declaresReadOnly(config);
    return register(
      name,
      config as never,
      (async (args: unknown, ...rest: unknown[]) => {
        try {
          const a = args as { space?: unknown; environment?: unknown } | undefined;
          if (!LITERAL_ENVIRONMENT.has(name) && a && typeof a.environment === 'string') {
            const spaceId = typeof a.space === 'string' ? a.space : DEFAULT_SPACE;
            // Checked only for a caller who may act in the space, so nobody else learns which
            // environments exist there: the tool's own guard refuses them first.
            const environment = inScope(principal, spaceId)
              ? await resolveWritableEnvironment(ctx, spaceId, a.environment)
              : await resolveEnvironment(ctx, spaceId, a.environment, { refusePurging: false });
            args = { ...a, environment };
            requestedEnvironment.set(args as object, a.environment);
          }
          const result = await handler(args, ...rest);
          if (!(result as { isError?: boolean } | undefined)?.isError) {
            await auditToolCall(ctx, {
              tool: name,
              args: (args ?? {}) as Record<string, unknown>,
              declared,
              readOnly,
              principal,
              defaultSpace: DEFAULT_SPACE,
              defaultEnvironment: DEFAULT_ENV,
            });
          }
          return result;
        } catch (err) {
          if (err instanceof ValidationError) return validationResult(err);
          throw toolFailure(name, err);
        }
      }) as never,
    );
  }) as typeof server.registerTool;
  const guard = (scope: PermissionScope, s: Scope) => authorize(principal, scope, s.spaceId);
  // Granular RBAC: content-level check for role-bound principals (unrestricted
  // principals short-circuit inside the domain helpers). Same enforcement as
  // the HTTP API, resolving the entry's content type when needed.
  const guardEntry = async (s: Scope, id: string, action: ContentAction) => {
    if (!principal.contentGrants) return;
    const entry = await getPreviewEntry(ctx, s, id);
    authorizeContent(principal, action, entry.contentType);
  };
  // Authorizes read on an entry and returns its content type, so version/history
  // tools can mask denied fields — mirrors the HTTP API's authorizeEntryRead.
  const authorizeEntryRead = async (s: Scope, id: string): Promise<string> => {
    const entry = await getPreviewEntry(ctx, s, id);
    authorizeContent(principal, 'read', entry.contentType);
    return entry.contentType;
  };

  const t: ToolContext = {
    deps,
    ctx,
    ai,
    rag,
    agents,
    principal,
    guard,
    guardEntry,
    authorizeEntryRead,
    requestedEnvironment,
  };
  for (const registerArea of TOOL_AREAS) registerArea(server, t);

  skills?.attach(server);
  return server;
}
