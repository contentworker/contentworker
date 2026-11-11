import {
  AI_CAPABILITIES,
  AI_CAPABILITY_INFO,
  AI_GUIDANCE_MAX_CHARS,
  MODEL_TIERS,
} from '@contentworker/domain';
import { z } from 'zod';

// --- AI settings (per space, per capability) -------------------------------------------------------

const tier = z
  .enum(MODEL_TIERS)
  .nullable()
  .describe(
    'The model tier its calls run on (flagship: most capable; balanced: the everyday default; ' +
      'fast: quickest and cheapest). null: each call site’s own default. A request that names its ' +
      'own tier still gets it',
  );

const guidance = z
  .string()
  .max(AI_GUIDANCE_MAX_CHARS * 2)
  .nullable()
  .describe(
    `Plain text added after the built-in prompt as quoted guidance (tone, style, terminology), at ` +
      `most ${AI_GUIDANCE_MAX_CHARS} characters once line endings are normalized and the ends ` +
      'trimmed. It can’t change the task, the answer’s schema or the tools offered. null: none',
  );

export const aiCapabilitySetting = z.object({
  enabled: z
    .boolean()
    .describe(
      'Off: requests that need it are refused (409 `ai_capability_disabled`) and background work skips it',
    ),
  tier,
  guidance,
});

/** Every capability, each described as the admin describes it. */
const capabilityMap = z.object(
  Object.fromEntries(
    AI_CAPABILITIES.map((c) => [c, aiCapabilitySetting.describe(AI_CAPABILITY_INFO[c].covers)]),
  ) as Record<(typeof AI_CAPABILITIES)[number], typeof aiCapabilitySetting>,
);

export const aiSettings = z.object({
  version: z.int().describe('0 before the first set, then one more per set that changed something'),
  capabilities: capabilityMap,
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});

export const aiSettingsSet = z.object({
  settings: aiSettings,
  unchanged: z.boolean().describe('The settings were already this: nothing written'),
});

/** One capability as a set sends it: `enabled` required, the rest back to the default when left out. */
export const aiCapabilityInput = z.object({
  enabled: z.boolean(),
  tier: tier.optional(),
  guidance: guidance.optional(),
});
