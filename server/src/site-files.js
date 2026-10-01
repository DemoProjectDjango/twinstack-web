import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  addWorkLogLines,
  clearWorkLog,
  forgetWorkLogLines,
  forgottenWorkLogLines,
  recentWorkLogLines,
  replaceWorkLogLine,
} from "./db.js";
import { WorkspaceError, acquire, siteIdFor, workspaceDir } from "./workspace.js";

// Reads and writes the site's own data files. Everything here parses files
// directly; repo code is never imported into the server process.

const MAX_FILE_BYTES = 512 * 1024;
const SCHEDULE_FILE = "scripts/scaffold-schedule.md";
const JSON_BLOCK = /```json\r?\n([\s\S]*?)\r?\n```/g;

/** Files the web UI may read and replace whole, with a validator for each. */
const DATA_FILES = {
  "site-tree": { path: "scripts/site-tree.md", validate: () => {} },
  // The owner's standing notes, which Claude reads before every request.
  "knowledge-notes": { path: "knowledge/notes.md", validate: () => {} },
  "page-commands": {
    path: "scripts/page-commands.json",
    validate: (content) => {
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        throw new WorkspaceError(`Not valid JSON: ${err.message}`, 400);
      }
      const ok =
        Array.isArray(parsed?.queue) &&
        parsed.queue.every((job) => typeof job?.file === "string" && typeof job?.instruction === "string");
      if (!ok) throw new WorkspaceError('Expected { "queue": [{ "file": "...", "instruction": "..." }] }.', 400);
    },
  },
};

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function inside(dir, relative) {
  const full = path.resolve(dir, relative);
  if (full !== dir && !full.startsWith(dir + path.sep)) throw new WorkspaceError("Invalid path.", 400);
  return full;
}

/* --------------------------------------------------------------- overview */

/** Top-level scalar frontmatter fields only; enough to list pages. */
function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

// Markdown outside content/ that the site's scripts/edit-md.js may change:
// scripts/site-tree.md, scripts/scaffold-schedule.md, the docs. Pages under
// content/ go through edit-page.js; CHANGELOG.md is generated.
const MARKDOWN_SKIPPED_DIRS = new Set(["content", "dist", "node_modules", "static"]);

export function isEditableMarkdown(file) {
  if (typeof file !== "string" || !/^[\w./-]+\.md$/.test(file) || file === "CHANGELOG.md") return false;
  const parts = file.split("/");
  return !MARKDOWN_SKIPPED_DIRS.has(parts[0]) && !parts.some((part) => part === "" || part.startsWith("."));
}

async function listMarkdown(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!MARKDOWN_SKIPPED_DIRS.has(relative)) out.push(...(await listMarkdown(full, base)));
    } else if (isEditableMarkdown(relative)) {
      out.push(relative);
    }
  }
  return out.sort();
}

async function listFiles(dir, extension, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, extension, base)));
    else if (entry.name.endsWith(extension)) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** Collections, their pages, the header navigation and the files Claude may edit. */
export async function getOverview(key) {
  const dir = workspaceDir(key);
  const siteText = await readText(path.join(dir, "site.config.json"));
  if (siteText === null) throw new WorkspaceError("site.config.json is missing.", 422);
  let site;
  let navigation = null;
  try {
    site = JSON.parse(siteText);
    const navText = await readText(path.join(dir, "content/data/navigation.json"));
    if (navText) navigation = JSON.parse(navText);
  } catch (err) {
    throw new WorkspaceError(`Couldn't parse the site's JSON config: ${err.message}`, 422);
  }

  const collections = [];
  for (const [name, collection] of Object.entries(site.collections ?? {})) {
    if (typeof collection?.dir !== "string") continue;
    const collectionDir = inside(dir, collection.dir);
    const pages = [];
    for (const file of await listFiles(collectionDir, ".md")) {
      const fields = frontmatter((await readText(path.join(collectionDir, file))) ?? "");
      pages.push({
        file: `${collection.dir}/${file}`,
        slug: fields.slug || path.basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, ""),
        title: fields.title || file,
        draft: fields.draft === "true",
        date: fields.date || null,
      });
    }
    collections.push({ name, dir: collection.dir, label: collection.index?.label ?? name, pages });
  }

  const templates = [
    ...(await listFiles(path.join(dir, "templates/layouts"), ".html")).map((f) => `templates/layouts/${f}`),
    ...(await listFiles(path.join(dir, "templates/partials"), ".html")).map((f) => `templates/partials/${f}`),
  ];

  // Copies made before edit-page.js learnt --image/--proposal-out can still run
  // plain edits, and ones before --generate can't turn a draft into a page.
  const editScript = (await readText(path.join(dir, "scripts/edit-page.js"))) ?? "";
  // Copies made before scripts/edit-md.js existed can't edit other markdown.
  const mdEdit = existsSync(path.join(dir, "scripts/edit-md.js"));

  return {
    site: { name: site.name, url: site.url, model: site.automation?.model ?? null },
    features: {
      pageEditImages: editScript.includes("--proposal-out"),
      pageGenerate: editScript.includes("--generate"),
      mdEdit,
      // Copies made before knowledge/ existed have no notes or work log for Claude.
      memory: existsSync(path.join(dir, KNOWLEDGE_SCRIPT)),
    },
    markdownFiles: mdEdit ? await listMarkdown(dir) : [],
    collections,
    navigation: {
      items: (navigation?.header?.items ?? []).map((item) => ({
        label: item.label,
        url: item.url,
        collection: item.type === "collection" ? item.collection : null,
        limit: item.limit ?? null,
      })),
      cta: navigation?.header?.cta ?? null,
    },
    otherEditable: [...templates, "styles/main.css", "site.config.json"],
  };
}

/* ------------------------------------------------------------- data files */

export async function readDataFile(key, name) {
  const spec = DATA_FILES[name];
  if (!spec) throw new WorkspaceError("Unknown file.", 404);
  const content = await readText(path.join(workspaceDir(key), spec.path));
  return { name, path: spec.path, exists: content !== null, content: content ?? "" };
}

export async function writeDataFile(key, name, content) {
  const spec = DATA_FILES[name];
  if (!spec) throw new WorkspaceError("Unknown file.", 404);
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new WorkspaceError("File content is missing or too large.", 400);
  }
  spec.validate(content);
  const release = acquire(key, `saving ${spec.path}`);
  try {
    const file = path.join(workspaceDir(key), spec.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content.endsWith("\n") ? content : `${content}\n`);
  } finally {
    release();
  }
  return readDataFile(key, name);
}

/* ------------------------------------------------ installing edit-md.js */

// Copies made before scripts/edit-md.js existed get it (and the one lib file
// it adds) from the template. Existing files are never replaced.
export const MD_EDIT_FILES = ["scripts/edit-md.js", "scripts/lib/schedule-jobs.js"];
const MD_EDIT_NPM_SCRIPTS = {
  "md:edit": "node --env-file-if-exists=.env scripts/edit-md.js",
  "md:edit:preview": "node --env-file-if-exists=.env scripts/edit-md.js --dry-run",
  "md:edit:list": "node scripts/edit-md.js --list",
};

/**
 * Writes the MD_EDIT_FILES the copy is missing, from `files` ({ path: content }),
 * and adds the md:edit npm scripts to package.json. Returns what changed.
 */
export async function installMdEdit(key, files) {
  const dir = workspaceDir(key);
  const release = acquire(key, "adding markdown editing");
  try {
    const written = [];
    for (const file of MD_EDIT_FILES) {
      const target = inside(dir, file);
      if (existsSync(target)) continue;
      if (typeof files[file] !== "string") throw new WorkspaceError(`${file} is missing from the template.`, 409);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, files[file]);
      written.push(file);
    }

    const packagePath = path.join(dir, "package.json");
    const packageText = await readText(packagePath);
    if (packageText !== null) {
      const pkg = JSON.parse(packageText);
      const missing = Object.entries(MD_EDIT_NPM_SCRIPTS).filter(([name]) => !pkg.scripts?.[name]);
      if (pkg.scripts && missing.length) {
        Object.assign(pkg.scripts, Object.fromEntries(missing));
        const eol = packageText.includes("\r\n") ? "\r\n" : "\n";
        await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`.replace(/\n/g, eol));
        written.push("package.json");
      }
    }
    return { written };
  } finally {
    release();
  }
}

/**
 * Replaces files in the copy with the template's versions (`files`: { path:
 * content }), as uncommitted changes the user reviews and publishes on the
 * Changes tab. Returns the paths whose content changed.
 */
export async function updateFromTemplate(key, files, label) {
  const dir = workspaceDir(key);
  const release = acquire(key, label);
  try {
    const written = [];
    for (const [file, content] of Object.entries(files)) {
      const target = inside(dir, file);
      if ((await readText(target)) === content) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      written.push(file);
    }
    return { written };
  } finally {
    release();
  }
}

/* ------------------------------------------------------ Claude proposals */

// A "Preview change" run saves Claude's complete proposed file here (inside
// .git, so it never shows up as a change). Applying writes exactly that
// version, optionally edited by the user, without calling Claude again.
export const PROPOSAL_FILE = ".git/twinstack-proposal.json";
const MARKDOWN_PAGE = /^content\/[\w./-]+\.md$/;

export async function clearProposal(key) {
  await fs.rm(path.join(workspaceDir(key), PROPOSAL_FILE), { force: true });
}

/** Whether a proposal of this mode may write this file. */
function proposalAllowed(mode, file) {
  return mode === "markdown" ? isEditableMarkdown(file) : MARKDOWN_PAGE.test(file) && !file.split("/").includes("..");
}

/** The pending proposal with the file's current text as `original` (null if it's gone), or null. */
export async function readProposal(key) {
  const text = await readText(path.join(workspaceDir(key), PROPOSAL_FILE));
  if (!text) return null;
  try {
    const proposal = JSON.parse(text);
    if (typeof proposal.file !== "string" || typeof proposal.content !== "string") return null;
    // Older copies write no mode: their proposals are always instruction edits.
    const mode = ["generate", "markdown"].includes(proposal.mode) ? proposal.mode : "edit";
    const original = proposalAllowed(mode, proposal.file)
      ? await readText(inside(workspaceDir(key), proposal.file))
      : null;
    return {
      file: proposal.file,
      mode,
      original,
      instruction: String(proposal.instruction ?? ""),
      images: Array.isArray(proposal.images) ? proposal.images.map(String) : [],
      content: proposal.content,
      problems: Array.isArray(proposal.problems) ? proposal.problems.map(String) : [],
      warnings: Array.isArray(proposal.warnings) ? proposal.warnings.map(String) : [],
      createdAt: proposal.createdAt ?? null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- work log */

// Copies with scripts/lib/knowledge.js send knowledge/notes.md and their work
// log to Claude on every request, and log each change their scripts write
// (keep the constants and the entry format here in step with that file).
//
// The committed knowledge/work-log.md only holds what's on the checked-out
// branch: after a change goes out as a pull request and the workspace starts
// fresh from the default branch, its line is gone until the PR merges. So the
// log is also kept in the database, per site, and before every Claude run
// prepareWorkLog() writes the latest of both to WORK_LOG_FOR_RUN (inside .git,
// never a change) and the script reads it through TWINSTACK_WORK_LOG.
// collectWorkLog() saves the lines the run added once it ends.
const KNOWLEDGE_SCRIPT = "scripts/lib/knowledge.js";
const WORK_LOG = "knowledge/work-log.md";
const WORK_LOG_ARCHIVE = "knowledge/archive";
export const WORK_LOG_FOR_RUN = ".git/twinstack-work-log.md";
const LOG_ROTATE_AT = 60;
const LOG_KEEP = 30;
const MAX_INSTRUCTION_CHARS = 160;
const WORK_LOG_HEADER = `# Work log

Written automatically: one line per change Claude made to this site that was kept, oldest first. Claude reads this before every request so new work stays consistent with earlier work. Older lines move to knowledge/archive/. Standing decisions belong in knowledge/notes.md, not here.
`;

// A run's new lines are written by the copy's own script, so only well-formed
// ones are kept, and only so many per run.
const MAX_LINES_PER_RUN = 100;
const MAX_LINE_CHARS = 600;
const WELL_FORMED = /^- \d{4}-\d{2}-\d{2} · \S/;

const isEntry = (line) => line.startsWith("- ");
const entriesOf = (text) => (text ?? "").replace(/\r\n/g, "\n").split("\n").filter(isEntry);
// Written entries start "- YYYY-MM-DD"; a hand-written line without a date sorts first.
const entryDate = (line) => (WELL_FORMED.test(line) ? line.slice(2, 12) : "");

/**
 * Writes the site's latest work log for the Claude run about to start: the
 * checked-out branch's lines (which include ones made from a terminal and
 * pushed) together with the database's, newest LOG_ROTATE_AT of them. Returns
 * what collectWorkLog() needs, or null for a copy without the knowledge files.
 */
export async function prepareWorkLog(key) {
  const dir = workspaceDir(key);
  if (!existsSync(path.join(dir, KNOWLEDGE_SCRIPT))) return null;
  const siteId = await siteIdFor(key);
  const lines = await mergedWorkLog(dir, siteId, LOG_ROTATE_AT);
  await fs.writeFile(path.join(dir, WORK_LOG_FOR_RUN), `${WORK_LOG_HEADER}\n${lines.map((line) => `${line}\n`).join("")}`);
  return { siteId, count: lines.length };
}

/**
 * The site's memory as Claude gets it, oldest first, newest `limit` lines:
 * the database's lines and the checked-out branch's committed ones, without
 * any the user removed.
 */
async function mergedWorkLog(dir, siteId, limit) {
  const [committed, forgotten] = await Promise.all([
    readText(path.join(dir, WORK_LOG)).then(entriesOf),
    forgottenWorkLogLines(siteId),
  ]);
  // More than are sent, so committed lines that are also stored are recognised as such.
  const stored = await recentWorkLogLines(siteId, limit * 4);
  const known = new Set(stored);

  // The database has its lines in the order they happened. Lines only in the
  // committed log (made from a terminal) are placed by date, after the
  // database's lines from the same day: the sort is stable.
  return [...new Set([...stored, ...committed.filter((line) => !known.has(line))])]
    .filter((line) => !forgotten.has(line))
    .sort((a, b) => (entryDate(a) < entryDate(b) ? -1 : entryDate(a) > entryDate(b) ? 1 : 0))
    .slice(-limit);
}

/* ----------------------------------------------------- editing the memory */

// The Claude memory tab lists the work log and lets the user change or remove
// lines, or clear it. Each change is made in the database and in the
// checked-out committed log (an ordinary uncommitted change), so runs from a
// terminal agree once it's published. Removed lines are recorded as forgotten,
// so another branch's committed copy can't bring them back.
const MEMORY_LIST_LIMIT = 500;

function requireMemory(dir) {
  if (!existsSync(path.join(dir, KNOWLEDGE_SCRIPT))) {
    throw new WorkspaceError("This site's scripts predate Claude's memory. Update them from the template first.", 409);
  }
}

/** Whether the site has memory, and its lines (oldest first). */
export async function readMemory(key) {
  const dir = workspaceDir(key);
  if (!existsSync(path.join(dir, KNOWLEDGE_SCRIPT))) return { available: false, lines: [], sent: LOG_ROTATE_AT };
  return { available: true, lines: await mergedWorkLog(dir, await siteIdFor(key), MEMORY_LIST_LIMIT), sent: LOG_ROTATE_AT };
}

/** Applies `change` to the entry lines of the committed log, if there is one; the rest of the file stays as it is. */
async function rewriteCommittedWorkLog(dir, change) {
  const logPath = path.join(dir, WORK_LOG);
  const text = await readText(logPath);
  if (text === null) return;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const next = lines.flatMap((line) => (isEntry(line) ? change(line) : [line]));
  if (next.join("\n") !== lines.join("\n")) await fs.writeFile(logPath, next.join("\n"));
}

/** Runs a memory change under the workspace lock and returns the updated memory. */
async function changeMemory(key, label, fn) {
  const release = acquire(key, label);
  try {
    const dir = workspaceDir(key);
    requireMemory(dir);
    await fn(dir, await siteIdFor(key));
  } finally {
    release();
  }
  return readMemory(key);
}

function memoryLine(value, label) {
  if (typeof value !== "string" || !value || value.length > MAX_LINE_CHARS || /[\r\n]/.test(value)) {
    throw new WorkspaceError(`${label} must be one line of at most ${MAX_LINE_CHARS} characters.`, 400);
  }
  return value;
}

/** Removes one line from the memory. */
export async function forgetMemoryLine(key, line) {
  const target = memoryLine(line, "The line");
  return changeMemory(key, "removing a memory line", async (dir, siteId) => {
    await forgetWorkLogLines(siteId, [target]);
    await rewriteCommittedWorkLog(dir, (entry) => (entry === target ? [] : [entry]));
  });
}

/** Rewrites one line of the memory in place. */
export async function replaceMemoryLine(key, line, replacement) {
  const target = memoryLine(line, "The line");
  const next = memoryLine(replacement, "The new line").trim();
  if (!WELL_FORMED.test(next)) {
    throw new WorkspaceError('A memory line must start with "- YYYY-MM-DD · ".', 400);
  }
  return changeMemory(key, "editing a memory line", async (dir, siteId) => {
    if (!(await mergedWorkLog(dir, siteId, MEMORY_LIST_LIMIT)).includes(target)) {
      throw new WorkspaceError("That line isn't in the memory any more. Reload and try again.", 409);
    }
    if (next === target) return;
    await replaceWorkLogLine(siteId, target, next);
    await rewriteCommittedWorkLog(dir, (entry) => [entry === target ? next : entry]);
  });
}

/** Empties the memory: every stored line, and every committed one this branch has. */
export async function clearMemory(key) {
  return changeMemory(key, "clearing Claude's memory", async (dir, siteId) => {
    const visible = await mergedWorkLog(dir, siteId, MEMORY_LIST_LIMIT);
    const committed = entriesOf(await readText(path.join(dir, WORK_LOG)));
    await clearWorkLog(siteId);
    await forgetWorkLogLines(siteId, [...new Set([...visible, ...committed])]);
    await rewriteCommittedWorkLog(dir, () => []);
  });
}

/** Saves the lines the run appended to WORK_LOG_FOR_RUN. Never throws. */
export async function collectWorkLog(key, prepared) {
  if (!prepared) return;
  try {
    const lines = entriesOf(await readText(path.join(workspaceDir(key), WORK_LOG_FOR_RUN)))
      .slice(prepared.count)
      .filter((line) => WELL_FORMED.test(line) && line.length <= MAX_LINE_CHARS)
      .slice(0, MAX_LINES_PER_RUN);
    await addWorkLogLines(prepared.siteId, lines);
  } catch (err) {
    console.error(`Couldn't save the work log: ${err.message}`);
  }
}

/** One log line: "- <date> · <command> · <file> · <instruction>". */
function workLogEntry({ command, file, instruction }) {
  let what = String(instruction || "").replace(/\s+/g, " ").trim();
  if (what.length > MAX_INSTRUCTION_CHARS) what = `${what.slice(0, MAX_INSTRUCTION_CHARS - 1).trimEnd()}…`;
  return `- ${new Date().toISOString().slice(0, 10)} · ${command} · ${file}${what ? ` · ${what}` : ""}`;
}

/** Appends a line to the copy's committed log, rotating it like knowledge.js does. Never throws. */
async function appendCommittedWorkLog(dir, entry) {
  try {
    const logPath = path.join(dir, WORK_LOG);
    const existing = (await readText(logPath))?.replace(/\r\n/g, "\n");
    const text = existing ? existing.replace(/\n*$/, "\n") : `${WORK_LOG_HEADER}\n`;
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const lines = `${text}${entry}\n`.split("\n");

    const entries = lines.filter(isEntry);
    if (entries.length <= LOG_ROTATE_AT) {
      await fs.writeFile(logPath, lines.join("\n"));
      return;
    }
    // The oldest entries move to the archive, which is never sent to Claude.
    const moving = entries.length - LOG_KEEP;
    const archivePath = path.join(dir, WORK_LOG_ARCHIVE, `work-log-${entryDate(entry)}.md`);
    const archive = (await readText(archivePath)) ?? "# Work log archive\n\nOlder lines from knowledge/work-log.md. Not sent to Claude.\n";
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${archive.replace(/\n*$/, "\n")}${entries.slice(0, moving).join("\n")}\n`);
    let seen = 0;
    await fs.writeFile(logPath, lines.filter((line) => !(isEntry(line) && seen++ < moving)).join("\n").replace(/\n*$/, "\n"));
  } catch (err) {
    console.error(`Couldn't update ${WORK_LOG}: ${err.message}`);
  }
}

/** Logs a change applied from a preview: in the copy's committed log and in the database. Never throws. */
async function logAppliedChange(key, change) {
  const dir = workspaceDir(key);
  if (!existsSync(path.join(dir, KNOWLEDGE_SCRIPT)) || change.file.startsWith("knowledge/")) return;
  const entry = workLogEntry(change);
  await appendCommittedWorkLog(dir, entry);
  try {
    await addWorkLogLines(await siteIdFor(key), [entry]);
  } catch (err) {
    console.error(`Couldn't save the work log: ${err.message}`);
  }
}

/** Writes the proposal (or the user's edited version of it) to its page and clears it. */
export async function applyProposal(key, content) {
  if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new WorkspaceError("The page content is empty or too large.", 400);
  }
  const release = acquire(key, "applying the Claude edit");
  try {
    const proposal = await readProposal(key);
    if (!proposal) throw new WorkspaceError("There's no preview to apply. Preview the change again.", 409);
    if (!proposalAllowed(proposal.mode, proposal.file)) {
      throw new WorkspaceError("The preview isn't for a file Claude may edit.", 400);
    }
    const dir = workspaceDir(key);
    const target = inside(dir, proposal.file);
    if (!existsSync(target)) throw new WorkspaceError(`${proposal.file} no longer exists.`, 409);
    const normalised = content.replace(/\r\n/g, "\n");
    await fs.writeFile(target, normalised.endsWith("\n") ? normalised : `${normalised}\n`);
    await clearProposal(key);
    await logAppliedChange(key, {
      command: { generate: "page:generate", markdown: "md:edit" }[proposal.mode] ?? "page:edit",
      file: proposal.file,
      instruction: proposal.instruction || (proposal.mode === "generate" ? "turned the draft into the finished page" : ""),
    });
    return { file: proposal.file };
  } finally {
    release();
  }
}

/* ------------------------------------------------------------ page source */

// The markdown of one page, for writing a draft by hand before Claude turns it
// into the finished page. `version` is a hash of the content: a save must name
// the version it was based on, so it can't silently replace a newer file (one
// Claude wrote in the meantime, say).

const contentVersion = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function pageFile(key, file) {
  if (typeof file !== "string" || !MARKDOWN_PAGE.test(file) || file.split("/").includes("..")) {
    throw new WorkspaceError("Pick a page: a .md file under content/.", 400);
  }
  return inside(workspaceDir(key), file);
}

export async function readPage(key, file) {
  const content = await readText(pageFile(key, file));
  if (content === null) throw new WorkspaceError(`${file} doesn't exist.`, 404);
  return { file, content, version: contentVersion(content) };
}

export async function savePage(key, file, content, version) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new WorkspaceError("The page content is missing or too large.", 400);
  }
  if (typeof version !== "string") throw new WorkspaceError("Reload the page, then save again.", 400);
  const target = pageFile(key, file);
  const release = acquire(key, `saving ${file}`);
  try {
    const current = await readText(target);
    if (current === null) throw new WorkspaceError(`${file} no longer exists.`, 409);
    if (contentVersion(current) !== version) {
      throw new WorkspaceError(`${file} changed since you opened it. Copy your text, reload the page and save again.`, 409);
    }
    const normalised = content.replace(/\r\n/g, "\n");
    await fs.writeFile(target, normalised.endsWith("\n") ? normalised : `${normalised}\n`);
  } finally {
    release();
  }
  return readPage(key, file);
}

/* ----------------------------------------------------------------- images */

export const IMAGE_PATH = /^assets\/img\/[\w./-]+\.(png|jpe?g|gif|webp)$/i;
const UPLOAD_DIR = "assets/img/uploads";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Detects the real type from the file's first bytes; the browser's claim isn't trusted. */
function sniffImage(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** Image files already in the site (under assets/img/) that Claude can use. */
export async function listImages(key) {
  const dir = path.join(workspaceDir(key), "assets/img");
  const files = [];
  for (const extension of Object.keys(IMAGE_TYPES)) {
    for (const file of await listFiles(dir, `.${extension}`)) files.push(`assets/img/${file}`);
  }
  return [...new Set(files)].sort();
}

/** Saves an uploaded image into the site at assets/img/uploads/, so the page can show it. */
export async function saveUpload(key, { name, data }) {
  if (typeof data !== "string" || !data) throw new WorkspaceError("No image data received.", 400);
  const buffer = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
  if (!buffer.length) throw new WorkspaceError("No image data received.", 400);
  if (buffer.length > MAX_IMAGE_BYTES) throw new WorkspaceError("Images must be 5 MB or smaller.", 400);
  const type = sniffImage(buffer);
  if (!type) throw new WorkspaceError("Only PNG, JPEG, GIF and WebP images can be uploaded.", 400);

  const base =
    String(name ?? "")
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image";

  const release = acquire(key, "saving an image");
  try {
    const dir = path.join(workspaceDir(key), UPLOAD_DIR);
    await fs.mkdir(dir, { recursive: true });
    let file = `${base}.${type}`;
    for (let n = 2; existsSync(path.join(dir, file)); n++) file = `${base}-${n}.${type}`;
    await fs.writeFile(path.join(dir, file), buffer);
    return { path: `${UPLOAD_DIR}/${file}` };
  } finally {
    release();
  }
}

/** For thumbnails in the UI: an image under assets/img/ with its content type. */
export async function readImage(key, relative) {
  if (typeof relative !== "string" || !IMAGE_PATH.test(relative) || relative.split("/").includes("..")) {
    throw new WorkspaceError("Not an image in this site.", 404);
  }
  const file = inside(workspaceDir(key), relative);
  if (!existsSync(file)) throw new WorkspaceError("Image not found.", 404);
  const extension = relative.split(".").at(-1).toLowerCase();
  return { file, type: IMAGE_TYPES[extension] };
}

/* --------------------------------------------------------------- schedule */

// Mirrors scaffold-schedule.js: the job list is the one ```json fence whose
// content is an array, and hand edits may contain raw line breaks inside
// strings or trailing commas.

function findJobsBlock(text) {
  for (const match of text.matchAll(JSON_BLOCK)) {
    if (match[1].trim().startsWith("[")) return match;
  }
  return null;
}

function sanitizeHandEditedJson(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\t") {
        out += "\\t";
      } else if (ch !== "\r") {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

export async function readSchedule(key) {
  const text = await readText(path.join(workspaceDir(key), SCHEDULE_FILE));
  if (text === null) return { path: SCHEDULE_FILE, jobs: [], error: `${SCHEDULE_FILE} doesn't exist yet.` };
  const match = findJobsBlock(text);
  if (!match) return { path: SCHEDULE_FILE, jobs: [], error: "No ```json job list found in the file." };
  try {
    return { path: SCHEDULE_FILE, jobs: JSON.parse(sanitizeHandEditedJson(match[1])), error: null };
  } catch (err) {
    return { path: SCHEDULE_FILE, jobs: [], error: `Couldn't parse the job list: ${err.message}` };
  }
}

const REQUIRED_JOB_FIELDS = ["location", "title", "date"];

export async function writeSchedule(key, jobs) {
  if (!Array.isArray(jobs) || jobs.some((job) => !job || typeof job !== "object" || Array.isArray(job))) {
    throw new WorkspaceError("Jobs must be a list of objects.", 400);
  }
  for (const [index, job] of jobs.entries()) {
    const missing = REQUIRED_JOB_FIELDS.filter((field) => typeof job[field] !== "string" || !job[field].trim());
    if (!job.source && (typeof job.description !== "string" || !job.description.trim())) missing.push("description");
    if (missing.length) throw new WorkspaceError(`Job ${index + 1} is missing ${missing.join(", ")}.`, 400);
    if (Number.isNaN(new Date(job.date).getTime())) throw new WorkspaceError(`Job ${index + 1} has an invalid date.`, 400);
  }

  const release = acquire(key, `saving ${SCHEDULE_FILE}`);
  try {
    const file = path.join(workspaceDir(key), SCHEDULE_FILE);
    const text = (await readText(file)) ?? "# Scaffold schedule\n";
    const newline = text.indexOf("\n") > 0 && text[text.indexOf("\n") - 1] === "\r" ? "\r\n" : "\n";
    const block = ("```json\n" + JSON.stringify(jobs, null, 2) + "\n```").replace(/\n/g, newline);
    const match = findJobsBlock(text);
    const updated = match
      ? text.slice(0, match.index) + block + text.slice(match.index + match[0].length)
      : `${text}${newline}${newline}${block}${newline}`;
    if (Buffer.byteLength(updated) > MAX_FILE_BYTES) throw new WorkspaceError("The schedule is too large.", 400);
    await fs.writeFile(file, updated);
  } finally {
    release();
  }
  return readSchedule(key);
}
