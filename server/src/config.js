import { createHash } from "node:crypto";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const clientUrl = process.env.CLIENT_URL ?? "http://localhost:3000";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  clientUrl,
  isProduction: process.env.NODE_ENV === "production",
  github: {
    clientId: required("GITHUB_CLIENT_ID"),
    clientSecret: required("GITHUB_CLIENT_SECRET"),
    // The callback goes through the Next.js app (proxied via rewrites) so the
    // session cookie is set on the same origin the browser is using.
    callbackUrl: process.env.GITHUB_CALLBACK_URL ?? `${clientUrl}/auth/github/callback`,
  },
  // 256-bit key for encrypting the session cookie (it carries the GitHub token).
  sessionKey: createHash("sha256").update(required("JWT_SECRET")).digest(),
  sessionCookie: "session",
  stateCookie: "oauth_state",
  sessionMaxAgeSeconds: 60 * 60 * 24 * 7,
};
