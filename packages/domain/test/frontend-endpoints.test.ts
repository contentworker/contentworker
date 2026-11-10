import { describe, expect, it } from 'vitest';
import { frontendEndpoints } from '../src/index';

describe('the endpoints a frontend reaches', () => {
  it('follows the fleet’s hosts: cdn. for Delivery, api. for Preview', () => {
    expect(frontendEndpoints('https://acme.contentworker.app')).toEqual({
      admin: 'https://acme.contentworker.app',
      delivery: 'https://cdn.acme.contentworker.app',
      preview: 'https://api.acme.contentworker.app',
    });
    // A trailing slash or path is the same origin.
    expect(frontendEndpoints('https://cms.example.com/')?.delivery).toBe(
      'https://cdn.cms.example.com',
    );
  });

  it('is the one origin on a local stack', () => {
    for (const origin of ['http://localhost:5180', 'http://127.0.0.1:5173', 'http://devbox:8080']) {
      expect(frontendEndpoints(origin)).toEqual({
        admin: origin,
        delivery: origin,
        preview: origin,
      });
    }
  });

  it('knows nothing from a value that isn’t an http(s) origin', () => {
    expect(frontendEndpoints('')).toBeUndefined();
    expect(frontendEndpoints('ftp://example.com')).toBeUndefined();
    expect(frontendEndpoints('not a url')).toBeUndefined();
  });
});
