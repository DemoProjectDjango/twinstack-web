import { browserStatus, findChrome } from "./assistant/view-page.js";
import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { connectDb, recordSiteCopy } from "./db.js";
import { hasTemplateAccess, isTemplate, templateToken, withSiteRoles } from "./sites.js";
import { accessRouter, adminRouter } from "./routes/access.js";
import { authRouter } from "./routes/auth.js";
import { collectRouter } from "./routes/analytics.js";
import { agentPublicRouter } from "./routes/site-agent.js";
import { creditsRouter } from "./routes/credits.js";
import { startClaudeProxy } from "./claude-proxy.js";
import { startProviderMonitor } from "./provider-health.js";
import { stripeWebhook } from "./stripe.js";
import { loadFastModelChoice } from "./fast-model.js";
import { loadImageModelChoice } from "./image-model.js";
import { previewRouter } from "./routes/preview.js";
import { settingsRouter } from "./routes/settings.js";
import { setupRouter } from "./routes/setup.js";
import { jobsRouter, workspacesRouter } from "./routes/workspaces.js";
import { requireAuth, requireGithub } from "./session.js";
import { ReauthRequiredError, getAccessToken, listRepos } from "./github.js";
import { DuplicateError, MissingScopeError, duplicateRepo, isValidRepoName } from "./duplicate.js";
import { setUpNewSite } from "./new-site.js";
import { enablePages, getSiteSummary } from "./publishing.js";
import { ImportError, adoptTemplate, importCandidates, inspectRepo } from "./import-site.js";
import { DeletePermissionError, deleteSite } from "./site-delete.js";
import { WorkspaceError, assertRepoRef, sweepWorkspaces } from "./workspace.js";
import { SERVER_BUSY, SERVER_FAILED, editorCookie, isDatabaseHiccup } from "./routes/helpers.js";

// One API process only. Running AI spend (credits.js: accounts, gates), proxy tokens, jobs and their
// queue, assistant turns and the per-browser workspaces live in this process's memory and on this
// machine's disk, so a second process would let an account overspend its balance and limits and
// lose track of jobs. PM2 must run it in fork mode with one instance (ecosystem.config.cjs). To serve
// more people, give the machine more CPU and memory (MAX_RUNNING_JOBS follows the cores).
if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== "0") {
  console.error(`Refusing to start API instance ${process.env.NODE_APP_INSTANCE}: the API must run as one process (see index.js).`);
  process.exit(1);
}

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
// Default 100kb JSON bodies everywhere except image uploads, HTML pages to
// convert (with their CSS) and saved stylesheets, which parse their own.
// Stripe signs the exact bytes it sends, so its webhook takes the raw body, before JSON parsing.
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhook);
const json = express.json();
// Keeping a proposal sends the whole page back, and converted pages with their
// inline styles and scripts pass 100kb. 10mb matches Nginx's client_max_body_size.
const largeJson = express.json({ limit: "10mb" });
const LARGE_JSON_PATH = /^\/api\/workspaces\/[^/]+\/[^/]+\/proposal\/apply$/;
const UPLOAD_PATH = /^\/api\/workspaces\/[^/]+\/[^/]+\/(uploads|files|files\/page|html-source|css\/source|scripts|brand\/image|assistant\/attachments|site-zip\/chunk)$/;
app.use((req, res, next) => {
  if (UPLOAD_PATH.test(req.path)) return next();
  return (LARGE_JSON_PATH.test(req.path) ? largeJson : json)(req, res, next);
});
app.use(cookieParser());

app.get("/api/health", async (req, res) => {
  // `browser`: whether copying websites and looking at pages can run here (deploy.sh reports it).
  // `?browser=check` really starts it (cached 10 minutes): "starts", "starts without its sandbox",
  // "not installed" or "doesn't start".
  const body = { ok: true, msg: "API is running now.", browser: Boolean(findChrome()) };
  if (req.query.browser === "check") body.browserStarts = await browserStatus().catch(() => "doesn't start");
  res.json(body);
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

// Create a new site → "Use a repo I already have" (import-site.js): the owner's repos that could
// become a site, what one of them is, and making it one.
app.get("/api/import/candidates", requireAuth, requireGithub, async (req, res) => {
  try {
    const accessToken = await getAccessToken(req, res);
    const repos = importCandidates(await listRepos(accessToken));
    const copies = await withSiteRoles(repos, req.user);
    const taken = new Set(copies.filter((repo) => repo.role === "copy").map((repo) => repo.id));
    res.json({ repos: repos.filter((repo) => !taken.has(repo.id)).map(({ id, fullName, private: isPrivate, updatedAt }) => ({ id, fullName, private: isPrivate, updatedAt })) });
  } catch (err) {
    if (err instanceof ReauthRequiredError) return res.status(401).json({ error: "reauth_required" });
    console.error("Failed to list importable repositories:", err);
    res.status(502).json({ error: "github_unavailable" });
  }
});

app.post("/api/import/inspect", requireAuth, requireGithub, async (req, res) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });
  try {
    const accessToken = await getAccessToken(req, res);
    const { repo, kind, hasPackageJson } = await inspectRepo(accessToken, req.body?.repo);
    res.json({ repo: repo.fullName, kind, canAdopt: kind === "other" && !hasPackageJson });
  } catch (err) {
    if (err instanceof ReauthRequiredError) return res.status(401).json({ error: "reauth_required" });
    if (err instanceof ImportError) return res.status(err.status).json({ error: err.message });
    console.error("Failed to inspect repository:", err);
    res.status(502).json({ error: "github_unavailable" });
  }
});

app.post("/api/import", requireAuth, requireGithub, async (req, res) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });
  // Managing a site runs its scripts on this server, so importing is gated like duplicating.
  if (!hasTemplateAccess(req.user)) {
    return res.status(403).json({ error: "access_required", message: "Your account needs to be approved before you can create a site." });
  }
  const mode = req.body?.mode;
  if (mode !== "site" && mode !== "adopt") return res.status(400).json({ error: "Choose how to use the repository." });
  if (!req.githubAuth.scopes?.includes("workflow")) {
    return res.status(401).json({ error: "reauth_required", message: "This needs one more GitHub permission (workflow files). Reconnect GitHub." });
  }
  try {
    const accessToken = await getAccessToken(req, res);
    const { repo, kind } = await inspectRepo(accessToken, req.body?.repo);
    if (mode === "site" && kind !== "site") {
      return res.status(409).json({ error: "That repository isn't a Twinstack site yet. Choose to add the site tools to it." });
    }
    if (mode === "adopt" && kind === "site") {
      return res.status(409).json({ error: "That repository is already a Twinstack site. Choose to use it as it is." });
    }
    // An adopted repo that Pages already publishes stays as it is until the owner switches (keepLive).
    const { keepLive = false } = mode === "adopt" ? await adoptTemplate({ user: req.user, accessToken, fullName: repo.fullName }) : {};
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim().slice(0, 100) || null : null;
    await recordSiteCopy({ userId: req.user.id, repo, source: mode === "site" ? "import" : "adopt", displayName });
    if (!keepLive) {
      await enablePages(accessToken, repo.fullName).catch((err) =>
        console.warn(`Couldn't turn on Pages for ${repo.fullName}: ${err.message}`),
      );
    }
    // Only fills in the template's placeholder name and a missing homepage, so a site in use is left alone.
    await setUpNewSite({ accessToken, fullName: repo.fullName, displayName });
    res.status(201).json({ repo: { ...repo, role: "copy", createdByYou: true } });
  } catch (err) {
    if (err instanceof ReauthRequiredError) return res.status(401).json({ error: "reauth_required" });
    if (err instanceof ImportError) return res.status(err.status).json({ error: err.message });
    console.error("Failed to import repository:", err);
    res.status(502).json({ error: "Making that repository a site didn't work. Please try again." });
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
// Public: published sites' site agent widget posts here (site-agent.js). It answers only the
// site's published hosts, and every model request is paid from the owner's credits within limits.
app.use("/api/agent", agentPublicRouter);
app.use("/api/access", accessRouter);
app.use("/api/admin", adminRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/credits", creditsRouter);
app.use("/api/setup", setupRouter);
app.use("/api/workspaces", editorCookie, workspacesRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/preview", previewRouter);

app.use("/auth", authRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Anything a route didn't handle itself: a plain message, never Express's error page (which shows
// the error and its stack outside production). The details go to the log.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "That's too large to send. Try a smaller file." });
  if (err?.type === "entity.parse.failed" || err?.type === "encoding.unsupported") return res.status(400).json({ error: "The request couldn't be read. Reload the page and try again." });
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (isDatabaseHiccup(err)) return res.status(503).json({ error: SERVER_BUSY });
  res.status(err?.status >= 400 && err.status < 500 ? err.status : 500).json({ error: err?.status >= 400 && err.status < 500 && err.expose ? err.message : SERVER_FAILED });
});

// A background task that failed without anyone waiting for it is logged, not a crash that restarts
// the API (and fails every request in flight).
process.on("unhandledRejection", (reason) => {
  console.error("A background task failed:", reason);
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
// Per-browser copies of sites nobody has opened for a month, holding nothing unpublished, are removed.
const sweep = () => sweepWorkspaces().catch((err) => console.error("Workspace sweep failed:", err.message));
setTimeout(sweep, 10 * 60 * 1000).unref();
setInterval(sweep, 24 * 60 * 60 * 1000).unref();
if (!config.platformAnthropicKey) console.log("PLATFORM_ANTHROPIC_KEY isn't set: only accounts with their own Anthropic key can use Claude.");

app.listen(config.port, config.host, () => {
  console.log(`API listening on http://${config.host ?? "localhost"}:${config.port}`);
});
