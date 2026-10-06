import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { PREVIEW_ROOTS, WorkspaceError, assertRepoRef, previewPath, verifyPreviewSignature, workspaceDir } from "../workspace.js";

// Serves a workspace's built dist/ (or the site built with a pending Claude proposal) for the preview iframe. The signed URL is
// the credential (no cookie), because the iframe is sandboxed into an opaque
// origin: the site's scripts then can't call this app's API as the user.

export const previewRouter = Router();

const HEADERS = {
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/** The built site links from its domain root; point those links into the preview instead. */
function rebase(text, prefix) {
  return text
    .replace(/(\s(?:href|src|action|poster)=["'])\/(?!\/)/g, `$1${prefix}/`)
    .replace(/(\ssrcset=["'])\/(?!\/)/g, `$1${prefix}/`)
    .replace(/url\((["']?)\/(?!\/)/g, `url($1${prefix}/`);
}

function resolveFile(dist, relative) {
  const candidates = [relative, `${relative}.html`, path.join(relative, "index.html")];
  for (const candidate of candidates) {
    const full = path.resolve(dist, candidate);
    if (full !== dist && !full.startsWith(dist + path.sep)) return null;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

previewRouter.get("/:userId/:owner/:repo/:signature{/*path}", async (req, res) => {
  const { userId, owner, repo, signature } = req.params;
  try {
    // Account ids are MongoDB ObjectIds (24 hex characters).
    if (!/^[0-9a-f]{24}$/.test(userId)) throw new WorkspaceError("Not found", 404);
    assertRepoRef(owner, repo);
  } catch {
    return res.status(404).send("Not found");
  }
  const key = `${userId}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const kind = verifyPreviewSignature(key, signature);
  if (!kind) return res.status(404).send("Not found");

  const dist = path.join(workspaceDir(key), PREVIEW_ROOTS[kind]);
  const segments = req.params.path ?? [];
  // Never dot-files: a proposal build keeps its working files (.proposal-sources/…) beside the site.
  if (segments.some((segment) => segment.startsWith("."))) return res.status(404).set(HEADERS).type("text/plain").send("Not found");
  const relative = segments.length && !req.path.endsWith("/") ? segments.join("/") : path.join(...segments, "index.html");
  const file = resolveFile(dist, relative);
  res.set(HEADERS);
  if (!file) return res.status(404).type("text/plain").send("Not in the built site. Build the preview again?");

  const extension = path.extname(file).toLowerCase();
  if (extension === ".html" || extension === ".css") {
    const prefix = previewPath(key, kind).slice(0, -1);
    return res.type(extension).send(rebase(await fs.readFile(file, "utf8"), prefix));
  }
  res.sendFile(file, { dotfiles: "deny" });
});
