import path from "node:path";
import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // The repo root has its own lockfile (for `concurrently`); pin the app root here.
  turbopack: { root: path.resolve(".") },
  experimental: {
    // Duplicating a large repo (clone + push on the API) can outlast the 30s default.
    proxyTimeout: 10 * 60 * 1000,
  },
  // Proxy auth + API calls to Express so the browser only ever talks to one
  // origin and the httpOnly session cookie is first-party.
  async rewrites() {
    return [
      { source: "/auth/:path*", destination: `${apiUrl}/auth/:path*` },
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
    ];
  },
};

export default nextConfig;
