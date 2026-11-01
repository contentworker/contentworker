import { env } from 'cloudflare:workers';
import {
  DEV_PRINCIPAL_KEY,
  PRINCIPAL_HEADER,
  signPrincipal,
  type WebPrincipal,
} from '@contentworker/security/principal';
import type { Principal } from './roles';

/**
 * Sets the signed principal header (`x-cw-principal`) on a request the web gateway forwards to
 * the api at `path`, replacing whatever the caller sent. The api checks it with the same
 * `PRINCIPAL_KEY` (`verifyPrincipal` in `@contentworker/security`); it is good for 60 seconds and
 * for that exact path only. Local dev (`vite dev`) uses a fixed key when none is set.
 */
export async function setPrincipalHeader(
  headers: Headers,
  p: Principal,
  path: string,
  now = Date.now(),
) {
  headers.set(PRINCIPAL_HEADER, await signPrincipal(principalKey(), webPrincipal(p), path, now));
}

/** What the api is told about a person: who, how to name them, and their deployment role. */
export const webPrincipal = (p: Principal): WebPrincipal => ({
  sub: p.id,
  email: p.email ?? '',
  name: p.name,
  role: p.role,
});

/**
 * The key that signs the principal header and the web app's own envelopes (the SSO flow and link
 * cookies). Throws when a deployment has none.
 */
export function principalKey() {
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key) throw new Error('PRINCIPAL_KEY is not set: the api would refuse every forwarded call');
  return key;
}
