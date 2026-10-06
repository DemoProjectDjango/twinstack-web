import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { toFile } from "@anthropic-ai/sdk";
import { sniffImage } from "../site-files.js";
import { WorkspaceError, acquire, workspaceDir } from "../workspace.js";

// Files the owner attaches to an "Ask Claude" message. Any type is accepted. Each is kept with the
// site's working copy, inside .git so it's never a change to the site, and sent to Claude once
// through the Files API, so the conversation refers to it by id: the stored history stays small
// and the bytes Claude saw can't change under it. Claude reads images, PDFs, text files (HTML,
// CSS, Markdown, CSV, JSON…) and Word documents (their text); any file can be added to the site.

const DIR = ".git/twinstack-assistant";
const ID = /^att_[a-f0-9]{16}$/;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Claude's own limit for an image.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Text larger than this is attached as a file Claude can't read, rather than flooding the context.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DOCX_TEXT_CHARS = 400_000;

const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_MIME = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  csv: "text/csv",
  txt: "text/plain",
  xml: "application/xml",
  svg: "image/svg+xml",
};

const dirOf = (key) => path.join(workspaceDir(key), DIR);
const extensionOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").toLowerCase();

/** A file name that's safe to show and to store: no folders, no control characters. */
function cleanName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "file").slice(0, 120);
}

/** Whether the bytes look like UTF-8 text (no NUL bytes, decodes cleanly). */
function looksLikeText(buffer) {
  let sample = buffer.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  if (sample.length < buffer.length) {
    // Don't judge a character cut in half at the end of the sample.
    let end = sample.length;
    while (end > 0 && sample[end - 1] >= 0x80) end--;
    sample = sample.subarray(0, end);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------- Word (.docx) text */

// A .docx file is a zip; its text is in word/document.xml. Just enough of a zip reader to get that
// one entry, with the size checked before inflating so a crafted file can't blow up memory.
function zipEntry(buffer, wanted) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count && at + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    // Some zip tools write Windows separators.
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    if (name === wanted) {
      if (size > 50 * 1024 * 1024 || buffer.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: size });
      return null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The text of a Word document, paragraph by paragraph, or null if it isn't one. */
export function docxText(buffer) {
  let xml;
  try {
    xml = zipEntry(buffer, "word/document.xml")?.toString("utf8");
  } catch {
    return null;
  }
  if (!xml) return null;
  const text = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>|<w:cr\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e])
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, n) => String.fromCodePoint(parseInt(n, hex ? 16 : 10)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, MAX_DOCX_TEXT_CHARS);
}

/* ------------------------------------------------------------- storing */

/**
 * What a file is, for Claude: "image" (it sees it), "pdf", "text" (any UTF-8 text file),
 * "document" (a Word file, read as its text) or "file" (anything else: it can't be read, but it
 * can still be put on the site).
 */
function classify(name, buffer) {
  const image = sniffImage(buffer);
  if (image) return buffer.length <= MAX_IMAGE_BYTES ? { kind: "image", mime: IMAGE_MIME[image] } : { kind: "file", mime: IMAGE_MIME[image], note: "too large for Claude to look at (over 5 MB)" };
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  const ext = extensionOf(name);
  if (ext === "docx" && buffer.subarray(0, 2).toString("latin1") === "PK") {
    const text = docxText(buffer);
    if (text) return { kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text };
  }
  if (looksLikeText(buffer)) {
    if (buffer.length <= MAX_TEXT_BYTES) return { kind: "text", mime: TEXT_MIME[ext] ?? "text/plain" };
    return { kind: "file", mime: TEXT_MIME[ext] ?? "text/plain", note: "too long for Claude to read (over 2 MB of text)" };
  }
  return { kind: "file", mime: "application/octet-stream" };
}

const publicMeta = ({ id, name, kind, mime, size, note }) => ({ id, name, kind, mime, size, note: note ?? null });

/** Saves an attached file ({ name, data: base64 }) and returns what the browser shows for it. */
export async function saveAttachment(key, { name, data }) {
  if (typeof data !== "string" || !data) throw new WorkspaceError("No file data received.", 400);
  const buffer = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
  if (!buffer.length) throw new WorkspaceError("The file is empty.", 400);
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new WorkspaceError("Files can be up to 10 MB.", 400);
  const clean = cleanName(name);
  const { text, ...type } = classify(clean, buffer);
  const id = `att_${randomBytes(8).toString("hex")}`;
  const meta = { id, name: clean, ...type, size: buffer.length, fileId: null, createdAt: new Date().toISOString() };

  const dir = dirOf(key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, id), buffer);
  if (text !== undefined) await fs.writeFile(path.join(dir, `${id}.txt`), text);
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(meta));
  return { meta, publicMeta: publicMeta(meta) };
}

export async function readAttachmentMeta(key, id) {
  if (typeof id !== "string" || !ID.test(id)) throw new WorkspaceError("Unknown attachment.", 404);
  try {
    return JSON.parse(await fs.readFile(path.join(dirOf(key), `${id}.json`), "utf8"));
  } catch {
    throw new WorkspaceError("That attachment is gone. Attach the file again.", 404);
  }
}

/** The attachment's bytes, and its file on disk (for sending it to the browser). */
export async function readAttachment(key, id) {
  const meta = await readAttachmentMeta(key, id);
  const file = path.join(dirOf(key), id);
  return { meta, file, bytes: await fs.readFile(file) };
}

export { publicMeta as attachmentView };

/* ------------------------------------------------------ giving it to Claude */

/** Uploads the attachment to the Files API once (what Claude reads: the image, the PDF, the text). */
export async function ensureUploaded(client, key, meta) {
  if (meta.fileId || meta.kind === "file") return meta;
  const dir = dirOf(key);
  const bytes = meta.kind === "document" ? await fs.readFile(path.join(dir, `${meta.id}.txt`)) : await fs.readFile(path.join(dir, meta.id));
  // Claude reads text documents as plain text, whatever their kind (HTML, CSV, a Word file's text).
  const type = meta.kind === "image" || meta.kind === "pdf" ? meta.mime : "text/plain";
  const name = meta.kind === "document" || meta.kind === "text" ? `${meta.name}.txt` : meta.name;
  const uploaded = await client.files.upload({ file: await toFile(bytes, name, { type }) });
  const next = { ...meta, fileId: uploaded.id };
  await fs.writeFile(path.join(dir, `${meta.id}.json`), JSON.stringify(next));
  return next;
}

/** The content block that shows Claude an attachment, or null for a file it can't read. */
export function attachmentBlock(meta) {
  if (!meta.fileId) return null;
  if (meta.kind === "image") return { type: "image", source: { type: "file", file_id: meta.fileId } };
  return { type: "document", source: { type: "file", file_id: meta.fileId }, title: meta.name };
}

const sizeLabel = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const KIND_LABEL = { image: "image", pdf: "PDF", text: "text file", document: "Word document (its text is attached)", file: "file" };

/** One line per attachment for the message: the id Claude passes to tools, and what it is. */
export function describeAttachment(meta) {
  const readable = meta.kind === "file" ? `you can't read it${meta.note ? `: ${meta.note}` : ""}, but it can be added to the site` : "attached below";
  return `${meta.id}: ${meta.name} (${KIND_LABEL[meta.kind]}, ${sizeLabel(meta.size)}; ${readable})`;
}

/** Removes a conversation's attachments: the copies here and the uploads to the Files API. Never throws. */
export async function deleteAttachments(client, key, ids) {
  for (const id of ids) {
    try {
      const meta = await readAttachmentMeta(key, id);
      if (meta.fileId && client) await client.files.delete(meta.fileId).catch(() => {});
      const dir = dirOf(key);
      await Promise.all([id, `${id}.json`, `${id}.txt`].map((f) => fs.rm(path.join(dir, f), { force: true })));
    } catch {
      // Already gone.
    }
  }
}

/* ------------------------------------------------------- onto the site */

const IMAGE_DIR = "assets/img/uploads";
const FILE_DIR = "assets/files";

function siteName(name, fallback) {
  const ext = extensionOf(name);
  const base =
    name
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback;
  return { base, ext: ext.replace(/[^a-z0-9]/g, "") };
}

/** Where an attachment would go in the site: images with the site's uploads, anything else under assets/files/. */
export function sitePathFor(meta, wanted) {
  // The site shows PNG, JPEG, GIF and WebP from its uploads folder; anything else is a file to link to.
  const isImage = Object.values(IMAGE_MIME).includes(meta.mime);
  const { base, ext } = siteName(cleanName(wanted || meta.name), isImage ? "image" : "file");
  const extension = isImage ? { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[meta.mime] : ext || "bin";
  return { dir: isImage ? IMAGE_DIR : FILE_DIR, base, extension };
}

/** Copies an attachment into the site (a change like any other); returns its path in the repo. */
export async function addAttachmentToSite(key, id, wanted) {
  const { meta, bytes } = await readAttachment(key, id);
  const { dir, base, extension } = sitePathFor(meta, wanted);
  const release = acquire(key, "adding a file to the site");
  try {
    const target = path.join(workspaceDir(key), dir);
    await fs.mkdir(target, { recursive: true });
    let file = `${base}.${extension}`;
    for (let n = 2; existsSync(path.join(target, file)); n++) file = `${base}-${n}.${extension}`;
    await fs.writeFile(path.join(target, file), bytes);
    return `${dir}/${file}`;
  } finally {
    release();
  }
}
