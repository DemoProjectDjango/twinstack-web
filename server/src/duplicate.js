import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { githubFetch } from "./github.js";

const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 8 * 60 * 1000;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
export const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

/** An error whose message is safe to show to the user. */
/** The token lacks a scope the operation needs; the user must sign in again to grant it. */
export class MissingScopeError extends Error {}

export class DuplicateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function isValidRepoName(name) {
  return typeof name === "string" && REPO_NAME_PATTERN.test(name) && name !== "." && name !== "..";
}

async function githubJson(pathname, accessToken, init) {
  const res = await githubFetch(pathname, accessToken, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { res, body };
}

// The token is passed to git through environment config (never argv or a
// remote URL) so it doesn't show up in process listings or .git/config.
export function gitEnv(accessToken) {
  const basic = Buffer.from(`x-access-token:${accessToken}`).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    // An empty helper clears any configured ones (e.g. Git Credential Manager on
    // Windows), so a rejected token fails fast instead of waiting on a hidden
    // sign-in prompt until the timeout.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
}

async function git(args, { cwd, env }) {
  try {
    await execFileAsync("git", args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const stderr = String(err.stderr ?? "");
    if (/without `?workflow`? scope/i.test(stderr)) {
      throw new MissingScopeError("Pushing workflow files needs the `workflow` permission.");
    }
    const detail = err.killed ? "timed out" : summarizeGitError(stderr || err.message);
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

/**
 * Creates `newName` in the user's account and pushes every branch and tag
 * (full history) of `owner/repo` into it.
 */
export async function duplicateRepo({ accessToken, userLogin, owner, repo, newName, isPrivate }) {
  if (!OWNER_PATTERN.test(owner) || !isValidRepoName(repo)) {
    throw new DuplicateError("Invalid source repository.", 400);
  }
  const source = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, accessToken);
  if (source.res.status === 404) throw new DuplicateError("Source repository not found.", 404);
  if (!source.res.ok) throw new Error(`GitHub GET repo failed with ${source.res.status}`);

  const env = gitEnv(accessToken);
  const created = await githubJson("/user/repos", accessToken, {
    method: "POST",
    body: {
      name: newName,
      private: isPrivate,
      description: source.body.description ?? undefined,
      auto_init: false,
    },
  });
  let target = created.body;
  let reused = false;
  if (created.res.status === 422) {
    const alreadyExists = created.body?.errors?.some((e) => /already exists/i.test(e.message ?? ""));
    // Retrying after a failed copy: reuse the empty repo left behind.
    const existing = alreadyExists ? await findEmptyOwnRepo(userLogin, newName, accessToken, env) : null;
    if (!existing) {
      throw new DuplicateError(
        alreadyExists
          ? `A repository named "${newName}" already exists in your account.`
          : (created.body?.errors?.[0]?.message ?? created.body?.message ?? "GitHub rejected that repository name."),
        alreadyExists ? 409 : 422,
      );
    }
    target = existing;
    reused = true;
  } else if (!created.res.ok) {
    throw new Error(`GitHub create repo failed with ${created.res.status}`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "twinstack-"));
  const repoDir = path.join(workDir, "repo.git");
  let pushed = false;
  try {
    // A bare clone fetches only branches and tags (not refs/pull/*, which
    // GitHub refuses on push), which is exactly what we want to copy.
    await git(["clone", "--bare", "--quiet", source.body.clone_url, repoDir], { cwd: workDir, env });

    // An empty source has no refs; the new empty repo is already a faithful copy.
    if (await hasRefs(repoDir, env)) {
      await git(["push", "--quiet", target.clone_url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"], {
        cwd: repoDir,
        env,
      });
      pushed = true;
    }
  } catch (err) {
    err.partialRepo = target.html_url;
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  // GitHub picks the first pushed branch as default; match the source instead.
  const settings = {};
  if (pushed && source.body.default_branch) settings.default_branch = source.body.default_branch;
  if (reused && target.private !== isPrivate) settings.private = isPrivate;
  if (Object.keys(settings).length) {
    await githubJson(`/repos/${target.full_name}`, accessToken, { method: "PATCH", body: settings }).catch(() => {});
  }

  return {
    id: target.id,
    name: target.name,
    fullName: target.full_name,
    owner: target.owner.login,
    private: isPrivate,
    fork: false,
    archived: false,
    description: target.description,
    htmlUrl: target.html_url,
    language: source.body.language,
    stars: 0,
    updatedAt: new Date().toISOString(),
    permission: "admin",
  };
}

async function hasRefs(repoDir, env) {
  const { stdout } = await execFileAsync("git", ["for-each-ref", "--count=1"], { cwd: repoDir, env });
  return stdout.trim() !== "";
}

async function findEmptyOwnRepo(userLogin, name, accessToken, env) {
  const { res, body } = await githubJson(
    `/repos/${encodeURIComponent(userLogin)}/${encodeURIComponent(name)}`,
    accessToken,
  );
  if (!res.ok || !body.permissions?.admin) return null;
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", body.clone_url], { env, timeout: 60 * 1000 });
    return stdout.trim() === "" ? body : null;
  } catch {
    return null;
  }
}

// Keep the lines that explain the failure; drop git's progress noise.
export function summarizeGitError(stderr) {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(error|fatal|remote:|!)/i.test(l) && !/^remote:\s*$/.test(l));
  return (lines.length ? lines : [stderr.trim()]).slice(0, 4).join(" ").slice(0, 400);
}
