import { readAiSettings, setAiSettings } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as aiSettingsDocs from '../../docs/schemas/ai-settings';
import { aiSettingsSetBody, parseBody } from '../../validation';
import { actingCtx } from './shared';

/**
 * A space's AI settings: per capability, on or off, its model tier and its guidance. The space's,
 * not an environment's: they govern what may be asked of the models, not content, so a branch or
 * a promotion never carries them. Reading takes `preview:read` (the admin hides what is off from
 * every editor); setting takes `space:admin`, a personal or OAuth token holding it included: they
 * are configuration, and grant nobody access that outlives the token.
 */
export function aiSettingsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    '/spaces/:space/ai-settings',
    doc('AI settings', 'Get the AI settings', {
      ok: aiSettingsDocs.aiSettings,
      description:
        'Every AI capability with whether it is on, its tier and its guidance, and who set them ' +
        'when. Version 0, everything on, before the first set. `maxTier` is the deployment’s tier ' +
        'cap, and each capability’s `effectiveTier` the tier it runs on under it.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await readAiSettings(ctx, c.req.param('space'))),
  );
  app.put(
    '/spaces/:space/ai-settings',
    doc('AI settings', 'Set the AI settings', {
      body: aiSettingsSetBody,
      ok: aiSettingsDocs.aiSettingsSet,
      description:
        'Replaces each capability the body names, as a new version; the others stay as they are. ' +
        'Setting what is in force again writes nothing. 422 naming each part that isn’t a ' +
        'capability, a tier, or guidance within its length; 409 (naming the version in force) when ' +
        '`expectedVersion` is stale or another set commits first. A tier above the deployment’s ' +
        '`maxTier` is accepted and kept, and runs on `maxTier` (its `effectiveTier`). A capability ' +
        'turned off answers requests that need it with 409 `ai_capability_disabled`.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        await setAiSettings(
          actingCtx(ctx, c),
          c.get('principal'),
          c.req.param('space'),
          await parseBody(c, aiSettingsSetBody),
        ),
      ),
  );
  return app;
}
