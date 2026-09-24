import { EncryptJWT, jwtDecrypt } from "jose";
import { config } from "./config.js";

// The session is an encrypted JWT (JWE), not just signed, because it holds the
// user's GitHub access token and must not be readable by the browser.

async function encryptSession(session) {
  return new EncryptJWT(session)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setSubject(String(session.user.id))
    .setIssuedAt()
    .setExpirationTime(`${config.sessionMaxAgeSeconds}s`)
    .encrypt(config.sessionKey);
}

async function decryptSession(token) {
  try {
    const { payload } = await jwtDecrypt(token, config.sessionKey, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (!payload.user || !payload.github) return null;
    // The user's own Anthropic key rides in the same encrypted cookie; there is
    // no server-side store for it.
    return { user: payload.user, github: payload.github, anthropicKey: payload.anthropicKey ?? null };
  } catch {
    return null;
  }
}

export function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    // "lax" lets the cookie ride along on the top-level redirect back from GitHub.
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  };
}

/** The current session, or null when the cookie is missing, expired or tampered with. */
export async function readSession(req) {
  const token = req.cookies?.[config.sessionCookie];
  return token ? decryptSession(token) : null;
}

/** Writes `{ user, github, anthropicKey? }` to the session cookie. */
export async function setSession(res, session) {
  const token = await encryptSession(session);
  res.cookie(config.sessionCookie, token, cookieOptions(config.sessionMaxAgeSeconds));
}

export async function requireAuth(req, res, next) {
  const session = await readSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.session = session;
  req.user = session.user;
  next();
}
