import { defineConfig } from 'vitest/config';

/**
 * Two projects: the server and library tests (`*.test.ts`) in node, and the CMS screens and
 * components (`*.test.tsx`) in jsdom with React Testing Library.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/**/*.test.tsx'],
          setupFiles: ['tests/setup-dom.ts'],
        },
      },
    ],
  },
});
