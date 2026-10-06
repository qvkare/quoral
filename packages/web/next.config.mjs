/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@quoral/shared"],
  reactStrictMode: true,
  // lets a production build run next to `next dev` without sharing .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
export default nextConfig;
