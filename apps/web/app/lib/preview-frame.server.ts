/**
 * What the Site frame (`routes/preview-frame.tsx`) frames: the entry's page on the customer's
 * frontend, from a preview link minted for the signed-in person over the api binding, as the
 * editor's Copy preview link mints one. The link's token reads that one entry, and is the only
 * credential that reaches the customer's page.
 *
 * Its origin, from the domain's `previewOrigin`, is the one origin the frame's own document may
 * frame (`x-cw-frames`), and the one the frame talks to.
 */

import { previewOrigin } from '@contentworker/domain';
import { principalTarget } from '@contentworker/security/principal';
import type { Caller } from './auth.server';
import { api } from './env.server';
import { setPrincipalHeader } from './principal.server';

/**
 * How long the frame's preview token lives. It is used when the page loads (and by whatever the
 * page fetches with it while open); edits travel over the channel, never with it. Opening the
 * pane again mints another.
 */
export const FRAME_TOKEN_HOURS = 1;

export type PreviewFrame =
  | { readonly ok: true; readonly frontendUrl: string; readonly origin: string }
  | {
      readonly ok: false;
      /**
       * `not-found`: no such entry, or none the person may read; `refused`: they may read it but
       * not mint a preview link (that takes content:write); `incomplete`: the type's preview URL
       * names a field the entry has no value for in this locale yet, or the type has none;
       * `error`: the api couldn't answer.
       */
      readonly reason: 'not-found' | 'refused' | 'incomplete' | 'error';
    };

export interface PreviewFrameTarget {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId: string;
  readonly locale?: string;
}

// Ids as the api's routes take them: no separator or encoding to smuggle another path in.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LOCALE = /^[A-Za-z0-9-]{1,35}$/;

/** The page to frame for `target`, as `me` may see it, and the HTTP status to answer with. */
export async function previewFrame(
  me: Caller,
  target: PreviewFrameTarget,
  adminOrigin: string,
): Promise<{ frame: PreviewFrame; status: number }> {
  const { spaceId, environmentId, entryId, locale } = target;
  if (![spaceId, environmentId, entryId].every((id) => ID.test(id))) {
    return { frame: { ok: false, reason: 'not-found' }, status: 404 };
  }
  const path = `/spaces/${spaceId}/environments/${environmentId}/entries/${entryId}/preview-link`;
  const headers = new Headers({ 'content-type': 'application/json' });
  await setPrincipalHeader(
    headers,
    { ...me, email: me.email ?? '' },
    principalTarget('POST', path),
  );
  const res = await api().fetch(`https://api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      previewBaseUrl: adminOrigin,
      ttlHours: FRAME_TOKEN_HOURS,
      ...(locale && LOCALE.test(locale) ? { locale } : {}),
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 403) return { frame: { ok: false, reason: 'refused' }, status: 403 };
    if (res.status === 404) return { frame: { ok: false, reason: 'not-found' }, status: 404 };
    if (res.status === 422) return { frame: { ok: false, reason: 'incomplete' }, status: 200 };
    return { frame: { ok: false, reason: 'error' }, status: 502 };
  }
  const link = (await res.json()) as { frontendUrl?: unknown };
  const frontendUrl = typeof link.frontendUrl === 'string' ? link.frontendUrl : undefined;
  // The template was checked when it was saved; checked again here, since this origin goes into
  // the frame's policy. Loopback http stays allowed: only a local stack can have saved one.
  const origin = frontendUrl ? previewOrigin(frontendUrl, { allowLoopback: true }) : null;
  if (!frontendUrl || !origin) return { frame: { ok: false, reason: 'incomplete' }, status: 200 };
  return { frame: { ok: true, frontendUrl, origin }, status: 200 };
}
