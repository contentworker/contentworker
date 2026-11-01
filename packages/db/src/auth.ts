/**
 * `@contentworker/db/auth`: the human sign-in tables (auth-schema.ts) and the small helpers the
 * admin web app needs around them. Depends on drizzle alone, so the web Worker can import it
 * without the content store.
 */

import { desc, isNotNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as authSchema from './auth-schema';
import { adminAudit } from './auth-schema';

export * from './auth-schema';
export { authSchema };

/** A drizzle D1 database over the auth tables (apps/web builds one per D1 binding). */
export type AuthDb = DrizzleD1Database<typeof authSchema>;

/** `text` with LIKE's wildcards and the escape character escaped, to match literally. */
const literal = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `column LIKE 'text%'`, with `text` matched literally. */
export const startsWith = (column: SQLWrapper, text: string): SQL =>
  sql`${column} like ${`${literal(text)}%`} escape '\\'`;

// ── Appending to the admin audit log's hash chain ──
// Two writers can read the same head; the unique `seq` refuses the second, which waits a moment,
// reads the new head and tries again.

export type AuditHead = { seq: number; hash: string };
type Sealed = typeof adminAudit.$inferInsert & { seq: number; hash: string };

const ATTEMPTS = 20;

/** The newest sealed event, or null before the first. */
export async function auditHead(db: AuthDb): Promise<AuditHead | null> {
  const head = await db
    .select({ seq: adminAudit.seq, hash: adminAudit.hash })
    .from(adminAudit)
    .where(isNotNull(adminAudit.seq))
    .orderBy(desc(adminAudit.seq))
    .limit(1)
    .get();
  return head?.seq && head.hash ? { seq: head.seq, hash: head.hash } : null;
}

/** Inserts the event `seal` makes for the current head (`sealAuditRow` in the web app). */
export async function appendAudit(db: AuthDb, seal: (head: AuditHead | null) => Promise<Sealed>) {
  for (let attempt = 1; ; attempt++) {
    const row = await seal(await auditHead(db));
    try {
      await db.insert(adminAudit).values(row);
      return row;
    } catch (err) {
      // Drizzle wraps D1's error; the constraint is named in its cause.
      const text = `${err} ${(err as { cause?: unknown }).cause ?? ''}`;
      const lost = /UNIQUE constraint failed: admin_audit\.seq/.test(text);
      if (!lost || attempt === ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
    }
  }
}
