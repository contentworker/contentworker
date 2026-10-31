import { loadConfig } from '@contentworker/platform/config';
import { signPrincipal } from '@contentworker/security/principal';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { wire } from './wire.js';

const KEY = 'test-principal-key-0123456789abcdef';
const config = loadConfig({
  ROLE: 'all',
  ADMIN_TOKEN: 'admin',
  CMA_KEY: 'cma',
  CDA_KEY: 'cda',
  CPA_KEY: 'cpa',
  SEED_SPACE_ID: 's1',
  PRINCIPAL_KEY: KEY,
} as NodeJS.ProcessEnv);

const path = '/spaces/s1/environments/main/content-types';
const person = (role: 'admin' | 'member') => ({
  sub: role === 'admin' ? 'usr_admin' : 'usr_member',
  email: `${role}@example.com`,
  name: role,
  role,
});

describe('the web principal (x-cw-principal)', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
  });

  it('lets a deployment admin in with a header signed for this path', async () => {
    const header = await signPrincipal(KEY, person('admin'), path);
    const res = await app.request(path, { headers: { 'x-cw-principal': header } });
    expect(res.status).toBe(200);
  });

  it('refuses a header signed with another key, or for another path', async () => {
    const forged = await signPrincipal('some-other-key-0123456789abcdef!!', person('admin'), path);
    expect((await app.request(path, { headers: { 'x-cw-principal': forged } })).status).toBe(401);
    const elsewhere = await signPrincipal(KEY, person('admin'), '/spaces/s1/team');
    expect((await app.request(path, { headers: { 'x-cw-principal': elsewhere } })).status).toBe(
      401,
    );
  });

  it('refuses an expired header', async () => {
    const old = await signPrincipal(KEY, person('admin'), path, Date.now() - 5 * 60_000);
    expect((await app.request(path, { headers: { 'x-cw-principal': old } })).status).toBe(401);
  });

  it('forbids a member who is not on the space team', async () => {
    const header = await signPrincipal(KEY, person('member'), path);
    expect((await app.request(path, { headers: { 'x-cw-principal': header } })).status).toBe(403);
  });
});
