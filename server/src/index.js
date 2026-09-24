import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { previewRouter } from "./routes/preview.js";
import { settingsRouter } from "./routes/settings.js";
import { jobsRouter, workspacesRouter } from "./routes/workspaces.js";
import { requireAuth } from "./session.js";
import { ReauthRequiredError, getAccessToken, listRepos } from "./github.js";
import { DuplicateError, MissingScopeError, duplicateRepo, isValidRepoName } from "./duplicate.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/repos", requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken(req, res);
    res.json({ repos: await listRepos(accessToken) });
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return res.status(401).json({ error: "reauth_required" });
    }
    console.error("Failed to list repositories:", err);
    res.status(502).json({ error: "github_unavailable" });
  }
});

app.post("/api/repos/:owner/:repo/duplicate", requireAuth, async (req, res) => {
  // JSON-only: plain HTML forms from other sites can't send this content type.
  if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });

  const { name, private: isPrivate = true } = req.body ?? {};
  if (!isValidRepoName(name)) {
    return res.status(400).json({ error: "Use 1-100 letters, numbers, '.', '-' or '_' for the name." });
  }

  // Sessions from before `workflow` was requested can't push repos containing Actions workflows.
  if (!req.session.github.scopes?.includes("workflow")) {
    return res.status(401).json({
      error: "reauth_required",
      message: "Duplicating needs one more GitHub permission (workflow files).",
    });
  }

  try {
    const accessToken = await getAccessToken(req, res);
    const repo = await duplicateRepo({
      accessToken,
      userLogin: req.user.login,
      owner: req.params.owner,
      repo: req.params.repo,
      newName: name,
      isPrivate: Boolean(isPrivate),
    });
    res.status(201).json({ repo });
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

app.use("/api/settings", settingsRouter);
app.use("/api/workspaces", workspacesRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/preview", previewRouter);

app.use("/auth", authRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
