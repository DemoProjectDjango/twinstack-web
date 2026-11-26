import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { inside } from "./site-files.js";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// Upload a website (.zip): a whole website's files, brought into a site the way an imported
// repository's are. The zip comes in pieces (the server in front takes 16 MB a request), is
// unpacked here with strict limits, and its pages land at their own addresses in the repository's
// root, where original-pages.js lists them for "Bring in all"; every other file goes under static/,
// which the build publishes at the site's root, so /assets/img/logo.png keeps its address without
// touching the template's own assets/ folder. Nothing the site already has is overwritten, and
// every file left out is reported with its reason. All of it is ordinary unpublished changes.

const ZIP_DIR = ".git/twinstack-zip";
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
// A file that unpacks to this many times its packed size is a zip bomb, not a website.
const MAX_RATIO = 200;
const UPLOAD_ID = /^[a-z0-9]{16,32}$/;

// The repository's own folders: a page there isn't an old page of the site, and a file there would
// mix with the template's.
const RESERVED = new Set(["node_modules", "dist", "content", "templates", "scripts", "styles", "static", "assets", "knowledge", "public"]);
// What a website is made of.
const ALLOWED = new Set([
  "html", "htm", "css", "js", "mjs", "json", "map", "xml", "txt", "webmanifest", "ics", "vcf", "csv",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp",
  "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "mp4", "webm", "mp3", "ogg", "wav", "vtt",
]);
// Made by the build: a file of the old site at one of these addresses would be replaced or replace it.
const BUILT = new Set(["sitemap.xml", "rss.xml", "robots.txt", "search-index.json", "agent-index.json", "CNAME", "_redirects", "404.html"]);

/** One piece of an upload, in order. `index` 0 starts it; returns the bytes received so far. */
export async function receiveZipChunk(key, { id, index, data }) {
  if (typeof id !== "string" || !UPLOAD_ID.test(id)) throw new WorkspaceError("That upload isn't one this site started.", 400);
  if (!Number.isInteger(index) || index < 0) throw new WorkspaceError("A piece of the upload came without its place.", 400);
  if (typeof data !== "string" || !data) throw new WorkspaceError("A piece of the upload was empty.", 400);
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_CHUNK_BYTES) throw new WorkspaceError("A piece of the upload was the wrong size.", 400);
  const dir = path.join(workspaceDir(key), ZIP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.zip`);
  const stateFile = path.join(dir, `${id}.json`);
  const state = index === 0 ? { next: 0, bytes: 0 } : JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "null") ?? "null");
  if (!state || state.next !== index) throw new WorkspaceError("Pieces of the upload arrived out of order. Upload the zip again.", 409);
  if (state.bytes + bytes.length > MAX_ZIP_BYTES) throw new WorkspaceError(`The zip is over ${MAX_ZIP_BYTES / 1024 / 1024} MB.`, 413);
  if (index === 0) await fs.writeFile(file, bytes);
  else await fs.appendFile(file, bytes);
  const next = { next: index + 1, bytes: state.bytes + bytes.length };
  await fs.writeFile(stateFile, JSON.stringify(next));
  return { received: next.bytes };
}

/** A zip entry's name as a safe path inside the website, or null to leave it out (with why). */
function entryPath(raw) {
  const name = String(raw).replace(/\\/g, "/");
  if (name.endsWith("/")) return { skip: null };
  if (/^\/|^[a-z]:/i.test(name) || name.split("/").includes("..")) return { skip: "its path leads outside the website" };
  const parts = name.split("/").filter((p) => p && p !== ".");
  if (!parts.length) return { skip: null };
  if (parts[0] === "__MACOSX" || parts.some((p) => p.startsWith(".")) || /^(Thumbs\.db|desktop\.ini)$/i.test(parts.at(-1))) return { skip: null };
  return { parts };
}

/**
 * Unpacks the uploaded zip into the site: pages at their addresses, other files under static/.
 * Returns { pages: [address], files, replaced (earlier versions of its files), skipped: [{ name, reason }] }.
 */
export async function importZip(key, { id, name }) {
  if (typeof id !== "string" || !UPLOAD_ID.test(id)) throw new WorkspaceError("That upload isn't one this site started.", 400);
  const root = workspaceDir(key);
  const dir = path.join(root, ZIP_DIR);
  const zipFile = path.join(dir, `${id}.zip`);
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : "the zip";
  let packed;
  try {
    packed = await fs.readFile(zipFile);
  } catch {
    throw new WorkspaceError("The upload isn't there any more. Upload the zip again.", 409);
  }
  const skipped = [];
  const skip = (entry, reason) => skipped.length < 200 && skipped.push({ name: String(entry).slice(0, 200), reason });
  let count = 0;
  let total = 0;
  let files;
  try {
    // The sizes are checked before anything is unpacked, from what each entry says it holds.
    files = unzipSync(new Uint8Array(packed), {
      filter: (entry) => {
        const where = entryPath(entry.name);
        if (!where.parts) {
          if (where.skip) skip(entry.name, where.skip);
          return false;
        }
        const ext = path.posix.extname(entry.name).slice(1).toLowerCase();
        if (!ALLOWED.has(ext)) return skip(entry.name, `.${ext || "?"} files aren't part of a website here`), false;
        if (entry.originalSize > MAX_FILE_BYTES) return skip(entry.name, `it's over ${MAX_FILE_BYTES / 1024 / 1024} MB`), false;
        if (entry.size > 0 && entry.originalSize / entry.size > MAX_RATIO) return skip(entry.name, "it unpacks to far more than its size"), false;
        if (count >= MAX_FILES) return skip(entry.name, `the zip has more than ${MAX_FILES} files`), false;
        if (total + entry.originalSize > MAX_TOTAL_BYTES) return skip(entry.name, `the files add up to over ${MAX_TOTAL_BYTES / 1024 / 1024} MB`), false;
        count += 1;
        total += entry.originalSize;
        return true;
      },
    });
  } catch (err) {
    throw new WorkspaceError(`${label} couldn't be opened as a zip (${String(err.message).slice(0, 80)}). Make it again with your computer's "Compress" and upload that.`, 400);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // One folder around everything ("my-site/index.html") is the zip's, not the website's.
  const entries = Object.entries(files).map(([entry, bytes]) => ({ parts: entryPath(entry).parts, bytes, entry }));
  const tops = new Set(entries.map((e) => (e.parts.length > 1 ? e.parts[0] : "")));
  if (tops.size === 1 && !tops.has("") && !entries.some((e) => /\.html?$/i.test(e.parts[0]))) for (const e of entries) e.parts = e.parts.slice(1);

  const pages = [];
  let written = 0;
  let replaced = 0;
  const release = acquire(key, "adding the website's files");
  try {
    for (const { parts, bytes, entry } of entries) {
      if (!parts.length) continue;
      if (bytes.length > MAX_FILE_BYTES) {
        skip(entry, `it's over ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        continue;
      }
      const rel = parts.join("/");
      const page = /\.html?$/i.test(rel) && !RESERVED.has(parts[0]) && !BUILT.has(rel);
      // A page stays at its address (original-pages.js brings it in); anything else is published
      // as it is from static/, at the same address.
      const target = page ? rel : `static/${rel}`;
      if (!page && (BUILT.has(rel) || (parts[0] === "assets" && existsSync(path.join(root, rel))))) {
        skip(entry, "your site already has its own file at that address");
        continue;
      }
      // A newer upload of the website replaces its own earlier files (static/ is the site's own
      // area); the template's and the build's files were refused above.
      const full = inside(root, target);
      if (existsSync(full)) replaced += 1;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, bytes);
      written += 1;
      if (page) pages.push(`/${rel}`.replace(/\.htm$/i, ".html").replace(/(^|\/)index\.html$/, "$1"));
    }
  } finally {
    release();
  }
  if (!written) throw new WorkspaceError(`Nothing in ${label} could be added${skipped.length ? `: ${skipped[0].reason}` : ""}.`, 400);
  if (!pages.length) throw new WorkspaceError(`${label} has no web pages (.html files), so there's nothing to bring in. Its other files were added.`, 400);
  return { pages: pages.sort(), files: written, replaced, skipped };
}

/** A new upload's id. */
export const newZipUpload = () => ({ id: randomBytes(12).toString("hex") });
