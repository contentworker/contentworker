import {
  getModerationHold,
  keepHeldEntryUnpublished,
  listModerationHolds,
  republishHeldEntry,
} from '@contentworker/application';
import { authorizeContent, deniedFieldsFor, SCOPES } from '@contentworker/domain';
import { type Context, Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as moderationDocs from '../../docs/schemas/moderation';
import { moderationDecisionBody, parseBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

const HOLD_STATUSES = ['open', 'republished', 'kept', 'cleared'] as const;
type HoldStatus = (typeof HOLD_STATUSES)[number];
const holdStatus = (raw: string | undefined): HoldStatus | undefined =>
  HOLD_STATUSES.find((s) => s === raw);

/**
 * Moderation holds: entries the moderation agent took offline, and a person's decision on each.
 * The same use-cases back the `moderation_hold_list` and `moderation_hold_keep` MCP tools.
 * Republish has no tool: only a person signed in to the admin may republish (`republishHeldEntry`
 * refuses every token), and every MCP caller is a token.
 */
export function moderationRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // Deciding a hold is a publishing decision: a role needs publish on the held entry's type,
  // whichever way it decides. The hold names the type, so a gone entry is still guarded. Answers
  // the fields the role can't read, so a refusal never names them.
  const authorizeDecision = async (c: Context<AuthVars>) => {
    const principal = c.get('principal');
    if (!principal.contentGrants) return [];
    const hold = await getModerationHold(ctx, scopeOf(c), c.req.param('id') as string);
    authorizeContent(principal, 'publish', hold.contentTypeApiId);
    return deniedFieldsFor(principal, hold.contentTypeApiId);
  };

  app.get(
    `${BASE}/moderation-holds`,
    doc('AI & agents', 'List moderation holds', {
      ok: moderationDocs.moderationHoldList,
      description:
        'Entries the moderation agent unpublished after a publish, newest first. `status=open` ' +
        'lists those waiting on a decision, as Approvals does. Holds on content types the caller ' +
        'can’t read are left out.',
      query: {
        status: 'open, republished, kept or cleared',
        entryId: 'Only this entry’s holds',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json({
        items: await listModerationHolds(
          ctx,
          scopeOf(c),
          { status: holdStatus(c.req.query('status')), entryId: c.req.query('entryId') },
          c.get('principal'),
        ),
      }),
  );

  app.post(
    `${BASE}/moderation-holds/:id/republish`,
    doc('AI & agents', 'Republish a held entry', {
      ok: moderationDocs.moderationDecision,
      body: moderationDecisionBody,
      description:
        'Overrides moderation: publishes the held version again and closes the hold, in one ' +
        'transaction with the `entry.published` event. Only a person signed in to the admin may: ' +
        'any token (an API key, the admin token, an OAuth or personal access token) is refused ' +
        'with 403 `person_required`, and there is no MCP tool for it. Needs publish on the type. ' +
        '409 when the ' +
        'hold was already decided, or the entry was edited after it was held (publish the new ' +
        'version from the entry instead). A workflow that gates publishing still refuses it ' +
        '(`publish_gated`). An entry someone already published again just closes its hold.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const unreadable = await authorizeDecision(c);
      const { note } = await parseBody(c, moderationDecisionBody);
      return c.json(
        await republishHeldEntry(actingCtx(ctx, c), scopeOf(c), c.req.param('id'), {
          principal: c.get('principal'),
          unreadable,
          ...(note ? { note } : {}),
        }),
      );
    },
  );

  app.post(
    `${BASE}/moderation-holds/:id/keep`,
    doc('AI & agents', 'Keep a held entry unpublished', {
      ok: moderationDocs.moderationDecision,
      body: moderationDecisionBody,
      description:
        'Agrees with moderation: closes the hold, and the entry stays out of delivery. Needs ' +
        'publish on the type. 409 when the hold was already decided, or the entry was published ' +
        'again since (unpublish it from the entry instead).',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const unreadable = await authorizeDecision(c);
      const { note } = await parseBody(c, moderationDecisionBody);
      return c.json(
        await keepHeldEntryUnpublished(actingCtx(ctx, c), scopeOf(c), c.req.param('id'), {
          principal: c.get('principal'),
          unreadable,
          ...(note ? { note } : {}),
        }),
      );
    },
  );

  return app;
}
