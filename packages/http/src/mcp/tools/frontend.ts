import { connectFrontend } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { connectFrontendBody } from '../../api/validation';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerFrontendTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, guard, principal, auditTarget, requestedEnvironment } = t;

  // `POST …/environments/:env/frontend-connections`' twin: the same use-case, the same
  // space-admin check, the same body schema. The audit row names the Delivery key it minted.
  server.registerTool(
    'frontend_connect',
    {
      description:
        'Connect a frontend to this space and environment: mints a Delivery API key (and, with ' +
        'preview: true, a Preview API key, only for a server that reads drafts itself) and answers ' +
        'them with the endpoints ' +
        "the frontend's config names (Delivery's origin, the api's origin, the admin origin for " +
        "live preview's adminOrigin) and each content type's preview URL template. The tokens " +
        'are shown ONCE, in this result: hand them to whoever configures the site now (as ' +
        'secrets: never in a URL or a committed file), or revoke the keys. Set a missing preview ' +
        'URL with model_set_content_type_preview. A Next.js site on @contentworker/sdk/next needs ' +
        "no Preview key: its draft mode reads the preview link's one entry with the link's own " +
        'token, everything else from Delivery. A role may hold no scope beyond its key kind (roleId: ' +
        'delivery:read, search:read; previewRoleId: also preview:read). Refused to an OAuth or ' +
        'personal access token.',
      inputSchema: toolSchema('frontend_connect', () => connectFrontendBody.extend(scopeArgs)),
    },
    async (args) => {
      const scope = scopeOf(args);
      guard(SCOPES.spaceAdmin, scope);
      const connection = await connectFrontend(ctx, deps.hasher, {
        spaceId: scope.spaceId,
        // As the caller named it (an alias stays an alias), not the target it resolved to.
        environment: requestedEnvironment.get(args) ?? scope.environmentId,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.roleId ? { roleId: args.roleId } : {}),
        ...(args.previewRoleId ? { previewRoleId: args.previewRoleId } : {}),
        ...(args.preview ? { preview: true } : {}),
        ...(deps.inviteOrigin ? { adminOrigin: deps.inviteOrigin } : {}),
        issuer: principal,
      });
      auditTarget.set(args, connection.deliveryKey.id);
      return ok(connection);
    },
  );
}
