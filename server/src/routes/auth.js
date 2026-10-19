import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import {
  DuplicateEmailError,
  GithubInUseError,
  createUser,
  deletePendingSignup,
  findPendingSignup,
  findUserByEmail,
  findUserById,
  linkGithub,
  publicUser,
  recordLogin,
  recordSignupAttempt,
  savePendingSignup,
  unlinkGithub,
} from "../db.js";
import { sendEmail } from "../email.js";
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

// Registering is two steps, so only people who receive email at the address get an
// account: /register emails a 6-digit code and returns a token for this browser, and
// /register/verify creates the account once both match. Nothing exists before that,
// so an address can't be claimed (free credits, an ADMIN_EMAILS address) by someone
// who doesn't own it. The token stops a second sign-up for the same address from
// setting the password the owner's code then confirms: a newer attempt replaces it.
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_MS = 60 * 1000;
const CODE_MAX_SENDS = 5; // per address, within PENDING_SIGNUP_MS
// Codes emailed per IP, to stop the form being used to email strangers. In memory, like failures.
const SIGNUP_IP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_IP_MAX = 10;
const signupsByIp = new Map();

function signupIpLimited(ip) {
  const entry = signupsByIp.get(ip);
  if (!entry || entry.resetAt < Date.now()) {
    signupsByIp.set(ip, { count: 1, resetAt: Date.now() + SIGNUP_IP_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > SIGNUP_IP_MAX;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sameHash(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
    if (config.isProduction && !config.email.resendKey) {
      console.error("Sign-up refused: RESEND_API_KEY isn't set, so the confirmation code can't be emailed.");
      return res.status(503).json({ error: "Sign-up is unavailable right now. Try again later." });
    }

    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    const pending = await findPendingSignup(email);
    const waitMs = pending ? pending.sentAt.getTime() + CODE_RESEND_MS - Date.now() : 0;
    if (waitMs > 0) {
      // retryAfter (seconds) drives the form's "Send a new code" countdown.
      return res.status(429).json({
        error: "We just sent a code. Wait a minute before asking for another.",
        retryAfter: Math.ceil(waitMs / 1000),
      });
    }
    if (pending && pending.sends >= CODE_MAX_SENDS) {
      return res.status(429).json({ error: "Too many codes sent to this address. Try again in an hour." });
    }
    if (signupIpLimited(req.ip)) {
      return res.status(429).json({ error: "Too many sign-ups from here. Try again in an hour." });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const token = randomBytes(32).toString("hex");
    await savePendingSignup(email, {
      name,
      passwordHash: await hashPassword(password),
      codeHash: sha256(`${email}:${code}`),
      tokenHash: sha256(token),
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

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
      await deletePendingSignup(email);
      return res.status(502).json({ error: "We couldn't send the code to that address. Check it and try again." });
    }
    res.status(202).json({ verify: true, email, token, retryAfter: CODE_RESEND_MS / 1000 });
  }),
);

authRouter.post(
  "/register/verify",
  requireJson,
  handle(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const code = typeof req.body?.code === "string" ? req.body.code.replace(/\s+/g, "") : "";
    if (!email || !token || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Enter the 6-digit code from the email." });
    }

    const pending = await findPendingSignup(email);
    const tokenHash = sha256(token);
    if (!pending || !sameHash(pending.tokenHash, tokenHash)) {
      return res.status(410).json({ error: "This sign-up has expired or was replaced. Start again.", restart: true });
    }
    if (pending.attempts >= CODE_MAX_ATTEMPTS) {
      await deletePendingSignup(email);
      return res.status(429).json({ error: "Too many wrong codes. Start again to get a new one.", restart: true });
    }
    if (pending.codeExpiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: "That code has expired. Send a new one.", expired: true });
    }
    if (!sameHash(pending.codeHash, sha256(`${email}:${code}`))) {
      await recordSignupAttempt(email, tokenHash);
      return res.status(400).json({ error: "That code isn't right. Check the email and try again." });
    }

    let account;
    try {
      account = await createUser({ email, name: pending.name, passwordHash: pending.passwordHash });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
      throw err;
    } finally {
      await deletePendingSignup(email);
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
