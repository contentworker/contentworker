import { connectFrontend } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as frontendDocs from '../../docs/schemas/frontend';
import { connectFrontendBody, parseBody } from '../../validation';
import { BASE } from './shared';

export function frontendRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher } = deps;
  const app = new Hono<AuthVars>();

  // Connect a frontend: the keys and endpoints its config names, in one answer. The MCP twin is
  // `frontend_connect`. Tokens are answered this once; the route never logs a body.
  app.post(
    `${BASE}/frontend-connections`,
    doc('Auth', 'Connect a frontend', {
      body: connectFrontendBody,
      ok: frontendDocs.frontendConnection,
      status: 201,
      description:
        'Mints a Content Delivery API key (and, with `preview`, a Content Preview API key) for ' +
        'the space, and answers them with the endpoints a frontend reads (Delivery, the api, ' +
        'the admin origin for live preview) and each content type’s preview URL template. The ' +
        'tokens are returned once; only their hashes are stored. 404 for an environment that ' +
        'doesn’t exist; 403 to a personal access token or an OAuth token, as minting any key.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, connectFrontendBody);
      const connection = await connectFrontend(ctx, hasher, {
        spaceId: c.req.param('space') as string,
        // As the caller named it: a frontend that reads an alias follows its cutovers.
        environment: c.req.param('env') as string,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.roleId ? { roleId: body.roleId } : {}),
        ...(body.previewRoleId ? { previewRoleId: body.previewRoleId } : {}),
        ...(body.preview ? { preview: true } : {}),
        ...(deps.inviteOrigin ? { adminOrigin: deps.inviteOrigin } : {}),
        issuer: c.get('principal'),
      });
      return c.json(connection, 201, { 'cache-control': 'no-store' });
    },
  );

  return app;
}
