import { z } from 'zod';
import { entry } from './entries';

// --- moderation holds ----------------------------------------------------------

export const moderationHold = z.object({
  id: z.uuid(),
  entryId: z.string(),
  contentTypeApiId: z.string().describe('The entry’s type when it was held'),
  entryVersion: z
    .number()
    .int()
    .describe('The version moderation judged: what Republish publishes again'),
  flags: z
    .array(z.string())
    .describe('The categories the classifier flagged (hate, violence, house_rules, …)'),
  status: z
    .enum(['open', 'republished', 'kept', 'cleared'])
    .describe(
      'open: waiting on a person. cleared: moderation passed a later published version, so ' +
        'nothing was left to decide.',
    ),
  createdAt: z.iso.datetime().describe('When moderation took the entry offline'),
  decidedAt: z.iso.datetime().optional(),
  decidedBy: z.string().optional(),
  note: z
    .string()
    .optional()
    .describe('Why, in the decider’s words (listed only to callers with content:write)'),
  stale: z
    .literal(true)
    .optional()
    .describe(
      'On a listed open hold: a newer version of the entry is live. Republish then only closes ' +
        'it (as cleared), and Keep is refused.',
    ),
});

export const moderationHoldList = z.object({ items: z.array(moderationHold) });

export const moderationDecision = z.object({
  hold: moderationHold,
  entry: entry.nullable().describe('The entry as the decision left it; null when it is gone'),
  published: z.boolean().describe('True when this decision published the entry'),
});
