import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GIT_TIMEOUT_MS } from "./duplicate.js";
import { WorkspaceError, acquire, getStatus, git, listChanges, mergeFile, readMeta, tryGit, workspaceDir } from "./workspace.js";

// Bringing what others published into this browser's copy, without losing anyone's work.
//
// Each browser keeps its own copy of a site (workspace.js), so work stays unpublished until its
// owner publishes. Before publishing, the copy catches up with the published site (`syncForPublish`):
// files only one side changed are taken as they are, files both changed in different places are
// combined line by line, and files both changed in the same places ("clashes") are never decided
// here: nothing moves, and the browser shows both versions so the owner chooses (`resolveForPublish`),
// part by part, by hand, or with Claude's suggestion (`clashForAi`). Opening a site brings changes in
// the same way, only when nothing clashes (`acceptIncoming` in github-changes.js).

const execFileAsync = promisify(execFile);

// Longer than any run of "=" or "<" a page is likely to hold (a markdown heading's "=======" underline).
const MARKER_SIZE = 17;
const MINE_MARK = `${"<".repeat(MARKER_SIZE)} `;
const SPLIT_MARK = "=".repeat(MARKER_SIZE);
const THEIRS_MARK = `${">".repeat(MARKER_SIZE)} `;
const LABELS = ["your version", "before", "published version"];
// Bigger texts are offered as a whole-file choice only: comparing them part by part in a browser
// would be unusable, and they're never pages.
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_RESOLVED_BYTES = 2 * 1024 * 1024;
// A leftover comparison marker. A line of "=" alone is left out: it underlines a markdown heading.
const CONFLICT_LINE = /^(?:<{7,}|>{7,})(?: |$)/m;

/** A file's bytes at `ref`, or null when it isn't there. */
async function blobAt(dir, ref, file) {
  const sha = (await tryGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}:${file}`]))?.trim();
  if (!sha) return null;
  const { stdout } = await execFileAsync("git", ["cat-file", "blob", sha], { cwd: dir, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  return stdout;
}

const isText = (...buffers) => buffers.every((b) => b === null || (b.length <= MAX_TEXT_BYTES && !b.includes(0)));
const sameBytes = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
const lf = (buffer) => buffer.toString("utf8").replace(/\r\n/g, "\n");

/**
 * git merge-file's output, with markers MARKER_SIZE long, as parts: `{ same }` text both keep, and
 * `{ mine, theirs }` where the two versions clash.
 */
function partsOf(marked) {
  const parts = [];
  let same = [];
  let block = null;
  const lines = marked.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = i === lines.length - 1;
    if (block === null && line.startsWith(MINE_MARK)) {
      if (same.length) parts.push({ same: same.join("\n") + "\n" });
      same = [];
      block = { mine: [], theirs: [], side: "mine" };
    } else if (block?.side === "mine" && line === SPLIT_MARK) {
      block.side = "theirs";
    } else if (block?.side === "theirs" && line.startsWith(THEIRS_MARK)) {
      parts.push({ mine: block.mine.map((l) => `${l}\n`).join(""), theirs: block.theirs.map((l) => `${l}\n`).join("") });
      block = null;
    } else if (block) {
      block[block.side].push(line);
    } else if (!last || line) {
      same.push(line);
    }
  }
  // The text's last line has no newline when the file didn't end with one.
  if (same.length) parts.push({ same: same.join("\n") + (marked.endsWith("\n") ? "\n" : "") });
  return parts;
}

/**
 * What bringing `target` in would do to the copy's unpublished changes, without changing anything.
 * `clean`: files whose changes combine by themselves (with the combined text, when both changed
 * them); `clashes`: files the owner must decide.
 */
async function analyse(dir, target) {
  const incoming = new Set((await git(dir, ["diff", "--name-only", "--no-renames", "-z", "HEAD", target])).split("\0").filter(Boolean));
  const clean = [];
  const clashes = [];
  for (const change of await listChanges(dir)) {
    if (!incoming.has(change.path)) continue;
    const file = change.path;
    const full = path.join(dir, file);
    const mine = existsSync(full) ? await fs.readFile(full) : null;
    const [base, theirs] = await Promise.all([blobAt(dir, "HEAD", file), blobAt(dir, target, file)]);
    if (sameBytes(mine, theirs)) {
      clean.push({ file, take: "theirs" });
      continue;
    }
    if (mine === null || theirs === null) {
      clashes.push({ file, kind: mine === null ? "removed-here" : "removed-there", mine, theirs, base });
      continue;
    }
    if (!isText(mine, theirs, base)) {
      clashes.push({ file, kind: "whole", mine, theirs, base });
      continue;
    }
    const crlf = mine.includes("\r\n");
    const merged = await mergeFile(Buffer.from(lf(mine)), Buffer.from(base ? lf(base) : ""), Buffer.from(lf(theirs)), LABELS, MARKER_SIZE);
    const text = merged.text.toString("utf8");
    if (!merged.conflicts) {
      clean.push({ file, take: "merged", content: crlf ? text.replace(/\n/g, "\r\n") : text });
      continue;
    }
    clashes.push({ file, kind: "text", mine, theirs, base, crlf, parts: partsOf(text) });
  }
  return { clean, clashes };
}

/** A clash as the browser shows it: the two versions and, for text, its parts. */
function clashView({ file, kind, mine, theirs, parts }) {
  const text = (b) => (b !== null && isText(b) ? lf(b) : null);
  return {
    file,
    // "text": parts to choose between; "whole": one version or the other (a picture, a big file);
    // "removed-here"/"removed-there": one side removed the file, the other changed it.
    kind,
    mine: kind === "whole" ? null : text(mine),
    theirs: kind === "whole" ? null : text(theirs),
    parts: parts ?? null,
  };
}

/** What `origin/<branch>` has that HEAD doesn't, in the owner's words (newest first). */
async function subjectsOf(dir, target) {
  return (await git(dir, ["log", "--first-parent", "--format=%s", `HEAD..${target}`])).split("\n").filter(Boolean);
}

/**
 * Saved work that never reached GitHub (a publish that failed) becomes unpublished changes again,
 * on top of where it started, so it's combined like any other change. Anything staged is unstaged,
 * so every change is a plain working-tree change.
 */
async function asChanges(dir, target) {
  if ((await git(dir, ["rev-list", "--count", `${target}..HEAD`])).trim() !== "0") {
    const base = (await git(dir, ["merge-base", "HEAD", target])).trim();
    await git(dir, ["reset", "--quiet", "--mixed", base]);
  } else {
    await git(dir, ["reset", "--quiet"]);
  }
}

/** Checks a resolution for one clash; returns the bytes to write, `null` to remove the file, or `undefined` for the published version. */
function resolutionFor(clash, resolution) {
  if (!resolution) {
    throw new WorkspaceError(`Choose what to keep in ${clash.file} first.`, 400, "publish_unresolved");
  }
  if (resolution.keep === "theirs") return undefined;
  if (resolution.keep === "mine") return clash.mine;
  if (typeof resolution.content !== "string" || clash.kind === "whole") {
    throw new WorkspaceError(`Choose what to keep in ${clash.file}.`, 400);
  }
  if (Buffer.byteLength(resolution.content) > MAX_RESOLVED_BYTES) throw new WorkspaceError(`${clash.file} is too large.`, 400);
  if (CONFLICT_LINE.test(resolution.content)) {
    throw new WorkspaceError(`${clash.file} still has a line starting with <<<<<<< or >>>>>>>, left from comparing the two versions. Remove it first.`, 400);
  }
  if (/\.json$/i.test(clash.file)) {
    try {
      JSON.parse(resolution.content);
    } catch {
      throw new WorkspaceError(`${clash.file} isn't valid JSON as combined. Check its commas and brackets.`, 400);
    }
  }
  if (/^content\/.+\.md$/.test(clash.file) && !/^---\r?\n/.test(resolution.content) && [clash.mine, clash.theirs].some((b) => b && /^---\r?\n/.test(lf(b)))) {
    throw new WorkspaceError(`${clash.file} has lost its page settings (the part between the --- lines at the top). Keep them in.`, 400);
  }
  // Each page setting is one line: "Keep both" on one (two title: lines) leaves a page the site can't read.
  const settings = /^---\r?\n([\s\S]*?)\r?\n---/.exec(resolution.content)?.[1];
  if (/^content\/.+\.md$/.test(clash.file) && settings) {
    const names = settings.split(/\r?\n/).map((line) => /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1]).filter(Boolean);
    const repeated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
    if (repeated.length) {
      throw new WorkspaceError(`${clash.file} lists ${repeated.map((n) => `"${n}"`).join(", ")} more than once in its page settings. Keep one version of ${repeated.length > 1 ? "each" : "it"}.`, 400);
    }
  }
  const text = resolution.content.replace(/\r\n/g, "\n");
  return Buffer.from(clash.crlf ? text.replace(/\n/g, "\r\n") : text);
}

/**
 * Moves the copy to `target`, writing each changed file as decided: clean ones as combined, clashes
 * as resolved. Everything is worked out before anything is written. The unpublished files are set
 * back to how they were if the move fails, so it never loses work.
 */
async function bringIn(dir, target, { clean, clashes }, resolutions) {
  const decided = new Map();
  for (const clash of clashes) decided.set(clash.file, resolutionFor(clash, resolutions.get(clash.file)));
  for (const item of clean) decided.set(item.file, item.take === "merged" ? Buffer.from(item.content) : undefined);

  const saved = [];
  for (const file of decided.keys()) {
    const full = path.join(dir, file);
    saved.push({ file, full, content: existsSync(full) ? await fs.readFile(full) : null });
    if ((await tryGit(dir, ["rev-parse", "--verify", "--quiet", `HEAD:${file}`])) !== null) await git(dir, ["checkout", "--quiet", "HEAD", "--", file]);
    else await fs.rm(full, { force: true });
  }
  try {
    await git(dir, ["merge", "--ff-only", "--quiet", target]);
  } catch (err) {
    for (const { full, content } of saved) {
      if (content === null) await fs.rm(full, { force: true });
      else {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content);
      }
    }
    throw err;
  }
  for (const [file, content] of decided) {
    if (content === undefined) continue; // the published version, which the move put there
    const full = path.join(dir, file);
    if (content === null) await fs.rm(full, { force: true });
    else {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
  }
}

/** The live branch and its published head, fetched; refuses on a review branch. */
async function published(dir, accessToken) {
  const { defaultBranch } = await readMeta(dir);
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch !== defaultBranch) return null;
  await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
  const target = `origin/${branch}`;
  return { target, sha: (await git(dir, ["rev-parse", target])).trim() };
}

/**
 * Before publishing: brings in what others published since this copy last caught up, when it
 * combines by itself. Returns `{ status, subjects }` (what came in, possibly nothing), or
 * `{ clashes, sha, subjects }` with nothing changed when the owner must choose first.
 */
export async function syncForPublish({ key, accessToken }) {
  const dir = workspaceDir(key);
  const release = acquire(key, "checking for newer changes");
  try {
    const live = await published(dir, accessToken);
    if (!live || (await git(dir, ["rev-list", "--count", `HEAD..${live.target}`])).trim() === "0") return { status: null, subjects: [] };
    await asChanges(dir, live.target);
    const subjects = await subjectsOf(dir, live.target);
    const found = await analyse(dir, live.target);
    if (found.clashes.length) return { clashes: found.clashes.map(clashView), sha: live.sha, subjects };
    await bringIn(dir, live.target, found, new Map());
    return { subjects };
  } finally {
    release();
  }
}

/**
 * Brings the published site in with the owner's choices for every clash (`resolutions`: `{ file,
 * keep: "mine" | "theirs" }` or `{ file, content }`). `sha` is the published head the clashes were
 * shown for: if someone published again since, nothing is changed (`publish_moved`) and the
 * browser asks again.
 */
export async function resolveForPublish({ key, accessToken, sha, resolutions }) {
  if (!Array.isArray(resolutions) || resolutions.length > 500) throw new WorkspaceError("Invalid choices.", 400);
  const chosen = new Map();
  for (const r of resolutions) {
    if (!r || typeof r.file !== "string" || chosen.has(r.file)) throw new WorkspaceError("Invalid choices.", 400);
    chosen.set(r.file, r);
  }
  const dir = workspaceDir(key);
  const release = acquire(key, "combining your changes");
  try {
    const live = await published(dir, accessToken);
    if (!live) throw new WorkspaceError("Changes can only be combined on the live version of the site.", 409);
    if (live.sha !== sha) {
      throw new WorkspaceError("Someone published again just now. Look at the latest changes before you publish.", 409, "publish_moved");
    }
    await asChanges(dir, live.target);
    const subjects = await subjectsOf(dir, live.target);
    const found = await analyse(dir, live.target);
    const unknown = [...chosen.keys()].filter((file) => !found.clashes.some((c) => c.file === file));
    if (unknown.length) throw new WorkspaceError("Your changes moved on since. Look at them again before you publish.", 409, "publish_moved");
    await bringIn(dir, live.target, found, chosen);
    return { status: await getStatus(key), subjects };
  } finally {
    release();
  }
}

/**
 * One clash's three versions, for Claude to combine (`claudeResolver` in site-update.js). Read-only:
 * refused when the published site moved past `sha`, since the owner would be combining old work.
 */
export async function clashForAi({ key, sha, file }) {
  const dir = workspaceDir(key);
  const { defaultBranch } = await readMeta(dir);
  const target = `origin/${defaultBranch}`;
  if ((await git(dir, ["rev-parse", target])).trim() !== sha) {
    throw new WorkspaceError("Someone published again just now. Look at the latest changes before you publish.", 409, "publish_moved");
  }
  const clash = (await analyse(dir, target)).clashes.find((c) => c.file === file);
  if (!clash) throw new WorkspaceError("That file doesn't need combining any more.", 409, "publish_moved");
  if (clash.kind !== "text") throw new WorkspaceError("The AI can only combine text. Choose one of the two versions.", 400);
  const marked = clash.parts.map((p) => ("same" in p ? p.same : `<<<<<<< your version\n${p.mine}=======\n${p.theirs}>>>>>>> published version\n`)).join("");
  return { file, ours: Buffer.from(lf(clash.mine)), base: Buffer.from(clash.base ? lf(clash.base) : ""), theirs: Buffer.from(lf(clash.theirs)), marked: Buffer.from(marked) };
}

export { analyse as analyseIncoming, asChanges as unpublishedAsChanges, bringIn as bringInIncoming, subjectsOf as incomingSubjects };
