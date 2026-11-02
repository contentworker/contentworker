import { getSchedulerStatus, revokeEverythingFor } from '@contentworker/application';
import { ForbiddenError } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, principalMiddleware } from '../../auth';
import { doc } from '../../docs/openapi';
import * as authDocs from '../../docs/schemas/auth';
import * as healthDocs from '../../docs/schemas/health';

export function deploymentRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- people (deployment-wide) ------------------------------------------
  // The web app calls this, as the deployment admin acting, when it disables, removes or
  // re-secures a person: their sessions are the web app's to end; their tokens live here.
  app.delete(
    '/deployment/people/:subject/credentials',
    doc('Auth', 'Revoke every token a person holds', {
      description:
        'Revokes the OAuth access tokens and grants, personal access tokens and setup credentials ' +
        "held by `subject` (the person's web user id), in every space. Deployment administrators only.",
    }),
    async (c) => {
      const principal = c.get('principal');
      if (principal.spaceId !== '*') throw new ForbiddenError('Deployment administrators only');
      return c.json(await revokeEverythingFor(ctx, c.req.param('subject')));
    },
  );

  // --- scheduler (deployment-wide) ---------------------------------------
  app.get(
    '/deployment/scheduler',
    doc('System', 'Report the engine cron and each sweep', {
      ok: healthDocs.schedulerStatus,
      description:
        'Whether the engine cron is ticking (`stale` once its last tick is more than ' +
        '`staleAfterSeconds` old), and for each sweep it runs (outbox relay, scheduled actions, ' +
        'retention, reseal, bulk and purge recovery, version archive, agent schedules) when it ' +
        'last ran, last succeeded and last failed, with the redacted error. The public ' +
        '`/health` says only `scheduler: ok|stale`. Deployment administrators only.',
    }),
    async (c) => c.json(await getSchedulerStatus(ctx, c.get('principal'))),
  );

  /** Lightweight principal probe for admin connection UI and SSO sessions. */
  app.get(
    '/auth/me',
    doc('Auth', 'Resolve the calling principal', { ok: authDocs.principal }),
    principalMiddleware(deps),
    (c) => {
      const principal = c.get('principal');
      return c.json({
        spaceId: principal.spaceId,
        kind: principal.kind,
        scopes: principal.scopes,
        subject: principal.subject,
        restricted: principal.contentGrants !== undefined,
      });
    },
  );

  return app;
}
