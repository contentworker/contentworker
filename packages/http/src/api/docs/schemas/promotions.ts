import { PROMOTION_STATUSES } from '@contentworker/domain';
import { z } from 'zod';

/**
 * A promotion's record: what it pins, its risk check, and its decision and outcome. A request or
 * approval whose apply stopped partway answers with this too, `failed` with its `error` and what
 * it wrote (`result`); a refusal before anything is written is an error response instead.
 */
export const promotion = z.looseObject({
  id: z.string(),
  spaceId: z.string(),
  source: z.string(),
  target: z.string(),
  contentTypes: z
    .array(z.object({ apiId: z.string(), version: z.int() }))
    .describe('Each content type it copies, pinned by version'),
  entries: z
    .array(
      z.object({
        entryId: z.string(),
        contentTypeApiId: z.string(),
        version: z.int(),
        publish: z.boolean().describe('Live in the source, so it goes live in the target'),
      }),
    )
    .describe('Each entry it copies, pinned by version'),
  blocks: z
    .object({
      catalogVersion: z.int(),
      configVersion: z.int(),
      targetCatalogVersion: z.int(),
      targetConfigVersion: z.int(),
    })
    .optional()
    .describe('The block catalog and config it copies, pinned on both sides'),
  status: z.enum(PROMOTION_STATUSES),
  risk: z.looseObject({
    protectedTarget: z.boolean(),
    reasons: z.array(z.string()).describe('Why it needs approval, one sentence each'),
    assessment: z
      .looseObject({
        review: z.number(),
        breaking: z.number(),
        risk: z.number().describe('Routine (0) … High-risk (3), probability-weighted'),
        source: z.enum(['model', 'heuristic']),
        fallback: z.string().optional(),
      })
      .optional(),
    requiresApproval: z.boolean(),
  }),
  requestedBy: z.string(),
  decidedBy: z
    .string()
    .optional()
    .describe('Who approved or rejected it; the requester when they withdrew it'),
  result: z
    .looseObject({
      contentTypes: z.array(z.string()),
      entries: z.array(z.string()),
      published: z.array(z.string()),
      mismatched: z.array(z.string()),
      gated: z.array(z.string()),
    })
    .optional()
    .describe('What the apply wrote; on a failed one, what it wrote before it stopped'),
  error: z.string().optional().describe('Why it failed'),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
});

export const promotionList = z.object({ items: z.array(promotion) });
