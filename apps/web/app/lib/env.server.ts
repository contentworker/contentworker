import { env, waitUntil } from 'cloudflare:workers';
import { type AuthDb, authSchema } from '@contentworker/db/auth';
import { drizzle } from 'drizzle-orm/d1';

/**
 * The deployment's password pepper (`PASSWORD_PEPPER`), mixed into every password hash and never
 * stored with them; unset in local development, where hashes are made without one.
 */
export function passwordPepper(): string | undefined {
  return (env as { PASSWORD_PEPPER?: string }).PASSWORD_PEPPER || undefined;
}

/** One drizzle instance per D1 binding, so a request that asks again reuses it. */
const instances = new WeakMap<D1Database, AuthDb>();

export function createDb(d1: D1Database): AuthDb {
  let db = instances.get(d1);
  if (!db) {
    db = drizzle(d1, { schema: authSchema });
    instances.set(d1, db);
  }
  return db;
}

/** The auth tables in the deployment's D1 (the same database the api uses). */
export function db(): AuthDb {
  return createDb(env.DB);
}

/** The api Worker, over the `API` service binding. */
/** The delivery Worker's binding (bearer-key /delivery/* calls go through its cache). */
export function delivery(): Fetcher | undefined {
  return env.DELIVERY;
}

export function api(): Fetcher {
  return env.API;
}

/**
 * Runs bookkeeping (a session's last use) after the response instead of before it. The write
 * still happens: the Worker stays alive until it settles. A failure is logged.
 */
export function afterResponse(work: PromiseLike<unknown>) {
  waitUntil(Promise.resolve(work).catch((err) => console.error('background write failed', err)));
}
