import { MissingScopeError } from "../duplicate.js";
import { ReauthRequiredError } from "../github.js";
import { isTemplate } from "../sites.js";
import { randomBytes } from "node:crypto";
import { cookieOptions } from "../session.js";
import { EDITOR_ID, WorkspaceError, assertRepoRef, workspaceKey } from "../workspace.js";

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
      if (err instanceof WorkspaceError) {
        return res.status(err.status).json(err.code ? { error: err.code, message: err.message } : { error: err.message });
      }
      console.error(`${req.method} ${req.originalUrl} failed:`, err);
      res.status(500).json({ error: "Something went wrong on the server." });
    }
  };
}

export function keyFor(req) {
  assertRepoRef(req.params.owner, req.params.repo);
  // Also blocks a workspace for the template that was opened before this rule existed.
  if (isTemplate(`${req.params.owner}/${req.params.repo}`)) throw templateError();
  return workspaceKey(req.user.id, req.params.owner, req.params.repo, req.editorId);
}

// The browser's editor id (workspace.js): every browser gets its own copy of each site it opens, so
// people sharing an account don't see, or publish, each other's unfinished work. Kept for 400 days
// (the most browsers allow) and renewed on every use; an id is random and means nothing on its own,
// since every request still needs the account's session.
const EDITOR_COOKIE = "twinstack_editor";
const EDITOR_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export function editorCookie(req, res, next) {
  let id = req.cookies?.[EDITOR_COOKIE];
  if (typeof id !== "string" || !EDITOR_ID.test(id)) id = randomBytes(8).toString("hex");
  req.editorId = id;
  res.cookie(EDITOR_COOKIE, id, cookieOptions(EDITOR_MAX_AGE_SECONDS));
  next();
}

export const templateError = () =>
  new WorkspaceError("This is the site template. Duplicate it, then manage your copy.", 403);
