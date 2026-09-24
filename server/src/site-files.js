import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// Reads and writes the site's own data files. Everything here parses files
// directly; repo code is never imported into the server process.

const MAX_FILE_BYTES = 512 * 1024;
const SCHEDULE_FILE = "scripts/scaffold-schedule.md";
const JSON_BLOCK = /```json\r?\n([\s\S]*?)\r?\n```/g;

/** Files the web UI may read and replace whole, with a validator for each. */
const DATA_FILES = {
  "site-tree": { path: "scripts/site-tree.md", validate: () => {} },
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

  return {
    site: { name: site.name, url: site.url, model: site.automation?.model ?? null },
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
