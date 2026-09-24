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

function dataKey() {
  // Trimmed: a stray space pasted after the value shouldn't stop the server.
  const hex = required("DATA_ENCRYPTION_KEY").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  }
  return Buffer.from(hex, "hex");
}

const clientUrl =process.env.CLIENT_URL ?? "http://localhost:3000";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // 127.0.0.1 in production: only the Next.js server should reach the API.
  host: process.env.HOST || undefined,
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
  // Browsers only send Secure cookies over HTTPS. Defaults to on in production;
  // set COOKIE_SECURE=false only to try a plain-http deployment.
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
  mongo: {
    uri: required("MONGODB_URI"),
    dbName: process.env.MONGODB_DB || "twinstack",
  },
  // 256-bit key that encrypts secrets stored in MongoDB (users' Anthropic keys).
  // Separate from JWT_SECRET so rotating sessions doesn't make stored keys unreadable.
  dataKey: dataKey(),
  // The site repo users copy. Only it can be duplicated, it is never managed
  // directly, and only copies of it can be managed.
  siteTemplate: (process.env.SITE_TEMPLATE_REPO || "DemoProjectDjango/twinstack-site").toLowerCase(),
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
