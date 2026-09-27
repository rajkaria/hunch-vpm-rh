import { defineConfig } from "vitest/config";

// tests/matchstick holds AssemblyScript compiled by `graph test`, not TypeScript vitest can
// import. Without this include, vitest picks those files up and fails on graph-ts's WASM
// allocator shim.
export default defineConfig({
  test: {
    include: ["tests/node/**/*.test.ts"],
  },
});
