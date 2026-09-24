import { Router } from "express";
import { COMMANDS, jobEnv } from "../commands.js";
import { config } from "../config.js";
import { MissingScopeError } from "../duplicate.js";
import { ReauthRequiredError, getAccessToken } from "../github.js";
import { cancelJob, getJob, serializeJob, startJob } from "../jobs.js";
import { requireAuth } from "../session.js";
import { getOverview, readDataFile, readSchedule, writeDataFile, writeSchedule } from "../site-files.js";
import {
  WorkspaceError,
  acquire,
  assertRepoRef,
  commitAndPush,
  discardChanges,
  getDiff,
  getStatus,
  openWorkspace,
  resetToDefault,
  workspaceDir,
  workspaceKey,
} from "../workspace.js";

/** Opening a workspace runs the repo's own code on this server, so it's opt-in per login. */
function requireAllowed(req, res, next) {
  const login = req.user.login.toLowerCase();
  const allowed = config.allowedLogins.length ? config.allowedLogins.includes(login) : !config.isProduction;
  if (allowed) return next();
  res.status(403).json({ error: "Site management isn't enabled for your account." });
}

// JSON-only: plain HTML forms from other sites can't send this content type.
function requireJson(req, res, next) {
  if ((req.method === "POST" || req.method === "PUT") && !req.is("application/json")) {
    return res.status(415).json({ error: "Expected JSON" });
  }
  next();
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ReauthRequiredError) return res.status(401).json({ error: "reauth_required" });
      if (err instanceof MissingScopeError) {
        return res.status(401).json({ error: "reauth_required", message: err.message });
      }
      if (err instanceof WorkspaceError) return res.status(err.status).json({ error: err.message });
      console.error(`${req.method} ${req.originalUrl} failed:`, err);
      res.status(500).json({ error: "Something went wrong on the server." });
    }
  };
}

function keyFor(req) {
  assertRepoRef(req.params.owner, req.params.repo);
  return workspaceKey(req.user.id, req.params.owner, req.params.repo);
}

/* ------------------------------------------------------------- workspaces */

export const workspacesRouter = Router();
workspacesRouter.use(requireAuth, requireAllowed, requireJson);

workspacesRouter.post(
  "/:owner/:repo/open",
  handle(async (req, res) => {
    const accessToken = await getAccessToken(req, res);
    res.json(await openWorkspace({ accessToken, userId: req.user.id, owner: req.params.owner, repo: req.params.repo }));
  }),
);

workspacesRouter.get(
  "/:owner/:repo",
  handle(async (req, res) => res.json(await getStatus(keyFor(req)))),
);

workspacesRouter.get(
  "/:owner/:repo/overview",
  handle(async (req, res) => res.json(await getOverview(keyFor(req)))),
);

workspacesRouter.get(
  "/:owner/:repo/diff",
  handle(async (req, res) => res.json({ files: await getDiff(keyFor(req)) })),
);

workspacesRouter.post(
  "/:owner/:repo/discard",
  handle(async (req, res) => {
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string")) {
      throw new WorkspaceError("Choose at least one file to discard.", 400);
    }
    res.json(await discardChanges(keyFor(req), paths));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/commit",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { message, mode, branch } = req.body ?? {};
    // May be empty when only retrying a push; commitAndPush requires it when there's something to commit.
    if (typeof message !== "string" || message.length > 5000) throw new WorkspaceError("Invalid commit message.", 400);
    if (mode !== "pr" && mode !== "direct") throw new WorkspaceError("Choose how to publish the changes.", 400);
    if (branch !== undefined && typeof branch !== "string") throw new WorkspaceError("Invalid branch name.", 400);
    const accessToken = await getAccessToken(req, res);
    const result = await commitAndPush({ key, accessToken, user: req.user, message: message.trim(), mode, branch });
    res.json({ ...result, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/reset",
  handle(async (req, res) => {
    const accessToken = await getAccessToken(req, res);
    res.json(await resetToDefault({ key: keyFor(req), accessToken }));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/commands/:command",
  handle(async (req, res) => {
    const key = keyFor(req);
    const name = req.params.command;
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
    if (!command) throw new WorkspaceError("Unknown command.", 404);

    const status = await getStatus(key);
    if (status.needsInstall && name !== "install") {
      throw new WorkspaceError("Install dependencies first.", 409);
    }
    const input = req.body?.input ?? {};
    const steps = command.steps(input);
    const needsKey = command.needsKey?.(input) ?? false;
    if (needsKey && !req.session.anthropicKey) {
      return res.status(400).json({
        error: "anthropic_key_required",
        message: "Add your Anthropic API key on the dashboard to run Claude commands.",
      });
    }

    const release = acquire(key, command.label);
    const job = startJob({
      key,
      userId: req.user.id,
      command: name,
      label: command.label,
      steps,
      cwd: workspaceDir(key),
      env: jobEnv(needsKey ? req.session.anthropicKey : null),
      release,
      onSuccess: command.onSuccess && (() => command.onSuccess(key)),
    });
    res.status(202).json({ job });
  }),
);

workspacesRouter.get(
  "/:owner/:repo/files/:name",
  handle(async (req, res) => res.json(await readDataFile(keyFor(req), req.params.name))),
);

workspacesRouter.put(
  "/:owner/:repo/files/:name",
  handle(async (req, res) => res.json(await writeDataFile(keyFor(req), req.params.name, req.body?.content))),
);

workspacesRouter.get(
  "/:owner/:repo/schedule",
  handle(async (req, res) => res.json(await readSchedule(keyFor(req)))),
);

workspacesRouter.put(
  "/:owner/:repo/schedule",
  handle(async (req, res) => res.json(await writeSchedule(keyFor(req), req.body?.jobs))),
);

/* ------------------------------------------------------------------- jobs */

export const jobsRouter = Router();
jobsRouter.use(requireAuth, requireJson);

jobsRouter.get(
  "/:id",
  handle(async (req, res) => {
    const job = getJob(req.params.id, req.user.id);
    if (!job) throw new WorkspaceError("Job not found. It may have expired or the server restarted.", 404);
    const since = Number(req.query.since ?? 0);
    res.json({ job: serializeJob(job, Number.isFinite(since) && since > 0 ? since : 0) });
  }),
);

jobsRouter.post(
  "/:id/cancel",
  handle(async (req, res) => {
    const job = getJob(req.params.id, req.user.id);
    if (!job) throw new WorkspaceError("Job not found.", 404);
    cancelJob(job);
    res.json({ job: serializeJob(job, Number.MAX_SAFE_INTEGER) });
  }),
);
