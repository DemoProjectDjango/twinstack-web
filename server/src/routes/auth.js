import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import {
  DuplicateEmailError,
  GithubInUseError,
  createUser,
  findUserByEmail,
  findUserById,
  linkGithub,
  publicUser,
  recordLogin,
  unlinkGithub,
} from "../db.js";
import { exchangeCode, githubFetch } from "../github.js";
import { PASSWORD_MAX, PASSWORD_MIN, hashPassword, verifyAgainstDummy, verifyPassword } from "../passwords.js";
import { clearSession, cookieOptions, readSession, requireAuth, setSession } from "../session.js";

// Accounts are email + password. GitHub is connected to an account afterwards
// (it's needed only for the repository and site features).

export const authRouter = Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`${req.method} ${req.originalUrl} failed:`, err);
      res.status(500).json({ error: "Something went wrong. Try again." });
    }
  };
}

// JSON-only: plain HTML forms from other sites can't send this content type.
function requireJson(req, res, next) {
  if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });
  next();
}

/* ------------------------------------------------------ register & log in */

// Failed logins per email, to slow down password guessing. In memory, so it
// resets on restart; enough for a single-server deployment.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const failures = new Map();

function tooManyFailures(email) {
  const entry = failures.get(email);
  if (!entry || entry.resetAt < Date.now()) {
    failures.delete(email);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordFailure(email) {
  const entry = failures.get(email);
  if (!entry || entry.resetAt < Date.now()) failures.set(email, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else entry.count += 1;
}

function readCredentials(body) {
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  return { email, password };
}

authRouter.post(
  "/register",
  requireJson,
  handle(async (req, res) => {
    const { email, password } = readCredentials(req.body);
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return res.status(400).json({ error: `Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` });
    }
    if (!name) return res.status(400).json({ error: "Enter your name." });

    let account;
    try {
      account = await createUser({ email, name, passwordHash: await hashPassword(password) });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
      throw err;
    }
    await setSession(res, account._id.toHexString());
    res.status(201).json({ user: publicUser(account) });
  }),
);

authRouter.post(
  "/login",
  requireJson,
  handle(async (req, res) => {
    const { email, password } = readCredentials(req.body);
    if (!email || !password || password.length > PASSWORD_MAX) {
      return res.status(400).json({ error: "Enter your email and password." });
    }
    if (tooManyFailures(email)) {
      return res.status(429).json({ error: "Too many failed attempts. Wait 15 minutes and try again." });
    }

    const account = await findUserByEmail(email);
    const valid = account ? await verifyPassword(password, account.passwordHash) : await verifyAgainstDummy(password);
    if (!valid) {
      recordFailure(email);
      // Same message either way, so it doesn't reveal which emails have accounts.
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    failures.delete(email);
    const id = account._id.toHexString();
    await recordLogin(id);
    await setSession(res, id);
    res.json({ user: publicUser(account) });
  }),
);

authRouter.post("/logout", (req, res) => {
  clearSession(res);
  // A plain form post (the navbar's Sign out) gets a redirect; fetch gets JSON.
  if (req.is("application/json")) return res.json({ ok: true });
  res.redirect(303, config.clientUrl);
});

/* ---------------------------------------------------------- connect GitHub */

function redirectWithGithubError(res, code) {
  res.clearCookie(config.stateCookie, { path: "/" });
  res.redirect(`${config.clientUrl}/dashboard?github_error=${encodeURIComponent(code)}`);
}

function statesMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** For the two browser-navigation GitHub routes: no JSON 401, send guests to log in. */
async function accountOrLogin(req, res) {
  const session = await readSession(req);
  const account = session ? await findUserById(session.uid) : null;
  if (!account) res.redirect(`${config.clientUrl}/login?next=${encodeURIComponent("/dashboard")}`);
  return account;
}

// Step 1: send the signed-in user to GitHub's consent screen.
authRouter.get(
  "/github",
  handle(async (req, res) => {
    if (!(await accountOrLogin(req, res))) return;
    const state = randomBytes(32).toString("hex");
    res.cookie(config.stateCookie, state, cookieOptions(10 * 60));

    const params = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: config.github.callbackUrl,
      // `repo` is the only OAuth App scope that grants access to private repositories.
      // `workflow` is required to push .github/workflows/* files when duplicating.
      scope: "read:user user:email repo workflow",
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  }),
);

// Step 2: GitHub redirects back here with ?code&state; link it to the account.
authRouter.get("/github/callback", async (req, res) => {
  const { code, state, error } = req.query;
  try {
    const account = await accountOrLogin(req, res);
    if (!account) return;
    if (error) return redirectWithGithubError(res, String(error));
    if (!code || !statesMatch(state, req.cookies?.[config.stateCookie])) {
      return redirectWithGithubError(res, "invalid_state");
    }

    let token;
    try {
      token = await exchangeCode(code);
    } catch (err) {
      console.error(err.message, err.details);
      return redirectWithGithubError(res, "token_exchange_failed");
    }

    const userRes = await githubFetch("/user", token.accessToken);
    if (!userRes.ok) return redirectWithGithubError(res, "profile_fetch_failed");
    const profile = await userRes.json();

    // Public email may be null; fall back to the primary verified address.
    let email = profile.email;
    if (!email) {
      const emailsRes = await githubFetch("/user/emails", token.accessToken);
      if (emailsRes.ok) {
        const emails = await emailsRes.json();
        email = emails.find((e) => e.primary && e.verified)?.email ?? null;
      }
    }

    try {
      await linkGithub(
        account._id.toHexString(),
        {
          id: profile.id,
          login: profile.login,
          name: profile.name,
          email,
          avatarUrl: profile.avatar_url,
          profileUrl: profile.html_url,
        },
        token,
      );
    } catch (err) {
      if (err instanceof GithubInUseError) return redirectWithGithubError(res, "github_in_use");
      throw err;
    }

    res.clearCookie(config.stateCookie, { path: "/" });
    res.redirect(`${config.clientUrl}/dashboard?github=connected`);
  } catch (err) {
    console.error("GitHub OAuth callback error:", err);
    redirectWithGithubError(res, "oauth_failed");
  }
});

authRouter.post(
  "/github/disconnect",
  requireJson,
  requireAuth,
  handle(async (req, res) => {
    await unlinkGithub(req.user.id);
    res.json({ ok: true });
  }),
);
