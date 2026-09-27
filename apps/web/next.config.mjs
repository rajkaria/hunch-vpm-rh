/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    // Baked in at build time, always: '1' only when the build sets NEXT_PUBLIC_E2E=1, so a normal
    // build compiles the E2E mock wallet out entirely (no runtime switch can turn it on).
    NEXT_PUBLIC_E2E: process.env.NEXT_PUBLIC_E2E === '1' ? '1' : '',
  },
  // A rehearsal build (NEXT_PUBLIC_E2E=1, a local deployment) can go to its own folder so it
  // never replaces the production build in .next (see scripts/local-venue.ts).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
