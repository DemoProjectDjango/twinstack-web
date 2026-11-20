/**
 * Earlier versions of the published site: the last few commits on the copy's default branch, and
 * restoring one of them. Restoring never rewrites history: the old version's files become ordinary
 * unpublished changes in the editor, which the owner reviews and publishes like any other change
 * (the site check runs first), so a restore can itself be taken back by restoring again.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ownerOf, readManifest } from "./site-update.js";
import { WorkspaceError, git, listChanges, readMeta, tryGit, workspaceDir } from "./workspace.js";

/** How many earlier versions can be restored. */
export const MAX_VERSIONS = 5;

/** Copies without `twinstack-update.json`: everything but the site's tools goes back. */
const FALLBACK_TOOLS = /^(scripts\/|templates\/|\.github\/|package(-lock)?\.json$|twinstack-update\.json$|AGENTS\.md$|CLAUDE\.md$)/;
const DESIGNED = /data-designed=/;
/** git trailers the app or git adds; anything else in the body is the owner's publish note. */
const TRAILER = /^(Twinstack-Update|Twinstack-Template|Co-Authored-By|Signed-off-by): .*$/gim;
/**
 * Never go back: `.gitignore` (older rules could publish node_modules or dist) and `CNAME` (the
 * custom domain is set on GitHub, so an older file would point the site at the wrong address).
 */
const NEVER = new Set([".gitignore", "CNAME"]);
/** Settings in site.config.json that the app keeps, not the owner: they stay as they are now. */
const APP_SETTINGS = ["updates", "analytics"];

function describe(subject, body) {
  if (/Twinstack-Update:/.test(body)) return { kind: "update", title: "New site tools installed" };
  return { kind: "publish", title: subject.trim() || "Published changes" };
}

/** The live version and up to MAX_VERSIONS before it, newest first. */
export async function listVersions({ key, accessToken }) {
  const dir = workspaceDir(key);
  const branch = (await readMeta(dir)).defaultBranch;
  await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
  const out = await git(dir, ["log", "--first-parent", `-n${MAX_VERSIONS + 1}`, "--format=%H%x00%cI%x00%an%x00%s%x00%b%x1e", `origin/${branch}`]);
  const versions = [];
  for (const record of out.split("\x1e")) {
    const [sha, date, author, subject = "", body = ""] = record.replace(/^\n/, "").split("\0");
    if (!sha?.trim()) continue;
    const note = body.replace(TRAILER, "").trim() || null;
    versions.push({ sha: sha.trim(), date, author, ...describe(subject, body), note, live: versions.length === 0 });
  }
  return { versions, max: MAX_VERSIONS };
}

/**
 * Whether `file` goes back. The live version's `twinstack-update.json` decides, as for a site update:
 * the owner's files (`site`, and shared files the template only seeded) go back; the site's tools
 * (`template`, `package.json`) stay as they are now, since older tools would undo a site update whose
 * migrations already ran. The header and footer go back only to a version where they were the owner's
 * design (`data-designed`); otherwise today's standard ones stay.
 */
async function goesBack(dir, manifest, sha, file) {
  if (NEVER.has(file)) return false;
  if (!manifest) return !FALLBACK_TOOLS.test(file);
  const owner = ownerOf(manifest, file);
  if (owner === "site" || owner === "merge") return true;
  if (owner !== "designed") return false;
  const old = await tryGit(dir, ["show", `${sha}:${file}`]);
  return old !== null && DESIGNED.test(old);
}

/**
 * Puts the live version's APP_SETTINGS back into the restored site.config.json (the recorded
 * migrations, so a site update doesn't run them again; the visit counter's key), keeping the old
 * file's other text. If either side isn't valid JSON, the old file stays as it came back.
 */
async function keepAppSettings(dir) {
  const full = path.join(dir, "site.config.json");
  const live = await tryGit(dir, ["show", "HEAD:site.config.json"]);
  let liveConfig, restored;
  try {
    liveConfig = JSON.parse(live ?? "");
    restored = JSON.parse(await fs.readFile(full, "utf8"));
  } catch {
    return;
  }
  let changed = false;
  for (const key of APP_SETTINGS) {
    if (JSON.stringify(liveConfig[key]) === JSON.stringify(restored[key])) continue;
    if (liveConfig[key] === undefined) delete restored[key];
    else restored[key] = liveConfig[key];
    changed = true;
  }
  if (!changed) return;
  const text = await fs.readFile(full, "utf8");
  const indent = text.match(/^\{\r?\n([ \t]+)/)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  await fs.writeFile(full, JSON.stringify(restored, null, indent).replace(/\n/g, eol) + eol);
}

/** Puts version `sha` (one of the last MAX_VERSIONS before the live one) back as unpublished changes. */
export async function restoreVersion({ key, accessToken, sha }) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new WorkspaceError("Choose a version to restore.", 400);
  const dir = workspaceDir(key);
  const branch = (await readMeta(dir)).defaultBranch;
  const { versions } = await listVersions({ key, accessToken });
  const version = versions.find((v) => v.sha === sha);
  if (!version) throw new WorkspaceError(`Only the last ${MAX_VERSIONS} published versions can be restored.`, 409);
  if (version.live) throw new WorkspaceError("That's the version on your live site now.", 409);

  const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (current !== branch) throw new WorkspaceError("You're working on a review copy. Go back to your live site, then restore.", 409);
  if ((await listChanges(dir)).length) {
    throw new WorkspaceError("You have changes that aren't live yet. Publish or undo them first, then restore.", 409);
  }
  // Something published from elsewhere (GitHub, another browser): with nothing unpublished here, catch up.
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  if (head !== versions[0].sha) {
    const behind = (await tryGit(dir, ["merge-base", "--is-ancestor", head, versions[0].sha])) !== null;
    if (!behind) throw new WorkspaceError("Your last publish didn't finish. Publish again first, then restore.", 409);
    await git(dir, ["merge", "--quiet", "--ff-only", versions[0].sha]);
  }

  const manifestText = await tryGit(dir, ["show", "HEAD:twinstack-update.json"]);
  const manifest = manifestText ? readManifest(manifestText) : null;
  // --no-renames: a moved file is a removal plus an addition, each decided on its own path.
  const diff = (await git(dir, ["diff", "--no-renames", "--name-status", "-z", "HEAD", sha])).split("\0").filter(Boolean);
  // The template versions site updates brought in since then: a file one of them added (a starter data
  // file, say) isn't the owner's work, so it isn't removed.
  const updates = (await git(dir, ["log", "--first-parent", "--format=%H%x00%b%x1e", `${sha}..HEAD`]))
    .split("\x1e")
    .map((r) => r.replace(/^\n/, "").split("\0"))
    .filter(([commit, body]) => commit && /Twinstack-Update:/.test(body ?? ""))
    .map(([commit]) => commit);
  const addedByUpdates = new Set();
  for (const commit of updates) {
    const added = await git(dir, ["diff", "--no-renames", "--name-only", "--diff-filter=A", "-z", `${commit}^1`, commit]);
    for (const file of added.split("\0")) if (file) addedByUpdates.add(file);
  }
  const fromUpdate = async (file) => addedByUpdates.has(file);
  const back = [];
  const removed = [];
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const [status, file] = [diff[i], diff[i + 1]];
    if (!(await goesBack(dir, manifest, sha, file))) continue;
    if (status === "D" && (await fromUpdate(file))) continue;
    (status === "D" ? removed : back).push(file);
  }
  // The index stays at the live version, so everything shows on What's changed as ordinary changes.
  for (let i = 0; i < back.length; i += 200) {
    // Literal paths: a name like "a*b.txt" or "[x].txt" isn't a pattern.
    await git(dir, ["--literal-pathspecs", "restore", `--source=${sha}`, "--worktree", "--", ...back.slice(i, i + 200)]);
  }
  for (const file of removed) await fs.rm(path.join(dir, file), { force: true });
  if (back.includes("site.config.json")) await keepAppSettings(dir);
  return { restored: { sha, date: version.date, title: version.title }, changed: back.length + removed.length };
}
