import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import {
  DuplicateEmailError,
  GithubInUseError,
  bumpSessionVersion,
  createUser,
  deleteCodeRecord,
  findCodeRecord,
  findUserByEmail,
  grantGithubCredits,
  linkGithub,
  publicUser,
  recordLogin,
  recordWrongCode,
  saveCodeRecord,
  setPassword,
  unlinkGithub,
} from "../db.js";
import { sendEmail } from "../email.js";
import { CODE_RESEND_MS, checkCode, newCode, readCodeAttempt, sendRefusal } from "../email-codes.js";
import { exchangeCode, githubFetch } from "../github.js";
import { PASSWORD_MAX, PASSWORD_MIN, hashPassword, verifyAgainstDummy, verifyPassword } from "../passwords.js";
import { clearSession, cookieOptions, requireAuth, sessionAccount, setSession } from "../session.js";

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

// Registering is two steps, so only people who receive email at the address get an
// account: /register emails a 6-digit code and returns a token for this browser, and
// /register/verify creates the account once both match (email-codes.js). Nothing exists
// before that, so an address can't be claimed (free credits, an ADMIN_EMAILS address)
// by someone who doesn't own it.

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
    if (config.isProduction && !config.email.resendKey) {
      console.error("Sign-up refused: RESEND_API_KEY isn't set, so the confirmation code can't be emailed.");
      return res.status(503).json({ error: "Sign-up is unavailable right now. Try again later." });
    }

    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    const refusal = sendRefusal(await findCodeRecord("signup", email), req.ip, "sign-ups");
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const { code, token, fields } = newCode(email);
    await saveCodeRecord("signup", email, { ...fields, name, passwordHash: await hashPassword(password) });

    const sent = await sendEmail({
      to: email,
      subject: `${code} is your Twinstack code`,
      text:
        `Hi ${name},\n\nYour Twinstack sign-up code is ${code}\n\n` +
        `Enter it on the sign-up page to create your account. It expires in 15 minutes.\n\n` +
        `If you didn't try to create a Twinstack account, ignore this email.\n`,
    });
    // Without RESEND_API_KEY (development only, see above) the email is in the server log.
    if (!sent && config.email.resendKey) {
      await deleteCodeRecord("signup", email);
      return res.status(502).json({ error: "We couldn't send the code to that address. Check it and try again." });
    }
    res.status(202).json({ verify: true, email, token, retryAfter: CODE_RESEND_MS / 1000 });
  }),
);

authRouter.post(
  "/register/verify",
  requireJson,
  handle(async (req, res) => {
    const attempt = readCodeAttempt(req.body);
    const { email } = attempt;
    if (!email || !attempt.token || !attempt.code) {
      return res.status(400).json({ error: "Enter the 6-digit code from the email." });
    }

    const pending = await findCodeRecord("signup", email);
    const check = checkCode(pending, attempt, "Start again.");
    if (!check.ok) {
      if (check.wrongCode) await recordWrongCode("signup", email, check.tokenHash);
      if (check.discard) await deleteCodeRecord("signup", email);
      return res.status(check.status).json(check.body);
    }

    let account;
    try {
      account = await createUser({ email, name: pending.name, passwordHash: pending.passwordHash });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
      throw err;
    } finally {
      await deleteCodeRecord("signup", email);
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
    await setSession(res, id, account.sessionVersion ?? 0);
    res.json({ user: publicUser(account) });
  }),
);

/* --------------------------------------------------------- reset password */

// The same two steps as registering: /password/forgot emails a code and returns a token,
// /password/reset takes both with the new password. /password/forgot answers the same
// whether or not an account uses the address, so it can't be used to find out: for an
// unknown address it saves a record too (so the resend wait and limits behave the same),
// but sends nothing, and nobody knows that record's code.

authRouter.post(
  "/password/forgot",
  requireJson,
  handle(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (config.isProduction && !config.email.resendKey) {
      console.error("Password reset refused: RESEND_API_KEY isn't set, so the code can't be emailed.");
      return res.status(503).json({ error: "Password reset is unavailable right now. Try again later." });
    }
    const refusal = sendRefusal(await findCodeRecord("reset", email), req.ip, "password resets");
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const account = await findUserByEmail(email);
    const { code, token, fields } = newCode(email);
    await saveCodeRecord("reset", email, fields);
    if (account) {
      const sent = await sendEmail({
        to: email,
        subject: `${code} is your Twinstack password reset code`,
        text:
          `Hi ${account.name},\n\nYour Twinstack password reset code is ${code}\n\n` +
          `Enter it on the reset page to choose a new password. It expires in 15 minutes.\n\n` +
          `If you didn't ask to reset your password, ignore this email: your password stays as it is.\n`,
      });
      // Answered as if sent either way, so a failure doesn't reveal that the account exists.
      if (!sent && config.email.resendKey) console.error(`Password reset code for account ${account._id} wasn't sent.`);
    }
    res.status(202).json({ email, token, retryAfter: CODE_RESEND_MS / 1000 });
  }),
);

authRouter.post(
  "/password/reset",
  requireJson,
  handle(async (req, res) => {
    const attempt = readCodeAttempt(req.body);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!attempt.email || !attempt.token || !attempt.code) {
      return res.status(400).json({ error: "Enter the 6-digit code from the email." });
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return res.status(400).json({ error: `Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` });
    }

    const check = checkCode(await findCodeRecord("reset", attempt.email), attempt, "Ask for a new code.");
    if (!check.ok) {
      if (check.wrongCode) await recordWrongCode("reset", attempt.email, check.tokenHash);
      if (check.discard) await deleteCodeRecord("reset", attempt.email);
      return res.status(check.status).json(check.body);
    }
    await deleteCodeRecord("reset", attempt.email);
    const account = await findUserByEmail(attempt.email);
    if (!account) return res.status(410).json({ error: "This account no longer exists.", restart: true });

    const id = account._id.toHexString();
    await setPassword(id, await hashPassword(password));
    failures.delete(attempt.email);
    await recordLogin(id);
    // Other browsers stay signed in until the person chooses to sign them out (/sessions/end-others).
    await setSession(res, id, account.sessionVersion ?? 0);
    sendEmail({
      to: attempt.email,
      subject: "Your Twinstack password was changed",
      text:
        `Hi ${account.name},\n\nThe password for your Twinstack account was just changed with a reset code.\n\n` +
        `If that wasn't you, reset it again now from the log-in page and sign out your other devices when asked.\n`,
    });
    res.json({ user: publicUser(account) });
  }),
);

// Signs out every browser but this one (it gets a fresh cookie at the new version).
authRouter.post(
  "/sessions/end-others",
  requireJson,
  requireAuth,
  handle(async (req, res) => {
    const version = await bumpSessionVersion(req.user.id);
    await setSession(res, req.user.id, version);
    res.json({ ok: true });
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
  const account = await sessionAccount(req);
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
    const free = await grantGithubCredits(account._id.toHexString(), profile.id);

    res.clearCookie(config.stateCookie, { path: "/" });
    res.redirect(`${config.clientUrl}/dashboard?github=connected${free ? `&credits=${free}` : ""}`);
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
