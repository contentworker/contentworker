import {
  approvePromotion,
  getPromotion,
  listPromotions,
  rejectPromotion,
  requestPromotion,
} from '@contentworker/application';
import { authorize, PROMOTION_STATUSES, type PromotionStatus, SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as promotionDocs from '../../docs/schemas/promotions';
import { parseBody, promotionBody } from '../../validation';
import { actingCtx } from './shared';

export function promotionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- promotions (environment → environment, with approval) -------------
  app.post(
    '/spaces/:space/promotions',
    doc('Spaces & environments', 'Promote content from one environment to another', {
      body: promotionBody,
      ok: promotionDocs.promotion,
      status: 201,
      description:
        'Pins the entries to copy (what is live in the source goes live in the target; a draft ' +
        'goes as a draft) and runs a risk check. With nothing to stop it, it applies at once ' +
        '(`completed`). A promotion into `main` or an aliased environment, one that would remove ' +
        'or retype a field, change the block rules (which blocks go where, counts, locks) or ' +
        'remove blocks, or one the risk check flags waits as `awaiting_approval` for someone ' +
        'else to approve. Omit `contentTypes` and `entries` to promote everything that differs ' +
        '(at most 200 entries), the block catalog and block config included; `blocks: true` ' +
        'adds them to a selection. A refusal (422, 409, 403) copies nothing (a record, if one was ' +
        'made, is `failed`). One that applies at once and stops after a write answers 409 ' +
        '`promotion_failed`, the error carrying the record (`error.promotion`: `failed`, its ' +
        '`error`, what it wrote in `result`, and in `result.issues` what the target refused).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      // It can publish, so it needs both.
      authorize(c.get('principal'), SCOPES.contentPublish, c.req.param('space'));
      const body = await parseBody(c, promotionBody);
      return c.json(
        await requestPromotion(actingCtx(ctx, c), c.get('principal'), c.req.param('space'), body),
        201,
      );
    },
  );
  app.get(
    '/spaces/:space/promotions',
    doc('Spaces & environments', 'List promotions, newest first', {
      ok: promotionDocs.promotionList,
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const status = c.req.query('status');
      return c.json({
        items: await listPromotions(ctx, c.get('principal'), c.req.param('space'), {
          ...(status && (PROMOTION_STATUSES as readonly string[]).includes(status)
            ? { status: status as PromotionStatus }
            : {}),
        }),
      });
    },
  );
  app.get(
    '/spaces/:space/promotions/:id',
    doc('Spaces & environments', 'Get a promotion, with its risk check and result', {
      ok: promotionDocs.promotion,
    }),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(await getPromotion(ctx, c.get('principal'), c.req.param('space'), c.req.param('id'))),
  );
  app.post(
    '/spaces/:space/promotions/:id/approve',
    doc('Spaces & environments', 'Approve a waiting promotion and apply it', {
      ok: promotionDocs.promotion,
      description:
        'By someone other than whoever requested it (403 otherwise). A refusal (403, 409, or a ' +
        '422 from the checks the apply runs first) copies nothing; after one of those checks the ' +
        'record is `failed`. An apply that stops after a write answers 409 `promotion_failed`, ' +
        'the error carrying the record (`error.promotion`).',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(
        await approvePromotion(
          actingCtx(ctx, c),
          c.get('principal'),
          c.req.param('space'),
          c.req.param('id'),
        ),
      ),
  );
  app.post(
    '/spaces/:space/promotions/:id/reject',
    doc('Spaces & environments', 'Reject a waiting promotion', {
      ok: promotionDocs.promotion,
      description:
        'Nothing is copied. A person who requested it (not an API key or an app acting for them) ' +
        'may reject it too, withdrawing the request: `decidedBy` is then the requester.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(
        await rejectPromotion(ctx, c.get('principal'), c.req.param('space'), c.req.param('id')),
      ),
  );

  return app;
}
