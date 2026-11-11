import { describe, expect, it } from 'vitest';
import {
  type AiModelTier,
  aiSettingsView,
  capModelTier,
  DEFAULT_AI_SETTINGS,
  isAboveTierCap,
  MODEL_TIERS,
} from '../src/index';

describe('the deployment’s tier cap', () => {
  it('orders fast < balanced < flagship and takes the lower of the tier and the cap', () => {
    const table: [AiModelTier, AiModelTier, AiModelTier][] = [
      ['flagship', 'balanced', 'balanced'],
      ['flagship', 'fast', 'fast'],
      ['balanced', 'fast', 'fast'],
      ['balanced', 'flagship', 'balanced'],
      ['fast', 'balanced', 'fast'],
    ];
    for (const [tier, max, effective] of table) expect(capModelTier(tier, max)).toBe(effective);
    // No cap holds nothing back.
    for (const tier of MODEL_TIERS) expect(capModelTier(tier, undefined)).toBe(tier);
    expect(isAboveTierCap('flagship', 'balanced')).toBe(true);
    expect(isAboveTierCap('balanced', 'balanced')).toBe(false);
  });

  it('reports the settings with the cap and each capability’s effective tier', () => {
    const settings = {
      ...DEFAULT_AI_SETTINGS,
      capabilities: {
        ...DEFAULT_AI_SETTINGS.capabilities,
        agents: { enabled: true, tier: 'flagship' as const, guidance: null },
      },
    };
    const view = aiSettingsView(settings, 'fast');
    expect(view.maxTier).toBe('fast');
    expect(view.capabilities.agents).toEqual({
      enabled: true,
      tier: 'flagship',
      guidance: null,
      effectiveTier: 'fast',
    });
    expect(view.capabilities.drafting.effectiveTier).toBeNull();
    expect(aiSettingsView(settings, undefined).maxTier).toBe('flagship');
  });
});
