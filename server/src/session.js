import { EncryptJWT, jwtDecrypt } from "jose";
import { config } from "./config.js";
import { findUserById, githubTokenOf, publicUser } from "./db.js";

// The session cookie only identifies the account: an encrypted JWT (JWE)
// holding its id. Everything else, including the GitHub token, is loaded from
// MongoDB on each request, so signing out or in again never loses a
// connected GitHub account or a saved Anthropic key.
//
// It also holds the account's sessionVersion from when it was made (sv). Raising
// users.sessionVersion (bumpSessionVersion) makes every older cookie stale, which is
// how "sign out other devices" works. Cookies from before sv count as version 0.

async function encryptSession(uid, sv) {
  return new EncryptJWT({ uid, sv })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setSubject(uid)
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
    // Cookies from before accounts existed carry no uid: treated as signed out.
    if (typeof payload.uid !== "string") return null;
    return { uid: payload.uid, sv: Number.isInteger(payload.sv) ? payload.sv : 0 };
  } catch {
    return null;
  }
}

export function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
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

/** Signs this browser in, at the account's current sessionVersion. */
export async function setSession(res, uid, sessionVersion = 0) {
  res.cookie(config.sessionCookie, await encryptSession(uid, sessionVersion), cookieOptions(config.sessionMaxAgeSeconds));
}

/** The signed-in account, or null: no cookie, a bad one, or one older than the account's last "sign out other devices". */
export async function sessionAccount(req) {
  const session = await readSession(req);
  const account = session ? await findUserById(session.uid) : null;
  if (!account || (account.sessionVersion ?? 0) !== session.sv) return null;
  return account;
}

export function clearSession(res) {
  res.clearCookie(config.sessionCookie, { path: "/" });
}

/**
 * Loads the signed-in account onto the request:
 *   req.user        publicUser() shape: { id, email, name, github | null }
 *   req.githubAuth  the decrypted GitHub token, or null when not connected
 */
export async function requireAuth(req, res, next) {
  const account = await sessionAccount(req);
  if (!account) {
    if (req.cookies?.[config.sessionCookie]) clearSession(res);
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.user = publicUser(account);
  req.githubAuth = account.github ? githubTokenOf(account) : null;
  next();
}

/** For routes that act on GitHub. Use after requireAuth. */
export function requireGithub(req, res, next) {
  if (!req.user.github || !req.githubAuth) {
    return res.status(401).json({ error: "github_not_connected", message: "Connect your GitHub account first." });
  }
  next();
}
