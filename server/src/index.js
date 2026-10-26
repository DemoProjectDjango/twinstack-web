import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { connectDb, recordSiteCopy } from "./db.js";
import { hasTemplateAccess, isTemplate, templateToken, withSiteRoles } from "./sites.js";
import { accessRouter, adminRouter } from "./routes/access.js";
import { authRouter } from "./routes/auth.js";
import { collectRouter } from "./routes/analytics.js";
import { creditsRouter } from "./routes/credits.js";
import { startClaudeProxy } from "./claude-proxy.js";
import { startProviderMonitor } from "./provider-health.js";
import { stripeWebhook } from "./stripe.js";
import { loadFastModelChoice } from "./fast-model.js";
import { loadImageModelChoice } from "./image-model.js";
import { previewRouter } from "./routes/preview.js";
import { settingsRouter } from "./routes/settings.js";
import { jobsRouter, workspacesRouter } from "./routes/workspaces.js";
import { requireAuth, requireGithub } from "./session.js";
import { ReauthRequiredError, getAccessToken, listRepos } from "./github.js";
import { DuplicateError, MissingScopeError, duplicateRepo, isValidRepoName } from "./duplicate.js";
import { setUpNewSite } from "./new-site.js";
import { enablePages, getSiteSummary } from "./publishing.js";
import { DeletePermissionError, deleteSite } from "./site-delete.js";
import { WorkspaceError, assertRepoRef } from "./workspace.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
// Default 100kb JSON bodies everywhere except image uploads, HTML pages to
// convert (with their CSS) and saved stylesheets, which parse their own.
// Stripe signs the exact bytes it sends, so its webhook takes the raw body, before JSON parsing.
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhook);
const json = express.json();
const UPLOAD_PATH = /^\/api\/workspaces\/[^/]+\/[^/]+\/(uploads|html-source|css\/source|brand\/image|assistant\/attachments)$/;
app.use((req, res, next) => (UPLOAD_PATH.test(req.path) ? next() : json(req, res, next)));
app.use(cookieParser());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, msg: "API is running now." });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/repos", requireAuth, requireGithub, async (req, res) => {
  try {
    const accessToken = await getAccessToken(req, res);
    // Only the site template (for approved accounts) and copies of it are shown.
    res.json({ repos: await withSiteRoles(await listRepos(accessToken), req.user) });
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return res.status(401).json({ error: "reauth_required" });
    }
    console.error("Failed to list repositories:", err);
    res.status(502).json({ error: "github_unavailable" });
  }
});

app.post("/api/repos/:owner/:repo/duplicate", requireAuth, requireGithub, async (req, res) => {
  // JSON-only: plain HTML forms from other sites can't send this content type.
  if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });

  if (!isTemplate(`${req.params.owner}/${req.params.repo}`)) {
    return res.status(403).json({ error: "Only the TwinStack site template can be duplicated." });
  }

  if (!hasTemplateAccess(req.user)) {
    return res.status(403).json({ error: "access_required", message: "Your account needs to be approved before you can create a site." });
  }

  // Public unless asked: GitHub Pages can't publish a private repo on a free plan.
  const { name, private: isPrivate = false } = req.body ?? {};
  if (!isValidRepoName(name)) {
    return res.status(400).json({ error: "Use 1-100 letters, numbers, '.', '-' or '_' for the name." });
  }

  // Sessions from before `workflow` was requested can't push repos containing Actions workflows.
  if (!req.githubAuth.scopes?.includes("workflow")) {
    return res.status(401).json({
      error: "reauth_required",
      message: "Duplicating needs one more GitHub permission (workflow files). Reconnect GitHub.",
    });
  }

  try {
    const accessToken = await getAccessToken(req, res);
    const repo = await duplicateRepo({
      accessToken,
      sourceToken: templateToken(req.user, accessToken),
      userLogin: req.user.github.login,
      owner: req.params.owner,
      repo: req.params.repo,
      newName: name,
      isPrivate: Boolean(isPrivate),
    });
    // Recorded by repo id, so the copy stays manageable even if it's renamed later.
    // The name as typed ("Bright Bakery"), shown until the site's details give it one (getSiteDisplayName).
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim().slice(0, 100) || null : null;
    await recordSiteCopy({ userId: req.user.id, repo, source: config.siteTemplate, displayName });
    // So the push above, and every later one to the default branch, deploys the
    // site. If GitHub refuses (a private repo on a plan without Pages, say), the
    // site manager shows why and offers to try again.
    await enablePages(accessToken, repo.fullName).catch((err) =>
      console.warn(`Couldn't turn on Pages for ${repo.fullName}: ${err.message}`),
    );
    // Its name and a starter homepage, in one commit (new-site.js). After Pages is on, so the
    // deploy that commit starts publishes the site.
    await setUpNewSite({ accessToken, fullName: repo.fullName, displayName });
    res.status(201).json({ repo: { ...repo, role: "copy" } });
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return res.status(401).json({ error: "reauth_required" });
    }
    if (err instanceof MissingScopeError) {
      return res.status(401).json({ error: "reauth_required", message: err.message });
    }
    if (err instanceof DuplicateError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Failed to duplicate repository:", err);
    res.status(502).json({
      error: err.partialRepo
        ? `${err.message}. The empty repository ${err.partialRepo} was kept; retrying with the same name will reuse it.`
        : "Duplicating failed. Please try again.",
    });
  }
});

// A site card's name and live status (publishing.js), fetched by each card after the list.
app.get("/api/repos/:owner/:repo/summary", requireAuth, requireGithub, async (req, res) => {
  try {
    assertRepoRef(req.params.owner, req.params.repo);
    const accessToken = await getAccessToken(req, res);
    const summary = await getSiteSummary(accessToken, `${req.params.owner}/${req.params.repo}`);
    if (!summary) return res.status(404).json({ error: "Not one of your sites." });
    res.json(summary);
  } catch (err) {
    if (err instanceof ReauthRequiredError) return res.status(401).json({ error: "reauth_required" });
    if (err instanceof WorkspaceError) return res.status(err.status).json({ error: err.message });
    console.error("Failed to read site summary:", err);
    res.status(502).json({ error: "github_unavailable" });
  }
});

// The site card's "Delete site" (site-delete.js): only the site's creator; `deleteRepo` also deletes it on GitHub.
app.delete("/api/repos/:owner/:repo", requireAuth, requireGithub, async (req, res) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });
  try {
    assertRepoRef(req.params.owner, req.params.repo);
    if (isTemplate(`${req.params.owner}/${req.params.repo}`)) {
      return res.status(403).json({ error: "The site template can't be deleted." });
    }
    const accessToken = await getAccessToken(req, res);
    res.json(
      await deleteSite({
        user: req.user,
        scopes: req.githubAuth.scopes ?? [],
        accessToken,
        owner: req.params.owner,
        repo: req.params.repo,
        deleteRepo: req.body?.deleteRepo === true,
      }),
    );
  } catch (err) {
    if (err instanceof ReauthRequiredError) return res.status(401).json({ error: "reauth_required" });
    if (err instanceof DeletePermissionError) {
      return res.status(403).json({ error: "delete_permission_required", message: err.message });
    }
    if (err instanceof WorkspaceError) return res.status(err.status).json({ error: err.message });
    console.error("Failed to delete site:", err);
    res.status(500).json({ error: "The site couldn't be deleted. Please try again." });
  }
});

// Public: published sites' visit counter posts here (analytics.js). It never answers with data.
app.use("/api/collect", collectRouter);
app.use("/api/access", accessRouter);
app.use("/api/admin", adminRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/credits", creditsRouter);
app.use("/api/workspaces", workspacesRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/preview", previewRouter);

app.use("/auth", authRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Fail fast: without the database nothing that needs sign-in works.
await connectDb();
await loadFastModelChoice();
await loadImageModelChoice();
console.log(`Connected to MongoDB (${config.mongo.dbName})`);
// Claude commands run on credits reach Claude only through it.
await startClaudeProxy();
// Watches the app's provider balances and emails the admins before one runs out.
startProviderMonitor();
if (!config.platformAnthropicKey) console.log("PLATFORM_ANTHROPIC_KEY isn't set: only accounts with their own Anthropic key can use Claude.");

app.listen(config.port, config.host, () => {
  console.log(`API listening on http://${config.host ?? "localhost"}:${config.port}`);
});
