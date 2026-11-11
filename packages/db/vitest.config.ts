import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The D1 store's contract tests run in workerd against a real (Miniflare) D1, so the SQL the
 * adapter emits is exercised by the same SQLite build and the same `batch()` semantics a
 * deployment gets. Each test file starts from freshly applied migrations (test/setup.ts).
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        miniflare: {
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: { DB: 'contentworker-test' },
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
      // Every test file gets its own workerd (~3 s to start, plus its share of the runner). Left at
      // vitest's default (one per core, 47 files here), CI's 4 cores run a dozen of them at once
      // while turbo runs the other packages' suites alongside, and the suite crawls. Two at a time
      // on CI; locally the default.
      maxWorkers: process.env.CI ? 2 : undefined,
    },
  };
});
