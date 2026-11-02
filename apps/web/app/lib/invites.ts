/**
 * Invitations in the admin, without bindings: what the Team page and the `/invite/:token` page
 * share. The api holds invitations (`/deployment/invites`); `invites.server.ts` calls it.
 */

import type { Tone } from '~/components/status';
import type { Role } from './roles';

/** Where an invitation's link opens: `/invite/<token>`. */
export const INVITE_PREFIX = '/invite/';

/** The token shape the api issues (`cwi_` and 32 random bytes, base64url). */
const TOKEN = /^cwi_[A-Za-z0-9_-]{43}$/;

export const isInviteToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v);

/** The token a sign-in's `next` path is coming back to, if it is an invitation's page. */
export function inviteTokenIn(next: string): string | null {
  if (!next.startsWith(INVITE_PREFIX)) return null;
  const token = next.slice(INVITE_PREFIX.length);
  return isInviteToken(token) ? token : null;
}

/**
 * The one thing the invitation page says when a link doesn't work, whatever the reason (unknown,
 * used, revoked, expired, resent, another address, a lost race): it tells a guesser nothing.
 */
export const INVITE_INVALID =
  'This invitation link isn’t valid any more. Ask whoever invited you for a new one.';

/**
 * What creating an account from a link says when it can't, including when the address already
 * has an account: no different from any other failure, and pointing at the way that works then.
 */
export const INVITE_NOT_ACCEPTED =
  'We couldn’t accept this invitation with a new account. If you already have one, sign in to accept it; otherwise ask for a new invitation.';

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** An invitation as the api lists it (never a token). */
export type Invite = {
  id: string;
  email: string;
  role: Role;
  grants: { spaceId: string; roleId: string }[];
  status: InviteStatus;
  expiresAt: string;
  invitedBy: { kind: string; id: string };
  createdAt: string;
  sentAt: string;
  sendCount: number;
  emailedAt?: string;
};

export const INVITE_TONE: Record<InviteStatus, Tone> = {
  pending: 'wait',
  accepted: 'ok',
  revoked: 'idle',
  expired: 'idle',
};

export const INVITE_LABEL: Record<InviteStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  revoked: 'Revoked',
  expired: 'Expired',
};

/** The invitations the Team page lists: those that can still be resent or revoked. */
export const openInvites = (all: readonly Invite[]) =>
  all.filter((i) => i.status === 'pending' || i.status === 'expired');
