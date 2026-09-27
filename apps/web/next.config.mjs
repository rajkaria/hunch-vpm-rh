/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A rehearsal build (NEXT_PUBLIC_E2E=1, a local deployment) can go to its own folder so it
  // never replaces the production build in .next (see scripts/local-venue.ts).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
