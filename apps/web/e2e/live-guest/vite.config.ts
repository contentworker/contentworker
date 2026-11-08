import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * A tiny customer frontend for live preview: one page that runs `startLivePreview` from the SDK and
 * renders an entry's title and blocks, marked up as the guide says. The e2e spec frames it from
 * the admin; locally it is what a type's preview URL can point at:
 *
 *   LIVE_GUEST_ADMIN=http://localhost:5175 pnpm --filter @contentworker/web live-guest
 *
 * LIVE_GUEST_ADMIN is the admin's origin (the only one the page listens to), LIVE_GUEST_PORT its
 * port (5401 by default).
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Its own dependency cache: sharing the admin's (apps/web/node_modules/.vite) lets each server's
  // optimizer mark the other's bundles outdated mid-run, and the admin's pages stop hydrating.
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite-live-guest', import.meta.url)),
  server: { port: Number(process.env.LIVE_GUEST_PORT) || 5401, strictPort: true },
  define: {
    __ADMIN_ORIGIN__: JSON.stringify(process.env.LIVE_GUEST_ADMIN ?? 'http://localhost:5173'),
  },
});
