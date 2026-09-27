import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': here('./src'),
      // The workspace packages from source, so tests never need their `dist`.
      '@hunch-rh/client': here('../../packages/client/src/index.ts'),
      '@hunch-rh/keeper': here('../../packages/keeper/src/index.ts'),
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
