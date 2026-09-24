import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { GIT_TIMEOUT_MS, MissingScopeError, OWNER_PATTERN, gitEnv, isValidRepoName, summarizeGitError } from "./duplicate.js";
import { githubFetch } from "./github.js";
import { activeJobFor } from "./jobs.js";

// A workspace is a persistent clone of one site repo, per user, on this
// server. Commands run against it; nothing reaches GitHub until the user
// commits and pushes.

const execFileAsync = promisify(execFile);

// Files a repo must have for the site manager to know how to drive it.
const SITE_MARKERS = ["site.config.json", "scripts/build.js"];
const MAX_DIFF_BYTES = 100 * 1024;

/** An error whose message is safe to show to the user. */
export class WorkspaceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function assertRepoRef(owner, repo) {
  if (!OWNER_PATTERN.test(owner ?? "") || !isValidRepoName(repo)) {
    throw new WorkspaceError("Invalid repository.", 400);
  }
}

/** GitHub names are case-insensitive, so one repo always maps to one directory. */
export function workspaceKey(userId, owner, repo) {
  return `${userId}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export function workspaceDir(key) {
  return path.join(config.workspacesDir, ...key.split("/"));
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

async function git(dir, args, { accessToken, maxBuffer = 10 * 1024 * 1024 } = {}) {
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

async function tryGit(dir, args) {
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

async function readMeta(dir) {
  try {
    return JSON.parse(await fs.readFile(metaPath(dir), "utf8"));
  } catch {
    throw new WorkspaceError("This site hasn't been opened yet.", 404);
  }
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
export async function openWorkspace({ accessToken, userId, owner, repo }) {
  assertRepoRef(owner, repo);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await githubFetch(repoPath, accessToken);
  if (res.status === 404) throw new WorkspaceError("Repository not found.", 404);
  if (!res.ok) throw new Error(`GitHub GET repo failed with ${res.status}`);
  const info = await res.json();
  if (!info.permissions?.push) {
    throw new WorkspaceError("You need write access to this repository to manage it.", 403);
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

  const key = workspaceKey(userId, info.owner.login, info.name);

  // Opens that overlap (a second tab, or React running the effect twice in
  // development) share one sync and all get its result, instead of the later
  // ones returning a stale "busy" status or failing on the lock.
  if (!syncs.has(key)) {
    syncs.set(key, syncWorkspace(key, info, accessToken).finally(() => syncs.delete(key)));
  }
  await syncs.get(key);
  return getStatus(key);
}

const syncs = new Map();

async function syncWorkspace(key, info, accessToken) {
  const dir = workspaceDir(key);
  const cloned = existsSync(path.join(dir, ".git"));

  // A running command owns the working copy; show its state instead of fetching under it.
  if (cloned && busy.has(key)) return;

  const release = acquire(key, "syncing with GitHub");
  try {
    if (cloned) {
      await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
    } else {
      // Full history, not shallow: the changelog commands read `git log`.
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await git(path.dirname(dir), ["clone", "--quiet", info.clone_url, dir], { accessToken });
    }
    await fs.writeFile(
      metaPath(dir),
      JSON.stringify({
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

async function listChanges(dir) {
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

export function previewPath(key) {
  const signature = createHmac("sha256", config.sessionKey).update(`preview:${key}`).digest("base64url").slice(0, 32);
  return `/api/preview/${key}/${signature}/`;
}

export function verifyPreviewSignature(key, signature) {
  const expected = Buffer.from(previewPath(key).split("/").at(-2));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && timingSafeEqual(expected, given);
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
    previewUrl: existsSync(path.join(dir, "dist")) ? previewPath(key) : null,
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
    await git(dir, ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${target}`], { accessToken });

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
