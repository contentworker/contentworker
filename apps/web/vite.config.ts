import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * The device tests (`pnpm --filter @contentworker/web e2e`) run the dev server offline: no remote
 * bindings, and a database of their own under .wrangler/e2e so they never touch the one
 * `pnpm dev` uses.
 */
const e2e = process.env.CONTENTWORKER_E2E === '1';

/**
 * Local-only settings for the auxiliary Workers: dev secrets (never a deployment's), mocked
 * models, hash embeddings and in-memory vectors (Vectorize has no local emulator), and fakes
 * allowed. The principal key matches the web Worker's own dev key (DEV_PRINCIPAL_KEY).
 */
const LOCAL_STACK_VARS = {
  REQUIRE_SECURE_SECRETS: 'false',
  ADMIN_TOKEN: 'dev-admin-token',
  MCP_TOKEN: 'dev-mcp-token',
  TOKEN_PEPPER: 'dev-pepper',
  MEDIA_SIGNING_SECRET: 'dev-media-signing-secret',
  PRINCIPAL_KEY: 'contentworker-local-dev-principal-key',
  AI_MODE: 'mock',
  AI_GATEWAY_ID: '',
  EMBEDDINGS_PROVIDER: 'local',
  VECTOR_STORE: 'memory',
  ALLOW_FAKE_ADAPTERS: 'all',
  // Local dev always runs on the demo dataset (@contentworker/seed), loaded on the api's first
  // request. Config validation refuses SEED_DEV wherever secure secrets are required.
  SEED_DEV: 'true',
  SEED_SCALE: '1',
};

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // A fleet deploy builds against its rendered config.
      configPath: process.env.CONTENTWORKER_WRANGLER_CONFIG,
      ...(e2e ? { remoteBindings: false, persistState: { path: '.wrangler/e2e' } } : {}),
      // `pnpm dev` runs the whole stack in one session: this web Worker plus the api, engine
      // (queues, cron, Durable Objects, Workflows) and delivery Workers, all on one local D1.
      // Unless a fleet config is being built, which deploys each Worker on its own.
      ...(process.env.CONTENTWORKER_WRANGLER_CONFIG
        ? {}
        : {
            auxiliaryWorkers: ['../api', '../engine', '../delivery'].map((dir) => ({
              configPath: `${dir}/wrangler.jsonc`,
              config: () => ({ vars: LOCAL_STACK_VARS }),
            })),
          }),
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  // The CMS screens' heavy client dependencies, pre-bundled up front: discovered mid-session they
  // trigger a re-optimization that can leave two copies of React in the page (dev only).
  optimizeDeps: {
    include: [
      '@tanstack/react-query',
      '@tiptap/core',
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@xyflow/react',
      'recharts',
    ],
  },
});
