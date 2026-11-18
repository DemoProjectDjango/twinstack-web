import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { GIT_TIMEOUT_MS, MissingScopeError, OWNER_PATTERN, gitEnv, isValidRepoName, summarizeGitError } from "./duplicate.js";
import { githubFetch } from "./github.js";
import { activeJobFor } from "./jobs.js";
import { claimLegacyConversations } from "./db.js";
import { isSiteCopy, isTemplate } from "./sites.js";

// A workspace is a persistent clone of one site repo, per user, on this
// server. Commands run against it; nothing reaches GitHub until the user
// commits and pushes.

const execFileAsync = promisify(execFile);

// Files a repo must have for the site manager to know how to drive it.
const SITE_MARKERS = ["site.config.json", "scripts/build.js"];
const MAX_DIFF_BYTES = 100 * 1024;

/** git merge-file on three versions: `{ text, conflicts }`, with conflict markers when there are any. */
export async function mergeFile(ours, base, theirs, labels = ["your site", "before", "the update"], markerSize = 7) {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), "twinstack-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => path.join(tmp, n));
    await Promise.all([fs.writeFile(o, ours), fs.writeFile(b, base), fs.writeFile(t, theirs)]);
    const args = ["merge-file", "-p", `--marker-size=${markerSize}`, "-L", labels[0], "-L", labels[1], "-L", labels[2], o, b, t];
    try {
      const { stdout } = await execFileAsync("git", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      return { text: stdout, conflicts: 0 };
    } catch (err) {
      // The exit code is the number of conflicts.
      if (typeof err.code === "number" && err.code > 0 && err.stdout) return { text: err.stdout, conflicts: err.code };
      throw err;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** An error whose message is safe to show to the user. */
export class WorkspaceError extends Error {
  /** `code` (lower_snake_case) lets the browser tell this refusal apart (sent as `error`, with `message`). */
  constructor(message, status = 400, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function assertRepoRef(owner, repo) {
  if (!OWNER_PATTERN.test(owner ?? "") || !isValidRepoName(repo)) {
    throw new WorkspaceError("Invalid repository.", 400);
  }
}

// Each browser (an "editor": the `twinstack_editor` cookie, 16 hex characters) has its own copy of a
// site, so people sharing one account keep their unpublished work to themselves until they publish.
// Its folder is `<userId>.<editor>/<owner>/<repo>`. Copies were one per account before
// (`<userId>/<owner>/<repo>`): the first browser to open the site takes that one over
// (`claimLegacy`), with its unpublished work and AI conversation.
export const EDITOR_ID = /^[0-9a-f]{16}$/;
const ACCOUNT_DIR = /^[0-9a-f]{24}(?:\.[0-9a-f]{16})?$/;

/** GitHub names are case-insensitive, so one repo always maps to one directory. */
export function workspaceKey(userId, owner, repo, editor = null) {
  if (editor !== null && !EDITOR_ID.test(editor)) throw new WorkspaceError("Reload the page and try again.", 400);
  return `${editor ? `${userId}.${editor}` : userId}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** Whether `segment` can be a key's first part: an account id, with a browser's editor id for per-browser copies. */
export const isAccountSegment = (segment) => ACCOUNT_DIR.test(segment);

/** The browser's editor id in a key, or null for an account's copy from before. */
export const editorOfKey = (key) => key.split("/")[0].split(".")[1] ?? null;

export function workspaceDir(key) {
  return path.join(config.workspacesDir, ...key.split("/"));
}

/** The keys of every clone of this repo: every account's and every browser's. */
export async function workspaceKeysFor(owner, repo) {
  const segments = (await fs.readdir(config.workspacesDir).catch(() => [])).filter(isAccountSegment);
  return segments.map((segment) => `${segment}/${owner.toLowerCase()}/${repo.toLowerCase()}`).filter((key) => existsSync(workspaceDir(key)));
}

/** Deletes a clone from this server. Hold its lock (`acquire`) while doing so. */
export async function removeWorkspace(key) {
  await fs.rm(workspaceDir(key), { recursive: true, force: true, maxRetries: 3 });
}

/* ------------------------------------------------------------------ locks */

// One operation per workspace at a time: two processes writing the same
// files (or git racing a build) would corrupt the working copy.
const busy = new Map();

/** Marks the workspace busy with `label`; returns the release function. */
export function acquire(key, label) {
  if (busy.has(key)) {
    throw new WorkspaceError(`The workspace is busy (${busy.get(key)}). Wait for it to finish.`, 409);
  }
  busy.set(key, label);
  return () => busy.delete(key);
}

/* -------------------------------------------------------------------- git */

export async function git(dir, args, { accessToken, maxBuffer = 10 * 1024 * 1024 } = {}) {
  const env = accessToken ? gitEnv(accessToken) : { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: dir, env, timeout: GIT_TIMEOUT_MS, maxBuffer });
    return stdout;
  } catch (err) {
    const stderr = String(err.stderr ?? "");
    if (/without `?workflow`? scope/i.test(stderr)) {
      throw new MissingScopeError("Pushing workflow files needs the `workflow` permission.");
    }
    const detail = err.killed ? "timed out" : summarizeGitError(stderr || err.message);
    // Name the subcommand, skipping `-c key=value` options before it.
    const subcommand = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
    throw new WorkspaceError(`git ${subcommand} failed: ${detail}`, 502);
  }
}

export async function tryGit(dir, args) {
  try {
    return await git(dir, args);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- meta */

// Kept inside .git so it never shows up as a change in the site repo.
const metaPath = (dir) => path.join(dir, ".git", "twinstack.json");
const installStampPath = (dir) => path.join(dir, ".git", "twinstack-install");
// When the copy was last opened, for removing copies nobody uses (sweepWorkspaces).
const openedStampPath = (dir) => path.join(dir, ".git", "twinstack-opened");

export async function readMeta(dir) {
  try {
    return JSON.parse(await fs.readFile(metaPath(dir), "utf8"));
  } catch {
    throw new WorkspaceError("This site hasn't been opened yet.", 404);
  }
}

/** The GitHub repo id of the site in this workspace: the same for every user who manages it. */
export async function siteIdFor(key) {
  const meta = await readMeta(workspaceDir(key));
  // Metadata written before the id was recorded; opening the site again adds it.
  return meta.id ?? meta.fullName.toLowerCase();
}

async function lockfileHash(dir) {
  try {
    return createHash("sha256").update(await fs.readFile(path.join(dir, "package-lock.json"))).digest("hex");
  } catch {
    return "no-lockfile";
  }
}

/** Called after a successful `npm ci` so the next open knows it's current. */
export async function markInstalled(key) {
  const dir = workspaceDir(key);
  await fs.writeFile(installStampPath(dir), await lockfileHash(dir));
}

// What the preview (dist/) was last built from: the working tree's fingerprint after a `preview`
// build. Without it, reopening the editor showed the build from before the latest changes (a
// rebuild cancelled or never started before the page was left), which looked like lost work.
const previewStampPath = (dir) => path.join(dir, ".git", "twinstack-preview-built");

/** Before a build over dist/: until it finishes, the preview counts as out of date. */
export async function clearPreviewStamp(key) {
  await fs.rm(previewStampPath(workspaceDir(key)), { force: true });
}

/** After a successful preview build. */
export async function markPreviewBuilt(key) {
  await fs.writeFile(previewStampPath(workspaceDir(key)), await workingTreeFingerprint(key));
}

/** Whether dist/ is the preview build of the files as they are now. */
export async function previewIsFresh(key) {
  const stamp = await fs.readFile(previewStampPath(workspaceDir(key)), "utf8").catch(() => null);
  return stamp !== null && stamp === (await workingTreeFingerprint(key));
}

async function needsInstall(dir) {
  if (!existsSync(path.join(dir, "node_modules"))) return true;
  const stamp = await fs.readFile(installStampPath(dir), "utf8").catch(() => null);
  return stamp !== (await lockfileHash(dir));
}

/* ------------------------------------------------------------------- open */

/**
 * Clones the repo on first open and fetches on later ones. Local uncommitted
 * work is never touched, so reopening a site picks up where the user left off.
 */
export async function openWorkspace({ accessToken, userId, owner, repo, editor = null }) {
  assertRepoRef(owner, repo);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await githubFetch(repoPath, accessToken);
  if (res.status === 404) throw new WorkspaceError("Repository not found.", 404);
  if (!res.ok) throw new Error(`GitHub GET repo failed with ${res.status}`);
  const info = await res.json();
  if (!info.permissions?.push) {
    throw new WorkspaceError("You need write access to this repository to manage it.", 403);
  }
  // Checked on GitHub's canonical name too, in case the URL used an old name that redirects.
  const repoRef = { id: info.id, fullName: info.full_name, name: info.name };
  if (isTemplate(repoRef.fullName)) {
    throw new WorkspaceError("This is the site template. Duplicate it, then manage your copy.", 403);
  }
  if (!(await isSiteCopy(repoRef))) {
    throw new WorkspaceError(`Only sites duplicated from ${config.siteTemplate} in this app can be managed here.`, 403);
  }

  for (const file of SITE_MARKERS) {
    const marker = await githubFetch(
      `${repoPath}/contents/${file}?ref=${encodeURIComponent(info.default_branch)}`,
      accessToken,
    );
    if (marker.status === 404) {
      throw new WorkspaceError(`This isn't a TwinStack site repository (no ${file} on ${info.default_branch}).`, 422);
    }
  }

  const key = workspaceKey(userId, info.owner.login, info.name, editor);
  if (editor) await claimLegacy(key, workspaceKey(userId, info.owner.login, info.name), info.id, userId);

  // Opens that overlap (a second tab, or React running the effect twice in
  // development) share one sync and all get its result, instead of the later
  // ones returning a stale "busy" status or failing on the lock.
  if (!syncs.has(key)) {
    syncs.set(key, syncWorkspace(key, info, accessToken).finally(() => syncs.delete(key)));
  }
  await syncs.get(key);
  await fs.writeFile(openedStampPath(workspaceDir(key)), new Date().toISOString()).catch(() => {});
  const status = await getStatus(key);
  // Only on open, since it stats every changed file: the editor rebuilds a preview that's out of date.
  return { ...status, previewFresh: status.build !== "none" && !status.activeJob && (await previewIsFresh(key)) };
}

const syncs = new Map();
const claims = new Map();

/**
 * The account's copy from before copies were per browser becomes this browser's (the first to open
 * the site since), with its unpublished work and AI conversation. Later browsers start from the
 * published site. A busy copy is left for a later open.
 */
async function claimLegacy(key, legacyKey, siteId, userId) {
  if (claims.has(legacyKey)) return claims.get(legacyKey);
  const dir = workspaceDir(key);
  const legacy = workspaceDir(legacyKey);
  if (existsSync(dir) || !existsSync(path.join(legacy, ".git")) || busy.has(legacyKey) || activeJobFor(legacyKey)) return;
  const claim = (async () => {
    let release;
    try {
      // Taken by a command in the meantime: left for a later open (this browser starts afresh only if
      // it has no copy yet, so nothing is lost either way).
      release = acquire(legacyKey, "moving to this browser");
    } catch {
      return;
    }
    try {
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.rename(legacy, dir);
      await claimLegacyConversations(userId, siteId, editorOfKey(key)).catch((err) => console.error(`Couldn't move the AI conversations of ${legacyKey}:`, err.message));
      console.log(`Workspace ${legacyKey} now belongs to ${key}.`);
    } catch (err) {
      console.error(`Couldn't move workspace ${legacyKey} to ${key}:`, err.message);
    } finally {
      release();
    }
  })().finally(() => claims.delete(legacyKey));
  claims.set(legacyKey, claim);
  return claim;
}

/**
 * A new clone takes the installed packages of another copy of the same site with the same lockfile
 * (hard links where the system has them, so they cost no space) instead of a long `npm ci`.
 */
async function shareInstalledPackages(key, dir) {
  try {
    const [, owner, repo] = key.split("/");
    const wanted = await lockfileHash(dir);
    for (const other of await workspaceKeysFor(owner, repo)) {
      if (other === key || busy.has(other)) continue;
      const source = workspaceDir(other);
      if (!existsSync(path.join(source, "node_modules")) || (await needsInstall(source)) || (await lockfileHash(source)) !== wanted) continue;
      try {
        if (process.platform === "win32") throw new Error("no cp -al");
        await execFileAsync("cp", ["-al", path.join(source, "node_modules"), path.join(dir, "node_modules")], { timeout: 5 * 60 * 1000 });
      } catch {
        await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true });
        await fs.cp(path.join(source, "node_modules"), path.join(dir, "node_modules"), { recursive: true, verbatimSymlinks: true });
      }
      await fs.writeFile(installStampPath(dir), wanted);
      return;
    }
  } catch (err) {
    console.error(`Couldn't share installed packages with ${key}:`, err.message);
    await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true }).catch(() => {});
  }
}

const UNUSED_DAYS = 30;

/**
 * Removes per-browser copies nobody has opened for UNUSED_DAYS, only when they hold nothing
 * unpublished: a copy with changes or unpushed commits is kept however old it is.
 */
export async function sweepWorkspaces() {
  const cutoff = Date.now() - UNUSED_DAYS * 24 * 60 * 60 * 1000;
  for (const segment of await fs.readdir(config.workspacesDir).catch(() => [])) {
    if (!isAccountSegment(segment) || !segment.includes(".")) continue;
    for (const owner of await fs.readdir(path.join(config.workspacesDir, segment)).catch(() => [])) {
      for (const repo of await fs.readdir(path.join(config.workspacesDir, segment, owner)).catch(() => [])) {
        const key = `${segment}/${owner}/${repo}`;
        const dir = workspaceDir(key);
        try {
          const stamp = Date.parse(await fs.readFile(openedStampPath(dir), "utf8").catch(() => ""));
          const opened = Number.isNaN(stamp) ? (await fs.stat(dir)).mtimeMs : stamp;
          if (opened > cutoff || busy.has(key) || activeJobFor(key)) continue;
          if ((await listChanges(dir)).length) continue;
          const unpushed = await tryGit(dir, ["rev-list", "--count", "@{upstream}..HEAD"]);
          if (unpushed === null || unpushed.trim() !== "0") continue;
          const release = acquire(key, "removing an unused copy");
          try {
            await removeWorkspace(key);
          } finally {
            release();
          }
          console.log(`Removed ${key}: unused for ${UNUSED_DAYS} days, with nothing unpublished.`);
        } catch (err) {
          console.error(`Couldn't check unused workspace ${key}:`, err.message);
        }
      }
    }
  }
}

async function syncWorkspace(key, info, accessToken) {
  const dir = workspaceDir(key);
  let cloned = existsSync(path.join(dir, ".git"));

  // A running command owns the working copy; show its state instead of fetching under it.
  if (cloned && busy.has(key)) return;

  // The folder is named after the repo, but a repo deleted on GitHub and made again under the same
  // name is a different repo (a new id): its folder holds the deleted site's history and unpublished
  // changes, so it's cloned again instead. Folders from before the id was recorded are kept.
  if (cloned) {
    const previousId = await readMeta(dir).then((meta) => meta.id, () => undefined);
    if (previousId !== undefined && previousId !== info.id) {
      console.log(`Workspace ${key} was for a deleted repo (${previousId}); cloning ${info.full_name} (${info.id}) afresh.`);
      cloned = false;
    }
  }

  const release = acquire(key, "syncing with GitHub");
  try {
    if (cloned) {
      await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
    } else {
      // Full history, not shallow: the changelog commands read `git log`.
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await git(path.dirname(dir), ["clone", "--quiet", info.clone_url, dir], { accessToken });
      await shareInstalledPackages(key, dir);
    }
    await fs.writeFile(
      metaPath(dir),
      JSON.stringify({
        id: info.id,
        owner: info.owner.login,
        name: info.name,
        fullName: info.full_name,
        htmlUrl: info.html_url,
        defaultBranch: info.default_branch,
        private: info.private,
      }),
    );
  } finally {
    release();
  }
}

/* ----------------------------------------------------------------- status */

export async function listChanges(dir) {
  const out = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = out.split("\0");
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    // Renames and copies are followed by their original path as a separate entry.
    if (xy[0] === "R" || xy[0] === "C") i++;
    const status =
      xy === "??" ? "added" : xy.includes("D") ? "deleted" : xy.includes("R") ? "renamed" : xy.includes("A") ? "added" : "modified";
    changes.push({ path: file, status, untracked: xy === "??" });
  }
  return changes;
}

/**
 * Changes whenever a file the site is built from does: the commit, plus each changed file's size
 * and time. Builds write only ignored files (dist/), so building leaves it as it was.
 */
export async function workingTreeFingerprint(key) {
  const dir = workspaceDir(key);
  const [head, changes] = await Promise.all([tryGit(dir, ["rev-parse", "HEAD"]), listChanges(dir)]);
  const hash = createHash("sha256").update(head ?? "");
  for (const change of changes) {
    const stat = await fs.stat(path.join(dir, change.path)).catch(() => null);
    hash.update(`\0${change.path}\0${stat ? `${stat.size}:${stat.mtimeMs}` : "gone"}`);
  }
  return hash.digest("hex").slice(0, 16);
}

// What a signed preview URL serves: "site" is the last build (dist/), "proposal" the site built
// with the pending Claude proposal applied (the proposal-preview command in commands.js).
export const PREVIEW_ROOTS = { site: "dist", proposal: ".git/twinstack-proposal-site" };

export function previewPath(key, kind = "site") {
  // The site's signature is unchanged from before there were two kinds, so its URLs keep working.
  const scope = kind === "site" ? `preview:${key}` : `preview-${kind}:${key}`;
  const signature = createHmac("sha256", config.sessionKey).update(scope).digest("base64url").slice(0, 32);
  return `/api/preview/${key}/${signature}/`;
}

/** The kind of preview the signature is for ("site" or "proposal"), or null. */
export function verifyPreviewSignature(key, signature) {
  const given = Buffer.from(String(signature));
  for (const kind of Object.keys(PREVIEW_ROOTS)) {
    const expected = Buffer.from(previewPath(key, kind).split("/").at(-2));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return kind;
  }
  return null;
}

export async function getStatus(key) {
  const dir = workspaceDir(key);
  const meta = await readMeta(dir);
  const [branch, counts, changes, install] = await Promise.all([
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()),
    tryGit(dir, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    listChanges(dir),
    needsInstall(dir),
  ]);
  const [ahead, behind] = counts ? counts.trim().split(/\s+/).map(Number) : [null, null];
  return {
    ...meta,
    branch,
    onDefaultBranch: branch === meta.defaultBranch,
    ahead,
    behind,
    changes,
    needsInstall: install,
    busy: busy.get(key) ?? null,
    activeJob: activeJobFor(key),
    // "empty": built, but no homepage (the site has no pages yet), so there's nothing to show.
    build: existsSync(path.join(dir, "dist", "index.html")) ? "ready" : existsSync(path.join(dir, "dist")) ? "empty" : "none",
    previewUrl: existsSync(path.join(dir, "dist", "index.html")) ? previewPath(key) : null,
    // When the preview was last built: the editor's frame reloads only when this changes, not after
    // every command (a frame reloading under the AI's ongoing work kept "See it" from settling).
    builtAt: await fs.stat(path.join(dir, "dist", "index.html")).then((s) => Math.round(s.mtimeMs), () => null),
  };
}

/* ------------------------------------------------------------ diff/discard */

/** Resolves a repo-relative path, refusing anything that escapes the working copy. */
function insideDir(dir, relative) {
  const full = path.resolve(dir, relative);
  if (full !== dir && !full.startsWith(dir + path.sep)) throw new WorkspaceError("Invalid path.", 400);
  return full;
}

function truncate(text) {
  return text.length > MAX_DIFF_BYTES ? `${text.slice(0, MAX_DIFF_BYTES)}\n… diff truncated` : text;
}

export async function getDiff(key) {
  const dir = workspaceDir(key);
  const changes = await listChanges(dir);
  return Promise.all(
    changes.map(async (change) => {
      if (!change.untracked) {
        const diff = await git(dir, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", change.path]);
        return { ...change, diff: truncate(diff) };
      }
      // Untracked files have nothing to diff against; show them as all-added.
      const buffer = await fs.readFile(insideDir(dir, change.path));
      const diff = buffer.includes(0)
        ? "Binary file"
        : buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n").map((line) => `+${line}`).join("\n");
      return { ...change, diff: truncate(diff) };
    }),
  );
}

export async function discardChanges(key, paths) {
  const release = acquire(key, "discarding changes");
  try {
    const dir = workspaceDir(key);
    const byPath = new Map((await listChanges(dir)).map((c) => [c.path, c]));
    const selected = paths.map((p) => {
      const change = byPath.get(p);
      if (!change) throw new WorkspaceError(`No change to discard at ${p}.`, 400);
      return change;
    });
    const tracked = selected.filter((c) => !c.untracked).map((c) => c.path);
    if (tracked.length) await git(dir, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
    for (const change of selected.filter((c) => c.untracked)) {
      await fs.rm(insideDir(dir, change.path), { force: true });
    }
  } finally {
    release();
  }
  return getStatus(key);
}

/* ------------------------------------------------------------ commit/push */

function defaultWorkBranch() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `twinstack/${stamp}`;
}

async function ensurePullRequest(meta, branch, title, accessToken) {
  const pullsPath = `/repos/${meta.fullName}/pulls`;
  const res = await githubFetch(pullsPath, accessToken, {
    method: "POST",
    body: { title, head: branch, base: meta.defaultBranch, body: "Opened from the TwinStack site manager." },
  });
  if (res.ok) {
    const pr = await res.json();
    return { number: pr.number, url: pr.html_url };
  }
  if (res.status === 422) {
    // Already open for this branch: the push above updated it.
    const params = new URLSearchParams({ head: `${meta.owner}:${branch}`, base: meta.defaultBranch, state: "open" });
    const existing = await githubFetch(`${pullsPath}?${params}`, accessToken);
    const [pr] = existing.ok ? await existing.json() : [];
    if (pr) return { number: pr.number, url: pr.html_url };
  }
  throw new WorkspaceError(`Pushed ${branch}, but GitHub refused to open a pull request (${res.status}).`, 502);
}

/**
 * Commits every change and pushes. In "pr" mode work happens on a separate
 * branch with a pull request into the default branch; further commits on that
 * branch update the same pull request. In "direct" mode the current branch is
 * pushed as-is.
 */
// A big push (a whole imported site) over HTTPS can fail with "RPC failed" at git's default buffer.
const PUSH_ARGS = ["-c", "http.postBuffer=524288000", "push", "--quiet", "-u", "origin"];
const BEHIND = /\[rejected\]|non-fast-forward|fetch first|failed to push some refs|Updates were rejected/i;

/**
 * Pushes HEAD to `target`. When GitHub has commits the editor's copy doesn't (made on GitHub, by
 * someone else, or by the app through GitHub's API), the push is refused: the copy then catches up
 * by putting its own new commits after GitHub's, and pushes again. Publishing used to fail with a
 * bare 502 there. Changes that clash with GitHub's are left as they were, with a plain explanation.
 */
async function pushCatchingUp(dir, target, accessToken) {
  try {
    await git(dir, [...PUSH_ARGS, `HEAD:refs/heads/${target}`], { accessToken });
    return;
  } catch (err) {
    if (!(err instanceof WorkspaceError) || !BEHIND.test(err.message)) throw err;
  }
  await git(dir, ["fetch", "--quiet", "origin", target], { accessToken });
  const user = ["-c", "user.name=Twinstack", "-c", "user.email=noreply@twinstack.net"];
  // Keeps the committers of the commits being moved; the names above are only git's requirement.
  if ((await tryGit(dir, [...user, "rebase", "--quiet", "--committer-date-is-author-date", `origin/${target}`])) === null) {
    await tryGit(dir, ["rebase", "--abort"]);
    // The work goes back to being unpublished changes on top of where it started, so the editor's
    // Publish can show both versions and let the owner settle them (publish-sync.js).
    const base = (await git(dir, ["merge-base", "HEAD", `origin/${target}`])).trim();
    await git(dir, ["reset", "--quiet", "--mixed", base]);
    throw new WorkspaceError(
      "Someone else published changes to the same parts of your site while you were working. Press Publish again to look at both versions and choose what to keep.",
      409,
      "publish_clash",
    );
  }
  await git(dir, [...PUSH_ARGS, `HEAD:refs/heads/${target}`], { accessToken });
}

export async function commitAndPush({ key, accessToken, user, message, mode, branch }) {
  const release = acquire(key, "committing and pushing");
  try {
    const dir = workspaceDir(key);
    const meta = await readMeta(dir);
    const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const changes = await listChanges(dir);
    if (changes.length && !message) throw new WorkspaceError("Write a commit message.", 400);
    let target = current;

    if (mode === "pr" && current === meta.defaultBranch) {
      if (!changes.length) throw new WorkspaceError("There are no changes to commit.", 400);
      target = branch?.trim() || defaultWorkBranch();
      if (target === meta.defaultBranch) {
        throw new WorkspaceError("Pick a branch name other than the default branch.", 400);
      }
      if ((await tryGit(dir, ["check-ref-format", "--branch", target])) === null) {
        throw new WorkspaceError(`"${target}" isn't a valid branch name.`, 400);
      }
      await git(dir, ["switch", "--quiet", "-c", target]);
    }

    if (changes.length) {
      const email = user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
      await git(dir, ["add", "--all"]);
      await git(dir, ["-c", `user.name=${user.name || user.login}`, "-c", `user.email=${email}`, "commit", "--quiet", "-m", message]);
    }
    // With nothing new to commit this retries a push that failed earlier.
    await pushCatchingUp(dir, target, accessToken);

    const commit = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const pullRequest =
      mode === "pr" && target !== meta.defaultBranch
        ? await ensurePullRequest(meta, target, message.split("\n")[0] || target, accessToken)
        : null;
    return { branch: target, commit, pullRequest };
  } finally {
    release();
  }
}

/** Starts a fresh change: checks out the latest default branch from GitHub. */
export async function resetToDefault({ key, accessToken }) {
  const release = acquire(key, "switching branch");
  try {
    const dir = workspaceDir(key);
    const meta = await readMeta(dir);
    if ((await listChanges(dir)).length) {
      throw new WorkspaceError("Commit or discard your changes first.", 409);
    }
    await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
    await git(dir, ["checkout", "--quiet", "-B", meta.defaultBranch, `origin/${meta.defaultBranch}`]);
  } finally {
    release();
  }
  return getStatus(key);
}
