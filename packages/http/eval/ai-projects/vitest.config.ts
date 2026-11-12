import { defineConfig } from 'vitest/config';

// The AI projects golden set (README.md): its own config, so the package's `vitest run` (test/**)
// never picks it up. Run with `pnpm --filter @contentworker/http eval:ai-projects`; it skips itself
// unless CW_EVAL_AI_PROJECTS=1 and CW_EVAL_BASE_URL are set. Model calls are slow: long timeouts,
// one file, no parallelism (the dev space's AI budget is shared).
export default defineConfig({
  test: {
    include: ['eval/ai-projects/**/*.eval.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
  },
});
