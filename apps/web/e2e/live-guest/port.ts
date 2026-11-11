/**
 * Where the e2e servers listen. Several worktrees of this repo can run the suite at once, so the
 * default admin port is derived from this checkout's path (`apps/web`, where Playwright runs):
 * two worktrees get two ports, and a run never meets another's server there. `E2E_PORT` and
 * `E2E_GUEST_PORT` still pin them. The config never reuses a server on its port unless
 * `E2E_REUSE=1`, so a collision fails loudly instead of testing another checkout's code.
 */
const hash = (text: string) => {
  let h = 5381;
  for (const char of text) h = (Math.imul(h, 33) + char.charCodeAt(0)) >>> 0;
  return h;
};

/** The admin's dev server: 5400-5899 by checkout, or E2E_PORT. */
export const adminPort = () => Number(process.env.E2E_PORT) || 5400 + (hash(process.cwd()) % 500);

/**
 * The live preview guest page (`e2e/live-guest`): 1000 above the admin's port, or E2E_GUEST_PORT.
 * Shared by the Playwright config, which starts it, and the specs, which point a content type's
 * preview URL at it.
 */
export const guestPort = () => Number(process.env.E2E_GUEST_PORT) || adminPort() + 1000;
