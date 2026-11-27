import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// The site's logo, kept in site.config.json → brand and used by the copy's header, footer and
// <head>: logo (the full logo, in place of the mark and name), logoDark (for the dark footer),
// logoMark (the small square mark shown beside the name when there's no logo), favicon (the
// browser-tab icon; the mark when empty) and logoText (the name, and the logo's alt text).
// Uploaded files go to assets/img/brand/.

const CONFIG = "site.config.json";
const BRAND_DIR = "assets/img/brand";
const IMAGE_FIELDS = ["logo", "logoDark", "logoMark", "favicon"];
// Fields older copies' templates don't read: their header and footer only know logoMark.
const NEWER_FIELDS = ["logo", "logoDark", "favicon"];
const BRAND_IMAGE = /^\/assets\/img\/[\w./-]+\.(png|jpe?g|gif|webp|svg|ico)$/i;
const MAX_BYTES = 2 * 1024 * 1024;
// Small enough to send back as previews for the web UI.
const MAX_PREVIEW_BYTES = 512 * 1024;
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon" };

/** The image type from the file's first bytes (an SVG from its markup); the browser's claim isn't trusted. */
function sniff(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "ico";
  const head = buffer.subarray(0, 2048).toString("utf8").replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg\b/i.test(head)) return "svg";
  return null;
}

/** Why an SVG can't be used (it could run script where it's shown), or null. */
function unsafeSvg(text) {
  if (/<script\b/i.test(text)) return "it contains a script";
  if (/<(foreignObject|iframe|embed|object)\b/i.test(text)) return "it embeds other content";
  if (/\son[a-z]+\s*=/i.test(text)) return "it has event handlers";
  if (/javascript:/i.test(text)) return "it contains a javascript: link";
  return null;
}

async function readConfig(dir) {
  let text;
  try {
    text = await fs.readFile(path.join(dir, CONFIG), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new WorkspaceError(`${CONFIG} is missing.`, 422);
    throw err;
  }
  try {
    return { text, data: JSON.parse(text) };
  } catch (err) {
    throw new WorkspaceError(`${CONFIG} isn't valid JSON (${err.message}). Fix it in the repository first.`, 422);
  }
}

/**
 * What the web UI shows as an image's preview: a data: URL of a site image (null if it's missing or
 * large), or the address itself for an image on the web (a favicon on a CDN, say).
 */
async function preview(dir, src) {
  if (typeof src === "string" && /^https:\/\/[^\s"'<>]+$/i.test(src)) return src;
  if (typeof src !== "string" || !BRAND_IMAGE.test(src) || src.split("/").includes("..")) return null;
  const file = path.join(dir, src.slice(1));
  try {
    const buffer = await fs.readFile(file);
    if (buffer.length > MAX_PREVIEW_BYTES) return null;
    const type = sniff(buffer);
    if (!type || (type === "svg" && unsafeSvg(buffer.toString("utf8")))) return null;
    return `data:${TYPES[type]};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The brand settings, with previews. `supported` is false for copies whose
 * templates predate the logo, favicon and dark-footer fields (only the mark
 * and name show there).
 */
// A header the AI designed (data-designed="claude") or copied from an old page or website
// (data-designed="copied") draws its own logo: an <img> in its HTML, not site.config.json's brand.
// So the logo it shows is found there (the first image before its menu, usually a link home), and
// "Replace" changes that image in the header and the footer instead of brand.logo, which such a
// header never reads.
const HEADER = "templates/partials/header.html";
const FOOTER = "templates/partials/footer.html";
const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/i;

/** The logo a designed or copied header draws: `{ src, alt, designed }`, or null. */
export function headerLogoOf(header) {
  const designed = /data-designed\s*=\s*["'](claude|copied)["']/i.exec(header)?.[1] ?? null;
  if (!designed) return null;
  // The logo: a picture marked as one (its class, alt text or file name says "logo"), else one inside
  // a link to the homepage, else the first picture before the menu, else the first picture.
  const visible = header.replace(/<template\b[\s\S]*?<\/template\s*>/gi, "");
  const pictures = [...visible.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi)];
  const nav = visible.search(/<nav\b|<ul\b/i);
  const homeLink = (m) => {
    const before = visible.slice(0, m.index);
    const a = before.lastIndexOf("<a ");
    return a >= 0 && before.lastIndexOf("</a>") < a && /\bhref\s*=\s*["'](?:\/|\/index\.html|\{\{[^}]*\}\}\/?|https?:\/\/[^"'/]+\/?)["']/i.test(before.slice(a, a + 300));
  };
  const img =
    pictures.find((m) => /logo/i.test(m[0])) ??
    pictures.find(homeLink) ??
    pictures.find((m) => nav < 0 || m.index < nav) ??
    pictures[0];
  if (!img) return null;
  const alt = /\balt\s*=\s*(["'])([^"']*)\1/i.exec(img[0])?.[2] ?? "";
  return { src: img[2], alt, designed };
}

/**
 * Makes Look & logo's logo the one a copied header draws, while the site has none of its own
 * (`brand.logo` empty): a copied header shows its picture by itself, but a header designed later
 * (a redesign, "Design with the AI") reads `site.brand.logo`, and without this it would show the
 * placeholder name instead of the business's logo. For a caller that already holds the workspace's
 * lock (the copy's finish, a command's prepare). Returns the logo it set, or null. Never throws.
 */
export async function adoptHeaderLogo(dir) {
  try {
    const header = await fs.readFile(path.join(dir, HEADER), "utf8").catch(() => "");
    const logo = headerLogoOf(header);
    if (logo?.designed !== "copied") return null;
    const src = decodeURIComponent(logo.src.split(/[?#]/)[0]);
    if (!BRAND_IMAGE.test(src) || src.split("/").includes("..") || !existsSync(path.join(dir, src.slice(1)))) return null;
    const { text, data } = await readConfig(dir);
    if (typeof data.brand?.logo === "string" && data.brand.logo.trim()) return null;
    const brand = { ...(data.brand ?? {}), logo: src };
    const merged = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === "brand" ? brand : v]));
    if (!("brand" in data)) merged.brand = brand;
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    await fs.writeFile(path.join(dir, CONFIG), `${JSON.stringify(merged, null, 2)}\n`.replace(/\n/g, newline));
    return src;
  } catch {
    return null;
  }
}

/** A site address or a web address for an image in a partial ("{{ site.url }}/…" and data: aren't). */
const plainSrc = (src) => /^\/assets\/img\/[\w./-]+$/i.test(src) || /^https?:\/\/[^\s"'<>{}]+$/i.test(src);

/**
 * Puts `next` (an image under assets/img/ that exists) in place of the designed header's logo, in
 * the header and wherever the footer uses the same image. Returns getBrand's result.
 */
export async function replaceHeaderLogo(key, next) {
  if (typeof next !== "string" || !BRAND_IMAGE.test(next) || next.split("/").includes("..")) throw new WorkspaceError("Choose an image under assets/img/.", 400);
  const release = acquire(key, "changing the logo in the header");
  try {
    const dir = workspaceDir(key);
    if (!existsSync(path.join(dir, next.slice(1)))) throw new WorkspaceError(`${next} doesn't exist. Upload it again.`, 400);
    const header = await fs.readFile(path.join(dir, HEADER), "utf8").catch(() => "");
    const logo = headerLogoOf(header);
    if (!logo) throw new WorkspaceError("The header doesn't draw a logo of its own.", 409);
    if (!plainSrc(logo.src)) throw new WorkspaceError("The header's logo is set in a way this screen can't change. Ask the AI to change it.", 409);
    const swap = (text) => text.split(`"${logo.src}"`).join(`"${next}"`).split(`'${logo.src}'`).join(`'${next}'`);
    await fs.writeFile(path.join(dir, HEADER), swap(header));
    const footer = await fs.readFile(path.join(dir, FOOTER), "utf8").catch(() => null);
    if (footer !== null && footer.includes(logo.src)) await fs.writeFile(path.join(dir, FOOTER), swap(footer));
  } finally {
    release();
  }
  return getBrand(key);
}

export async function getBrand(key) {
  const dir = workspaceDir(key);
  const { data } = await readConfig(dir);
  const brand = data.brand ?? {};
  const header = await fs.readFile(path.join(dir, HEADER), "utf8").catch(() => "");
  const drawn = headerLogoOf(header);
  const previews = {};
  for (const field of IMAGE_FIELDS) previews[field] = await preview(dir, brand[field]);
  return {
    brand: {
      logoText: typeof brand.logoText === "string" ? brand.logoText : "",
      ...Object.fromEntries(IMAGE_FIELDS.map((f) => [f, typeof brand[f] === "string" ? brand[f] : ""])),
    },
    previews,
    // Newer headers pick the logo for their background through nav.appearance (scripts/lib/content.js).
    supported: header.includes("site.brand.logo }}") || header.includes("nav.appearance.header.logo"),
    // The logo a designed or copied header draws itself, with a preview and whether it can be replaced here.
    headerLogo: drawn ? { ...drawn, preview: await preview(dir, drawn.src), replaceable: plainSrc(drawn.src) } : null,
  };
}

/** A preview (data: URL, or null) of a site image in the key's workspace, for other screens (the site agent's icon). */
export async function imagePreview(key, src) {
  return preview(workspaceDir(key), src);
}

/** Saves an uploaded logo file to assets/img/brand/ and returns its site path and a preview. */
export async function saveBrandImage(key, { name, data }) {
  if (typeof data !== "string" || !data) throw new WorkspaceError("No image received.", 400);
  const buffer = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
  if (!buffer.length) throw new WorkspaceError("No image received.", 400);
  if (buffer.length > MAX_BYTES) throw new WorkspaceError("Logo files must be 2 MB or smaller.", 400);
  const type = sniff(buffer);
  if (!type) throw new WorkspaceError("Upload a PNG, JPEG, GIF, WebP, SVG or ICO image.", 400);
  if (type === "svg") {
    const problem = unsafeSvg(buffer.toString("utf8"));
    if (problem) throw new WorkspaceError(`That SVG can't be used: ${problem}. Export it again without scripts, or use a PNG.`, 400);
  }
  const base =
    String(name ?? "")
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "logo";

  const release = acquire(key, "saving a logo");
  try {
    const dir = path.join(workspaceDir(key), BRAND_DIR);
    await fs.mkdir(dir, { recursive: true });
    let file = `${base}.${type}`;
    for (let n = 2; existsSync(path.join(dir, file)); n++) file = `${base}-${n}.${type}`;
    await fs.writeFile(path.join(dir, file), buffer);
    const src = `/${BRAND_DIR}/${file}`;
    return { path: src, preview: await preview(workspaceDir(key), src) };
  } finally {
    release();
  }
}

/**
 * Saves the brand settings into site.config.json → brand, keeping its other
 * fields, their order and the file's line endings. Each image is "" (not set;
 * the mark can't be) or a file under assets/img/ that exists.
 */
export async function saveBrand(key, next) {
  if (next === null || typeof next !== "object" || Array.isArray(next)) throw new WorkspaceError("Nothing to save.", 400);
  const release = acquire(key, `saving the logo in ${CONFIG}`);
  try {
    const dir = workspaceDir(key);
    const { text, data } = await readConfig(dir);
    const brand = { ...(data.brand ?? {}) };
    if ("logoText" in next) {
      if (typeof next.logoText !== "string" || !next.logoText.trim() || next.logoText.length > 80) {
        throw new WorkspaceError("The name must be 1 to 80 characters.", 400);
      }
      brand.logoText = next.logoText.trim();
    }
    for (const field of IMAGE_FIELDS) {
      if (!(field in next)) continue;
      const value = next[field];
      if (value === "" && field !== "logoMark") {
        brand[field] = "";
        continue;
      }
      if (typeof value !== "string" || !BRAND_IMAGE.test(value) || value.split("/").includes("..")) {
        throw new WorkspaceError(`${field} must be an image under assets/img/.`, 400);
      }
      if (!existsSync(path.join(dir, value.slice(1)))) throw new WorkspaceError(`${value} doesn't exist. Upload it again.`, 400);
      brand[field] = value;
    }
    // Keep the file's own field order; new fields go after logoText the way the template has them.
    const ordered = {};
    for (const [k, v] of Object.entries(brand)) {
      ordered[k] = v;
      if (k === "logoText") for (const f of NEWER_FIELDS) if (!(f in (data.brand ?? {})) && f in brand) ordered[f] = brand[f];
    }
    const merged = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === "brand" ? ordered : v]));
    if (!("brand" in data)) merged.brand = ordered;
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    await fs.writeFile(path.join(dir, CONFIG), `${JSON.stringify(merged, null, 2)}\n`.replace(/\n/g, newline));
  } finally {
    release();
  }
  return getBrand(key);
}
