import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Cold-start budget, not a per-test budget. `pnpm -r --if-present test` runs every
    // package at once against an empty Vite transform cache, and the transform of a large
    // module graph lands inside the first test that imports it — so a 300ms test measures
    // as 5s on a cold CI runner and passes in 30ms warm. The tests themselves are fast; the
    // default 5s ceiling is measuring compilation.
    testTimeout: 20_000,
    hookTimeout: 20_000,

    // The decision procedure is pure and the dry-run adapters hold no timers,
    // so nothing here needs a network, a key, or a clock it does not own.
    environment: "node",
  },
});
