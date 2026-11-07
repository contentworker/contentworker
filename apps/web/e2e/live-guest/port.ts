/**
 * Where the live preview guest page (`e2e/live-guest`) is served: beside the admin's e2e port, or
 * E2E_GUEST_PORT. Shared by the Playwright config, which starts it, and the spec, which points a
 * content type's preview URL at it.
 */
export const guestPort = () =>
  Number(process.env.E2E_GUEST_PORT) || (Number(process.env.E2E_PORT) || 5390) + 11;
