import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sitePages } from "./navigation.js";
import { createPageAt, readSiteConfig, saveHtmlSource } from "./site-files.js";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// A repo that had the site tools added to it (import-site.js, "adopt") keeps its own .html pages
// where they were. The editor only knows pages under content/, so the Pages screen lists these
// "original pages" and brings each one in through the usual kept-styles conversion (page-convert):
// `prepareOriginalPage` saves the page and the stylesheets and scripts it links to as an upload
// would (saveHtmlSource) and makes the content page at the page's own address, so old links keep
// working. A page counts as brought in once the content page at its address uses a converted
// page's stylesheet (assets/css/imported/). The original files are never changed.

// The template's own folders and what the build writes: never an original page.
const NOT_ORIGINAL = new Set(["node_modules", "dist", "content", "templates", "scripts", "styles", "static", "assets", "knowledge"]);
const MAX_ORIGINAL_PAGES = 200;
const MAX_LINKED = 10;
const CONVERTED = "/assets/css/imported/";

/**
 * The address the page comes in at: where the repo file was published (index.html → "/",
 * blog/index.html → "/blog/"), except that an .htm page becomes .html, because the site builds
 * any other address as a folder. Its old address then redirects (`htmRedirect`).
 */
export const addressOfFile = (file) => `/${file}`.replace(/\.htm$/i, ".html").replace(/(^|\/)index\.html$/, "$1");

/** A page at static/<file> (the old .htm address) that sends visitors to the page's new address. */
function htmRedirect(file) {
  const target = encodeURI(path.posix.basename(addressOfFile(file)) || "./");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Moved</title><meta http-equiv="refresh" content="0; url=${target}"><link rel="canonical" href="${target}"><meta name="robots" content="noindex"></head>\n<body><p>This page has moved: <a href="${target}">${target}</a>.</p></body></html>\n`;
}
const sameAddress = (url) => url.replace(/(^|\/)index\.html$/, "$1");

async function htmlFiles(dir, rel = "") {
  const found = [];
  for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".") || (!rel && NOT_ORIGINAL.has(entry.name))) continue;
    const file = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await htmlFiles(dir, file)));
    else if (entry.isFile() && /\.html?$/i.test(entry.name)) found.push(file);
    if (found.length >= MAX_ORIGINAL_PAGES) break;
  }
  return found.slice(0, MAX_ORIGINAL_PAGES);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

/** Entity codes as the characters they stand for ("Pastries &amp; Cakes" → "Pastries & Cakes"). */
const decodeEntities = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === "#") {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

const titleOf = (html) =>
  decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;

// A page's header and footer as markup, roughly as the conversion finds them: the first <header>
// or <nav> element and the last <footer>, scripts, styles and spacing aside. Only to group pages
// that share them; the conversion itself decides exactly (edit-page.js ownChrome).
function chromeFingerprint(html) {
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const first = (pattern) => {
    const m = pattern.exec(body);
    if (!m) return "";
    const name = m[1].toLowerCase();
    const end = body.toLowerCase().indexOf(`</${name}>`, m.index);
    return end < 0 ? "" : body.slice(m.index, end);
  };
  const header = first(/<(header|nav)\b[^>]*>/i);
  const footerAt = body.toLowerCase().lastIndexOf("<footer");
  const footer = footerAt < 0 ? "" : body.slice(footerAt, body.toLowerCase().indexOf("</footer>", footerAt) + 1 || undefined);
  return `${header}\n${footer}`.replace(/\s+/g, " ").trim();
}

/**
 * The repo's own pages: `{ file, address, title, page, broughtIn, chromeSource }`. One page is the
 * `chromeSource`: the site's header and footer are copied from it (page-convert's withHeader and
 * withFooter), so it's the one whose header and footer most pages share, the homepage on a tie.
 * It comes first, because the others are compared with what it gave the site; the homepage next.
 */
export async function listOriginalPages(key) {
  const dir = workspaceDir(key);
  const pages = await sitePages(dir, await readSiteConfig(key));
  const list = [];
  const prints = new Map();
  for (const file of await htmlFiles(dir)) {
    const html = (await fs.readFile(path.join(dir, file), "utf8").catch(() => "")) ?? "";
    const address = addressOfFile(file);
    const page = pages.find((p) => sameAddress(p.url) === address) ?? null;
    const pageText = page ? await fs.readFile(path.join(dir, page.file), "utf8").catch(() => "") : "";
    list.push({ file, address, title: titleOf(html), page: page?.file ?? null, broughtIn: pageText.includes(CONVERTED), chromeSource: false });
    prints.set(file, chromeFingerprint(html));
  }
  const groups = new Map();
  for (const item of list) if (prints.get(item.file)) groups.set(prints.get(item.file), [...(groups.get(prints.get(item.file)) ?? []), item]);
  const home = list.find((p) => p.address === "/");
  const best = [...groups.values()].sort((a, b) => b.length - a.length || Number(b.includes(home)) - Number(a.includes(home)))[0];
  const source = best?.includes(home) ? home : best?.sort((a, b) => a.address.localeCompare(b.address))[0];
  if (source) source.chromeSource = true;
  const rank = (p) => (p.chromeSource ? 0 : p.address === "/" ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address));
}

/** The local files `html` (at `file`) links to with `attr` on `tag`, read from the checkout. */
async function linkedFiles(dir, file, html, pattern) {
  const out = [];
  for (const match of html.matchAll(pattern)) {
    const href = match[1].trim().replace(/[?#].*$/, "");
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
    const rel = path.posix.normalize(href.startsWith("/") ? href.slice(1) : path.posix.join(path.posix.dirname(file), href));
    if (rel.startsWith("..") || out.some((f) => f.rel === rel)) continue;
    const full = path.join(dir, rel);
    if (!existsSync(full)) continue;
    out.push({ rel, name: path.posix.basename(rel), content: await fs.readFile(full, "utf8") });
    if (out.length >= MAX_LINKED) break;
  }
  return out;
}

const REFERENCE = /\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi;
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

/**
 * Copies the local files the page and its stylesheets use (images, fonts, downloads) to static/,
 * which the build publishes at the site's root, so the converted page finds them where they were.
 * Repos adopted before import-site.js copied them all; the originals stay where they are.
 */
async function publishReferenced(key, file, html, css) {
  const dir = workspaceDir(key);
  const refs = new Set();
  const add = (from, href) => {
    href = href.trim().replace(/[?#].*$/, "");
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return;
    const rel = path.posix.normalize(href.startsWith("/") ? href.slice(1) : path.posix.join(path.posix.dirname(from), href));
    const top = rel.split("/")[0];
    if (rel.startsWith("..") || top === "static" || top === "assets" || top.startsWith(".") || /\.html?$/i.test(rel)) return;
    refs.add(rel);
  };
  for (const match of html.matchAll(REFERENCE)) add(file, match[1]);
  for (const sheet of css) for (const match of sheet.content.matchAll(CSS_URL)) add(sheet.rel, match[1]);
  const release = acquire(key, "publishing the page's files");
  try {
    for (const rel of refs) {
      const from = path.join(dir, rel);
      const to = path.join(dir, "static", rel);
      if (!existsSync(from) || existsSync(to) || !(await fs.stat(from)).isFile()) continue;
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  } finally {
    release();
  }
}

// The conversion reads the page from .git/twinstack-html/ and writes its CSS to
// assets/css/imported/, so relative addresses would point at the wrong place. Before it's saved,
// the page's own local addresses become root ones ("img/a.png" on blog/x.html → "/blog/img/a.png",
// which the build gives the base path), and CSS url()s become relative to the converted
// stylesheet's folder, which works under any base path.
const CONVERTED_CSS_DIR = "assets/css/imported";
const isLocal = (href) => Boolean(href) && !/^[a-z][a-z0-9+.-]*:|^\/\/|^#|^\{\{/i.test(href);
const fromFile = (file, href) => path.posix.normalize(href.startsWith("/") ? href.slice(1) : path.posix.join(path.posix.dirname(file), href));

// The quote is kept as it was, so a url() inside a style="…" attribute stays valid.
const QUOTED_CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/** `css` (from `cssFile`) with its local url()s pointing at the same files from the converted stylesheet. */
function rebaseCss(css, cssFile) {
  return css.replace(QUOTED_CSS_URL, (whole, quote, href) => {
    const [target, rest = ""] = href.trim().split(/(?=[?#])/);
    if (!isLocal(target)) return whole;
    const rel = fromFile(cssFile, target);
    if (rel.startsWith("..")) return whole;
    return `url(${quote}${path.posix.relative(CONVERTED_CSS_DIR, rel)}${rest}${quote})`;
  });
}

/**
 * `exists(rel)` says whether the repo has that file: GitHub Pages serves pricing.html at
 * "/pricing", which the site's check.js doesn't know, so such a link gets its ".html".
 */
function rebaseHtml(html, file, exists) {
  const root = (raw) => {
    // Browsers decode entity codes in addresses (an embed's src='https:&#47;&#47;…'); the
    // conversion doesn't, and would read that one as relative. &amp; stays as it is.
    const href = raw.replace(/&#(\d+);|&#x([0-9a-f]+);|&(sol|colon|period|lowbar|hyphen);/gi, (whole, dec, hex, name) =>
      dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { sol: "/", colon: ":", period: ".", lowbar: "_", hyphen: "-" }[name.toLowerCase()],
    );
    if (/["'<>]/.test(href)) return raw;
    const [target, rest = ""] = href.split(/(?=[?#])/);
    if (!isLocal(target.trim())) return href;
    let rel = fromFile(file, target.trim());
    if (rel.startsWith("..")) return href;
    if (rel !== "." && !target.trim().endsWith("/") && !path.posix.extname(rel) && !exists(`${rel}/index.html`) && exists(`${rel}.html`)) rel += ".html";
    return `/${rel === "." ? "" : rel}${rest}`;
  };
  return html
    .replace(/(\b(?:src|href|poster|data-src|action)\s*=\s*)(["'])(.*?)\2/gi, (_, attr, q, href) => `${attr}${q}${root(href)}${q}`)
    .replace(/(\bsrcset\s*=\s*)(["'])(.*?)\2/gi, (_, attr, q, set) => `${attr}${q}${set.split(",").map((part) => part.replace(/^\s*(\S+)/, (m, url) => m.replace(url, root(url)))).join(",")}${q}`)
    // style="…" attributes stay in the page, which keeps its address, so their relative url()s
    // are already right (and a root one wouldn't get the base path: the build only adds it to
    // href and src).
    // Scripts are matched first and kept as they are, so a "<style>" in a script's text never
    // starts a block.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (block) => (/^<script/i.test(block) ? block : rebaseCss(block, file)));
}

const STYLESHEET =/<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet)[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
const SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * Gets one original page ready for `page-convert`: saves it and the CSS and scripts it links to
 * (as html-source uploads), and makes sure a content page exists at its address. Returns the
 * command's input: `{ page, source, css, js, address }`.
 */
export async function prepareOriginalPage(key, file) {
  const original = (await listOriginalPages(key)).find((p) => p.file === file);
  if (!original) throw new WorkspaceError("That page isn't one of the repository's own pages.", 404);
  const dir = workspaceDir(key);
  const html = await fs.readFile(path.join(dir, file), "utf8");
  const [css, js] = await Promise.all([linkedFiles(dir, file, html, STYLESHEET), linkedFiles(dir, file, html, SCRIPT)]);
  await publishReferenced(key, file, html, css);
  if (/\.htm$/i.test(file) && !existsSync(path.join(dir, "static", file))) {
    await fs.mkdir(path.dirname(path.join(dir, "static", file)), { recursive: true });
    await fs.writeFile(path.join(dir, "static", file), htmRedirect(file));
  }
  const saved = await saveHtmlSource(key, {
    name: path.posix.basename(file).replace(/\.html?$/i, ""),
    content: rebaseHtml(html, file, (rel) => existsSync(path.join(dir, rel))),
    css: css.map(({ name, rel, content }) => ({ name, content: rebaseCss(content, rel) })),
    js: js.map(({ name, content }) => ({ name, content })),
  });
  const page = original.page ?? (await createPageAt(key, { url: original.address, title: original.title ?? undefined })).file;
  return { page, source: saved.source, css: saved.css.map((c) => c.source), js: (saved.js ?? []).map((c) => c.source), address: original.address, chromeSource: original.chromeSource };
}
