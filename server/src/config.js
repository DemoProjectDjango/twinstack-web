import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAST_MODEL_ID } from "./ai-providers.js";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * FAST_PAGE_MODEL: the cheaper model (a deepseek-* or OpenAI id), "off", or null when unset. The
 * admin's choice on /admin/models takes its place (fast-model.js); it's the default until then.
 */
function fastPageModel() {
  const chosen = process.env.FAST_PAGE_MODEL?.trim();
  if (!chosen) return null;
  if (chosen !== "off" && !FAST_MODEL_ID.test(chosen)) {
    throw new Error(`FAST_PAGE_MODEL must be a deepseek-* or OpenAI (gpt-*) model or "off", not "${chosen}".`);
  }
  return chosen;
}

function imageModel() {
  const chosen = process.env.IMAGE_MODEL?.trim();
  if (!chosen) return "gpt-image-2";
  if (!/^gpt-image-[\w.-]+$/.test(chosen)) throw new Error(`IMAGE_MODEL must be an OpenAI gpt-image-* model, not "${chosen}".`);
  return chosen;
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
  // The app's own Anthropic key. Claude runs on it for every account without a key of its own,
  // paid for with the account's credits (credits.js). It never reaches the site's scripts: they
  // talk to Claude through the metering proxy (claude-proxy.js). Unset, only accounts with their
  // own key can use Claude.
  platformAnthropicKey: process.env.PLATFORM_ANTHROPIC_KEY?.trim() || null,
  // The app's DeepSeek and OpenAI keys, for the cheaper "fast" model (fast-model.js). The metering
  // proxy sends deepseek-* requests to DeepSeek and OpenAI ones to OpenAI, and Claude commands on
  // credits get the fast model as TWINSTACK_FAST_MODEL: the site's page editor uses it for routine
  // page work once the site has a design to follow, and falls back to the account's Claude model
  // when its result fails the checks. A fast model whose provider has no key here isn't used.
  deepseekKey: process.env.DEEPSEEK_API_KEY?.trim() || null,
  openaiKey: process.env.OPENAI_API_KEY?.trim() || null,
  fastPageModel: fastPageModel(),
  // The OpenAI image model "Ask Claude" makes pictures with (images.js, create_image's prompt), on
  // OPENAI_API_KEY and paid for in credits. Unset: gpt-image-2.
  imageModel: imageModel(),
  // Buying credits adds them at once without taking a payment, until a payment provider is set
  // up. On by default; set CREDITS_DEMO_PURCHASES=false to turn buying off.
  demoPurchases: process.env.CREDITS_DEMO_PURCHASES !== "false",
  // The site repo users copy. Only it can be duplicated, it is never managed
  // directly, and only copies of it can be managed.
  siteTemplate: (process.env.SITE_TEMPLATE_REPO || "DemoProjectDjango/twinstack-site").toLowerCase(),
  // A read-only GitHub token for the template (a fine-grained token with Contents: read on that
  // one repo). Approved accounts copy, install from and update from the template with it, so
  // nobody needs to be a collaborator on it. Unset, each account's own GitHub token is used.
  templateToken: process.env.TEMPLATE_GITHUB_TOKEN?.trim() || null,
  // Accounts (by sign-in email) that review access requests on /admin/access. Always approved.
  adminEmails: (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  // Email through Resend (resend.com). Unset, emails are written to the server log instead.
  email: {
    resendKey: process.env.RESEND_API_KEY?.trim() || null,
    from: process.env.EMAIL_FROM?.trim() || "Twinstack <onboarding@resend.dev>",
  },
  // Where site working copies are cloned. Must survive restarts to keep
  // uncommitted work, so point it at persistent disk outside tmp in production.
  workspacesDir: path.resolve(process.env.WORKSPACES_DIR || path.join(tmpdir(), "twinstack-workspaces")),
};
