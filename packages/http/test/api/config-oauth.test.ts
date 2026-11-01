import { loadConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { oauthConfigFrom } from '../../src/api/oauth/routes.js';

describe('OAuth settings as the Worker configs declare them', () => {
  it('reads an empty OAUTH_RESOURCE as unset, so the resource is the issuer’s /mcp', () => {
    // apps/api/wrangler.jsonc declares OAUTH_RESOURCE as "", and the fleet sets only the issuer.
    const config = loadConfig({
      OAUTH_ISSUER: 'https://acme.contentworker.app',
      OAUTH_RESOURCE: '',
    } as NodeJS.ProcessEnv);
    expect(oauthConfigFrom(config).resource).toBe('https://acme.contentworker.app/mcp');
  });

  it('reads an empty OAUTH_ISSUER as off', () => {
    expect(loadConfig({ OAUTH_ISSUER: '' } as NodeJS.ProcessEnv).oauthIssuer).toBeUndefined();
  });

  it('keeps an explicit resource', () => {
    const config = loadConfig({
      OAUTH_ISSUER: 'https://acme.contentworker.app',
      OAUTH_RESOURCE: 'https://api.acme.contentworker.app/mcp',
    } as NodeJS.ProcessEnv);
    expect(oauthConfigFrom(config).resource).toBe('https://api.acme.contentworker.app/mcp');
  });
});
