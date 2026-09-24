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

  // Copies made before edit-page.js learnt --image/--proposal-out can still run plain edits.
  const editScript = (await readText(path.join(dir, "scripts/edit-page.js"))) ?? "";

  return {
    site: { name: site.name, url: site.url, model: site.automation?.model ?? null },
    features: { pageEditImages: editScript.includes("--proposal-out") },
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

/* ------------------------------------------------------ Claude proposals */

// A "Preview change" run saves Claude's complete proposed file here (inside
// .git, so it never shows up as a change). Applying writes exactly that
// version, optionally edited by the user, without calling Claude again.
export const PROPOSAL_FILE = ".git/twinstack-proposal.json";
const MARKDOWN_PAGE = /^content\/[\w./-]+\.md$/;

export async function clearProposal(key) {
  await fs.rm(path.join(workspaceDir(key), PROPOSAL_FILE), { force: true });
}

/** The pending proposal, or null. */
export async function readProposal(key) {
  const text = await readText(path.join(workspaceDir(key), PROPOSAL_FILE));
  if (!text) return null;
  try {
    const proposal = JSON.parse(text);
    if (typeof proposal.file !== "string" || typeof proposal.content !== "string") return null;
    return {
      file: proposal.file,
      instruction: String(proposal.instruction ?? ""),
      images: Array.isArray(proposal.images) ? proposal.images.map(String) : [],
      content: proposal.content,
      problems: Array.isArray(proposal.problems) ? proposal.problems.map(String) : [],
      createdAt: proposal.createdAt ?? null,
    };
  } catch {
    return null;
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
    if (!MARKDOWN_PAGE.test(proposal.file) || proposal.file.split("/").includes("..")) {
      throw new WorkspaceError("The preview isn't for a page under content/.", 400);
    }
    const dir = workspaceDir(key);
    const target = inside(dir, proposal.file);
    if (!existsSync(target)) throw new WorkspaceError(`${proposal.file} no longer exists.`, 409);
    const normalised = content.replace(/\r\n/g, "\n");
    await fs.writeFile(target, normalised.endsWith("\n") ? normalised : `${normalised}\n`);
    await clearProposal(key);
    return { file: proposal.file };
  } finally {
    release();
  }
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
