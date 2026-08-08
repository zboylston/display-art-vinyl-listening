import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN devices and 127.0.0.1 (vs localhost) to load Next.js client JS in dev.
  // Without this, visiting http://127.0.0.1:3000 serves HTML but blocks /_next chunks,
  // so React never hydrates and buttons appear dead.
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.4.44"],
};

export default nextConfig;
