import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

// Each subpath of @contentworker/sdk re-exports one workspace SDK module, unchanged.
const SOURCES: Record<string, () => Promise<Record<string, unknown>>> = {
  '.': () => import('@contentworker/sdk-core'),
  './blocks': () => import('@contentworker/sdk-core/blocks'),
  './inline-edit': () => import('@contentworker/sdk-core/inline-edit'),
  './live-preview': () => import('@contentworker/sdk-core/live-preview'),
  './next': () => import('@contentworker/sdk-core/next'),
  './redirects': () => import('@contentworker/sdk-core/redirects'),
  './webhooks': () => import('@contentworker/sdk-core/webhooks'),
  './rich-text': () => import('@contentworker/sdk-rich-text'),
  './edge': () => import('@contentworker/sdk-edge'),
  './management': () => import('@contentworker/sdk-management'),
  './react': () => import('@contentworker/sdk-web'),
  './vue': () => import('@contentworker/sdk-vue'),
  './react-native': () => import('@contentworker/sdk-react-native'),
  './codegen': () => import('@contentworker/sdk-codegen'),
};

const FACADES: Record<string, () => Promise<Record<string, unknown>>> = {
  '.': () => import('../src/index'),
  './blocks': () => import('../src/blocks'),
  './inline-edit': () => import('../src/inline-edit'),
  './live-preview': () => import('../src/live-preview'),
  './next': () => import('../src/next'),
  './redirects': () => import('../src/redirects'),
  './webhooks': () => import('../src/webhooks'),
  './rich-text': () => import('../src/rich-text'),
  './edge': () => import('../src/edge'),
  './management': () => import('../src/management'),
  './react': () => import('../src/react'),
  './vue': () => import('../src/vue'),
  './react-native': () => import('../src/react-native'),
  './codegen': () => import('../src/codegen'),
};

describe('@contentworker/sdk', () => {
  it('publishes exactly the subpaths it re-exports', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(SOURCES).sort());
    expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual(Object.keys(SOURCES).sort());
  });

  for (const [sub, source] of Object.entries(SOURCES)) {
    it(`${sub} exposes everything its workspace module exports`, async () => {
      const [want, got] = await Promise.all([source(), FACADES[sub]?.()]);
      expect(Object.keys(want).length).toBeGreaterThan(0);
      expect(Object.keys(got ?? {}).sort()).toEqual(Object.keys(want).sort());
      for (const key of Object.keys(want)) expect(got?.[key]).toBe(want[key]);
    });
  }

  it('tells the admin its own version in a live preview hello', async () => {
    const { LIVE_PREVIEW_SDK_VERSION } = await import('../src/live-preview');
    expect(LIVE_PREVIEW_SDK_VERSION).toBe(manifest.version);
  });
});
