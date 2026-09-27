import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nothing in this suite opens a socket. Signatures are produced with a real
    // secp256k1 key through viem's local account, and the AgentBook registry is
    // always a stub, so the verifier's network seam is exercised without a node.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    /**
     * Vitest's default is 5000ms, and three tests in `gate.test.ts` were tipping
     * over it when the whole workspace runs at once from a cold transform cache
     * (`pnpm -r --if-present test`, which is what CI runs).
     *
     * Measured rather than guessed, on this machine:
     *
     *   - The work is real. Each iteration of those loops builds a SIWE proof
     *     with a genuine secp256k1 signature and makes the gate recover the
     *     address from it: 1.8ms to sign, 6.7ms through the gate, so the longest
     *     loop is about 170ms of actual cryptography. That is the cost of testing
     *     a verifier against real signatures instead of a stub, and it is the
     *     point of the suite.
     *   - The loop counts are not padding. 20 is the human-backed allowance
     *     (10x the base) and the default verification budget; the tests exist to
     *     prove the 20th request is neither cut short nor let through, so a
     *     shorter loop would assert something weaker.
     *   - So the timeouts were not loop-bound, they were contention-bound. That
     *     same file's slowest test measured 539ms alone and 1580ms while five
     *     packages compiled and ran in parallel from cold — 9x its isolated cost,
     *     which leaves 5000ms only about 3x of headroom on a machine slower or
     *     busier than this one.
     *
     * 20s is roughly 12x the worst time observed under that load. It is a ceiling
     * for a stuck test, not a budget any test here is expected to spend.
     */
    testTimeout: 20_000,
  },
});
