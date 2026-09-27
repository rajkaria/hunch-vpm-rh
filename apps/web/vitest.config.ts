import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // S7: when the web reads through @hunch-rh/client again, alias it to its source here
      // ('../../packages/client/src/index.ts') so tests never need its `dist`.
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Cold-start budget, not a per-test budget. `pnpm -r --if-present test` runs every
    // package at once against an empty Vite transform cache, and the transform of a large
    // module graph lands inside the first test that imports it — so a 300ms test measures
    // as 5s on a cold CI runner and passes in 30ms warm. The tests themselves are fast; the
    // default 5s ceiling is measuring compilation.
    testTimeout: 20_000,
    hookTimeout: 20_000,

    globals: false,
  },
});
