import { MissingScopeError } from "../duplicate.js";
import { ReauthRequiredError } from "../github.js";
import { isTemplate } from "../sites.js";
import { WorkspaceError, assertRepoRef, workspaceKey } from "../workspace.js";

// Shared by the workspace routes and the assistant's.

// JSON-only: plain HTML forms from other sites can't send this content type.
export function requireJson(req, res, next) {
  if ((req.method === "POST" || req.method === "PUT") && !req.is("application/json")) {
    return res.status(415).json({ error: "Expected JSON" });
  }
  next();
}

export function handle(fn) {
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

export function keyFor(req) {
  assertRepoRef(req.params.owner, req.params.repo);
  // Also blocks a workspace for the template that was opened before this rule existed.
  if (isTemplate(`${req.params.owner}/${req.params.repo}`)) throw templateError();
  return workspaceKey(req.user.id, req.params.owner, req.params.repo);
}

export const templateError = () =>
  new WorkspaceError("This is the site template. Duplicate it, then manage your copy.", 403);
