// The config Connect a frontend prints: the runtime's one setting, the SDK, Next.js draft mode and
// live preview, filled with the minted keys or placeholders, and never a token where a secret
// doesn't go (wrangler.jsonc, a command line).
import { frontendEndpoints } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_KEY_PLACEHOLDER,
  type FrontendConfigInput,
  livePreview,
  nextClient,
  nextDraftRoute,
  PREVIEW_KEY_PLACEHOLDER,
  RUNTIME_SECRET_COMMAND,
  runtimeVars,
  sdkClient,
  sdkEnv,
} from '~/cms/lib/frontend-config';

const deployed: FrontendConfigInput = {
  space: 'acme',
  environment: 'main',
  locale: 'en-US',
  endpoints: frontendEndpoints('https://acme.contentworker.app')!,
  deliveryToken: 'cwk_cda_secret',
  previewToken: 'cwk_cpa_secret',
};
const local: FrontendConfigInput = {
  ...deployed,
  endpoints: frontendEndpoints('http://localhost:5180')!,
};

describe('the frontend runtime config', () => {
  it('names the backend in one setting, Preview found from the cdn host', () => {
    const vars = runtimeVars(deployed);
    expect(JSON.parse(`{${vars}}`)).toEqual({
      vars: {
        CONTENTWORKER: 'https://cdn.acme.contentworker.app/acme/main',
        CONTENTWORKER_LOCALE: 'en-US',
      },
    });
  });

  it('names Preview where the runtime can’t find it (one origin, locally)', () => {
    expect(JSON.parse(`{${runtimeVars(local)}}`).vars).toEqual({
      CONTENTWORKER: 'http://localhost:5180/acme/main',
      CONTENTWORKER_LOCALE: 'en-US',
      CONTENTWORKER_PREVIEW: 'http://localhost:5180',
    });
  });

  it('keeps the key out of wrangler.jsonc and off the command line', () => {
    expect(runtimeVars(deployed)).not.toContain('cwk_');
    expect(RUNTIME_SECRET_COMMAND).toBe('npx wrangler secret put CONTENTWORKER_KEY');
  });
});

describe('the SDK and Next.js config', () => {
  it('puts the tokens in the env file, and only there', () => {
    expect(sdkEnv(deployed, true)).toBe(
      'CONTENTWORKER_DELIVERY_KEY=cwk_cda_secret\nCONTENTWORKER_PREVIEW_KEY=cwk_cpa_secret',
    );
    for (const code of [sdkClient(deployed), nextDraftRoute(deployed), nextClient(deployed)]) {
      expect(code).not.toContain('cwk_');
      expect(code).toContain("'acme'");
    }
  });

  it('says what goes there until the keys are minted', () => {
    const { deliveryToken: _d, previewToken: _p, ...unminted } = deployed;
    expect(sdkEnv(unminted, false)).toBe(`CONTENTWORKER_DELIVERY_KEY=${DELIVERY_KEY_PLACEHOLDER}`);
    expect(sdkEnv(unminted, true)).toContain(PREVIEW_KEY_PLACEHOLDER);
  });

  it('reads Delivery from cdn and drafts from the api', () => {
    expect(sdkClient(deployed)).toContain("baseUrl: 'https://cdn.acme.contentworker.app'");
    expect(nextDraftRoute(deployed)).toContain("baseUrl: 'https://api.acme.contentworker.app'");
    expect(nextDraftRoute(deployed)).toContain("from '@contentworker/sdk/next'");
    expect(nextClient(deployed)).toContain('createDraftClient');
  });

  it('gives Next.js draft mode no Preview key: the link’s own token reads its entry', () => {
    const code = nextClient(deployed);
    expect(code).not.toContain('CONTENTWORKER_PREVIEW_KEY');
    expect(code).toContain("import { cookies, draftMode } from 'next/headers';");
    expect(code).toContain('  cookies,');
    expect(code).toContain("preview: { baseUrl: 'https://api.acme.contentworker.app' }");
  });

  it('quotes a value that could end its string', () => {
    const odd = { ...deployed, environment: "it's" };
    expect(sdkClient(odd)).toContain("environment: 'it\\'s'");
  });
});

describe('the live preview config', () => {
  it('names this admin as the origin the page connects to', () => {
    expect(livePreview(deployed)).toContain("adminOrigin: 'https://acme.contentworker.app'");
    expect(livePreview(deployed)).not.toContain('cwk_');
  });
});
