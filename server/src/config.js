import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

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
  // Where site working copies are cloned. Must survive restarts to keep
  // uncommitted work, so point it at persistent disk outside tmp in production.
  workspacesDir: path.resolve(process.env.WORKSPACES_DIR || path.join(tmpdir(), "twinstack-workspaces")),
  // Who may open site workspaces (which runs the site repo's own code on this
  // server). Empty means everyone in development and no one in production.
  allowedLogins: (process.env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean),
};
