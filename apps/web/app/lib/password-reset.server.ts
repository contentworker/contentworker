/**
 * Self-service password reset: someone who forgot their password asks for a code by email, then
 * sets a new password with it (the pages are `routes/login-forgot.tsx` and `routes/login-reset.tsx`;
 * the code's shape and the copy are `password-reset.ts`).
 *
 * - Nothing the browser sees says whether an address has an account. Asking for a code always
 *   gets the same answer (`resetSent`) after the same work: the request is counted against the
 *   address and the place (`reset-email`, `reset-ip`), and everything that depends on the account
 *   (looking it up, writing the code, sending the email, the audit entry) runs after the response.
 *   A code that doesn't work always reads the same (`RESET_CODE_INVALID`, `RESET_LINK_INVALID`)
 *   after the same work: one statement finds and spends a try of a live code or finds nothing, and
 *   the hashing runs either way. The audit log says why.
 * - The per-address cap doesn't hold back a place where the person has a live session, so a
 *   stranger who knows the address can't keep its owner from resetting.
 * - Codes go only to an enabled account with a password, while the workspace isn't SSO-only.
 *   Someone single sign-on added (no password) gets none: a reset would give them a password their
 *   identity provider doesn't control. With SSO-only on, there is nothing to reset.
 * - Only an HMAC of the code (with `PASSWORD_PEPPER`) is stored (`password_resets`). It works once, for 15 minutes and
 *   `RESET_TRIES` tries, each counted before the comparison by a conditional update; a new code
 *   for the person deletes their older ones. Wrong codes are also throttled per place
 *   (`reset-code-ip`).
 * - Setting the password keeps the policy (`passwordProblem`), ends every session and pending
 *   two-factor challenge in the same database batch, and starts no session: the person signs in
 *   with the new password, and then with their two-factor code if they use one. Passkeys,
 *   two-factor sign-in and API tokens are left as they are: an emailed code proves only the
 *   mailbox, so it may replace the password and nothing else.
 */

import {
  authFailures,
  passwordResets,
  sessions,
  signInChallenges,
  users,
} from '@contentworker/db/auth';
import {
  constantTimeEqual,
  hashPassword,
  isEmail,
  normalizeEmail,
  passwordProblem,
  sha256Hex,
} from '@contentworker/security/credentials';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { audit, clientIp } from './audit.server';
import { recordFailure, Throttled, waitFor } from './auth.server';
import { afterResponse, db, emailSender, passwordPepper, sendsEmail } from './env.server';
import { newId } from './ids';
import { isLocalHost } from './origin';
import {
  newResetCode,
  parseResetCode,
  parseResetLink,
  RESET_CODE_INVALID,
  RESET_LINK_INVALID,
  RESET_MS,
  RESET_PATH,
  RESET_TRIES,
  type ResetCarry,
  resetDoneEmail,
  resetEmail,
  resetLinkToken,
} from './password-reset';
import type { Principal, Role } from './roles';
import { ssoOnlyInEffect } from './settings.server';
import { blockedFor, throttleKey } from './throttle';

/** A refusal the page shows as it is. */
export class ResetError extends Error {}

/**
 * Whether this deployment can reset passwords by email: it sends email, or it is local development,
 * where the email is printed to the dev server's log instead (`deliver`).
 */
export const resetAvailable = (request: Request) =>
  sendsEmail() || isLocalHost(new URL(request.url));

/**
 * The stored form of a code: HMAC-SHA256 with the deployment's `PASSWORD_PEPPER` over the reset's
 * id and the code, so a copy of the database alone can't search the 40-bit code space; SHA-256
 * where there is no pepper (local development).
 */
async function codeHash(id: string, code: string): Promise<string> {
  const pepper = passwordPepper();
  if (!pepper) return sha256Hex(`${id}:${code}`);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}:${code}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compared against when no code is live, so a miss costs the same hashing as a hit. */
const NO_HASH = '0'.repeat(64);

/**
 * Sends one email, or in local development without a sender prints it to the log. Returns why it
 * wasn't sent, or null.
 */
async function deliver(
  request: Request,
  message: { to: string[]; subject: string; text: string },
): Promise<string | null> {
  const sender = emailSender();
  if (sender) {
    const r = await sender.send(message);
    return r.delivered ? null : (r.error ?? 'not delivered');
  }
  if (isLocalHost(new URL(request.url))) {
    // Local development only: there is no mailbox, so the code is read from here.
    console.log(JSON.stringify({ type: 'password_reset_email', ...message }));
    return null;
  }
  return 'email sending is not configured';
}

// ── Asking for a code ──

/**
 * Asks for a code for `given`. The same answer and the same work whatever the address: it throws
 * `ResetError` only for something that isn't an address, and `Throttled` only when this place has
 * asked too often (across addresses). An address that has had its codes for this window gets the
 * usual answer and no email.
 */
export async function requestReset(request: Request, given: string): Promise<string> {
  const email = normalizeEmail(given);
  if (!isEmail(email) || email.length > 320) throw new ResetError('Enter your email address.');
  const ipKey = throttleKey('reset-ip', clientIp(request));
  const emailKey = throttleKey('reset-email', email);
  const rows = await db()
    .select()
    .from(authFailures)
    .where(inArray(authFailures.key, [ipKey, emailKey]));
  const now = Date.now();
  const wait = blockedFor(
    rows.filter((r) => r.key === ipKey),
    now,
  );
  if (wait) {
    await audit(request, 'auth.password_reset_requested', {
      target: email,
      detail: { outcome: 'throttled' },
    });
    throw new Throttled(wait);
  }
  const addressSpent =
    blockedFor(
      rows.filter((r) => r.key === emailKey),
      now,
    ) > 0;
  await recordFailure([ipKey, emailKey]);
  afterResponse(issue(request, email, addressSpent));
  return email;
}

/**
 * Whether one of the person's live sessions was last seen at this request's address. The
 * per-address cap doesn't hold back such a place, so someone who knows only an address can't use
 * up its codes and keep its owner from resetting (as `signInWait` does for sign-in). It runs after
 * the response, so it tells the requester nothing.
 */
async function knownPlace(request: Request, userId: string): Promise<boolean> {
  const row = await db()
    .select({ id: sessions.tokenHash })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.ip, clientIp(request)),
        gt(sessions.expiresAt, Date.now()),
      ),
    )
    .get();
  return !!row;
}

/** After the response: a code for the account, if it may have one, and the audit entry. */
async function issue(request: Request, email: string, addressSpent: boolean) {
  const user = await db()
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .get();
  let outcome = !user
    ? 'no account'
    : user.disabledAt
      ? 'disabled'
      : !user.passwordHash
        ? 'no password'
        : (await ssoOnlyInEffect())
          ? 'SSO only'
          : addressSpent && !(await knownPlace(request, user.id))
            ? 'too many codes for this address'
            : 'sent';
  if (user && outcome === 'sent') {
    const id = newId('pwr');
    const code = newResetCode();
    const now = Date.now();
    // One batch: the new code, and the person's older ones (and anyone's expired ones) gone.
    await db().batch([
      db()
        .delete(passwordResets)
        .where(or(eq(passwordResets.userId, user.id), lte(passwordResets.expiresAt, now))),
      db()
        .insert(passwordResets)
        .values({
          id,
          userId: user.id,
          codeHash: await codeHash(id, code),
          createdAt: now,
          expiresAt: now + RESET_MS,
        }),
    ]);
    const url = new URL(request.url);
    const failed = await deliver(
      request,
      resetEmail({
        to: user.email,
        code,
        link: new URL(`${RESET_PATH}/${resetLinkToken(id, code)}`, url).href,
        host: url.host,
      }),
    );
    if (failed) outcome = `email not sent: ${failed}`;
  }
  await audit(request, 'auth.password_reset_requested', { target: email, detail: { outcome } });
}

// ── Setting the new password ──

/**
 * Sets a new password with a code: typed for the address it was asked for, or from the emailed
 * link. Throws `Throttled` while this place has tried too many wrong codes, and `ResetError` for
 * a password the policy refuses or a code that doesn't work (the same words whatever the reason).
 * Starts no session.
 */
export async function resetPassword(
  request: Request,
  carry: ResetCarry,
  typedCode: string,
  password: string,
): Promise<void> {
  const key = [throttleKey('reset-code-ip', clientIp(request))];
  const wait = await waitFor(key);
  if (wait) throw new Throttled(wait);

  const viaLink = 'link' in carry;
  const link = viaLink ? parseResetLink(carry.link) : null;
  const code = link ? link.code : parseResetCode(typedCode);
  const email = viaLink ? null : normalizeEmail(carry.email);
  const refuse = async (reason: string): Promise<never> => {
    await recordFailure(key);
    await audit(request, 'auth.password_reset_failed', {
      target: email,
      detail: { reason, ...(viaLink ? { via: 'link' } : {}) },
    });
    throw new ResetError(viaLink ? RESET_LINK_INVALID : RESET_CODE_INVALID);
  };

  // Typed: the policy first, against the address typed, so a weak password spends no try and
  // says nothing about the account.
  if (email !== null) {
    const problem = passwordProblem(password, email);
    if (problem) throw new ResetError(problem);
  }
  if (!code || (viaLink && !link)) return refuse('malformed code');

  const now = Date.now();
  // One statement, whatever the address: it finds the newest live code for an enabled account with
  // a password and spends one of its tries, before the comparison, so racing requests each need
  // one of their own. An address with no such code runs the same write and gets no row; the
  // SSO-only check and the hashing run either way too, so a wrong guess for a real account costs
  // the same as one for nobody.
  const live = db()
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(
      and(
        link ? eq(passwordResets.id, link.id) : eq(users.email, email!),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, now),
        lt(passwordResets.attempts, RESET_TRIES),
        isNull(users.disabledAt),
        isNotNull(users.passwordHash),
      ),
    )
    .orderBy(desc(passwordResets.createdAt))
    .limit(1);
  const [row] = await db()
    .update(passwordResets)
    .set({ attempts: sql`${passwordResets.attempts} + 1` })
    .where(
      and(
        inArray(passwordResets.id, live),
        isNull(passwordResets.usedAt),
        lt(passwordResets.attempts, RESET_TRIES),
        gt(passwordResets.expiresAt, now),
      ),
    )
    .returning({
      id: passwordResets.id,
      codeHash: passwordResets.codeHash,
      userId: passwordResets.userId,
    });
  const ssoOnly = await ssoOnlyInEffect();
  const right = constantTimeEqual(
    await codeHash(row?.id ?? 'pwr_none', code),
    row?.codeHash ?? NO_HASH,
  );
  if (!row) return refuse('no live code');
  // Asked for before the workspace went SSO-only.
  if (ssoOnly) return refuse('password sign-in off');
  if (!right) return refuse('wrong code');

  // Known only now that the code is right: who it is for.
  const user = (await db()
    .select({ email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, row.userId))
    .get())!;

  // Through a link, the address is known only now; the code stays good for its remaining tries.
  if (viaLink) {
    const problem = passwordProblem(password, user.email);
    if (problem) throw new ResetError(problem);
  }

  // Used once: of two requests with the right code, one wins here.
  const used = await db()
    .update(passwordResets)
    .set({ usedAt: now })
    .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt)))
    .returning({ id: passwordResets.id });
  if (!used.length) return refuse('code already used');

  const passwordHash = await hashPassword(password, passwordPepper());
  // One batch: the new password, and everything the old one reached gone with it.
  const [, , , ended] = await db().batch([
    db()
      .update(users)
      .set({ passwordHash, passwordChangeDue: false, passwordExpiresAt: null })
      .where(eq(users.id, row.userId)),
    db().delete(passwordResets).where(eq(passwordResets.userId, row.userId)),
    db().delete(signInChallenges).where(eq(signInChallenges.userId, row.userId)),
    db()
      .delete(sessions)
      .where(eq(sessions.userId, row.userId))
      .returning({ id: sessions.tokenHash }),
  ]);
  const person: Principal = {
    kind: 'user',
    id: row.userId,
    email: user.email,
    name: user.name,
    role: user.role as Role,
  };
  await audit(request, 'auth.password_reset', {
    actor: person,
    target: user.email,
    detail: { sessions: ended.length, ...(viaLink ? { via: 'link' } : {}) },
  });
  const url = new URL(request.url);
  afterResponse(
    deliver(request, resetDoneEmail({ to: user.email, host: url.host })).then((failed) => {
      if (failed)
        console.error(JSON.stringify({ type: 'password_reset_notice_failed', error: failed }));
    }),
  );
}
