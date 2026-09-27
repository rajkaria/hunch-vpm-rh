/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Every page here renders from a data module that is synchronous and local by
  // default, so the whole surface prerenders at build time. When the live source
  // is switched on the market pages become dynamic on their own through fetch.
  poweredByHeader: false,
};

export default nextConfig;
