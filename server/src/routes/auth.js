import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { exchangeCode, githubFetch } from "../github.js";
import { cookieOptions, setSession } from "../session.js";

export const authRouter = Router();

function redirectWithError(res, code) {
  res.clearCookie(config.stateCookie, { path: "/" });
  res.redirect(`${config.clientUrl}/?error=${encodeURIComponent(code)}`);
}

function statesMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Step 1: send the user to GitHub's consent screen.
authRouter.get("/github", (req, res) => {
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
});

// Step 2: GitHub redirects back here with ?code&state.
authRouter.get("/github/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return redirectWithError(res, String(error));
  if (!code || !statesMatch(state, req.cookies?.[config.stateCookie])) {
    return redirectWithError(res, "invalid_state");
  }

  try {
    let github;
    try {
      github = await exchangeCode(code);
    } catch (err) {
      console.error(err.message, err.details);
      return redirectWithError(res, "token_exchange_failed");
    }

    const userRes = await githubFetch("/user", github.accessToken);
    if (!userRes.ok) return redirectWithError(res, "profile_fetch_failed");
    const profile = await userRes.json();

    // Public email may be null; fall back to the primary verified address.
    let email = profile.email;
    if (!email) {
      const emailsRes = await githubFetch("/user/emails", github.accessToken);
      if (emailsRes.ok) {
        const emails = await emailsRes.json();
        email = emails.find((e) => e.primary && e.verified)?.email ?? null;
      }
    }

    const user = {
      id: profile.id,
      login: profile.login,
      name: profile.name,
      email,
      avatarUrl: profile.avatar_url,
      profileUrl: profile.html_url,
    };

    res.clearCookie(config.stateCookie, { path: "/" });
    await setSession(res, { user, github });
    res.redirect(`${config.clientUrl}/dashboard`);
  } catch (err) {
    console.error("GitHub OAuth callback error:", err);
    redirectWithError(res, "oauth_failed");
  }
});

authRouter.post("/logout", (req, res) => {
  res.clearCookie(config.sessionCookie, { path: "/" });
  res.redirect(303, config.clientUrl);
});
