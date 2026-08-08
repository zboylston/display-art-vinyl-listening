import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow phone/TV browsers on the LAN to load Next.js client JS in dev.
  allowedDevOrigins: ["192.168.4.44"],
};

export default nextConfig;
