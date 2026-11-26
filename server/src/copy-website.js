import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { findChrome, launch, noBrowser } from "./assistant/view-page.js";
import { FetchRefused, checkUrl, hostIsPublic, safeFetch } from "./safe-fetch.js";
import { sitePages } from "./navigation.js";
import { createPageAt, readSiteConfig, saveHtmlSource } from "./site-files.js";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// "Copy a website": the owner (or the AI, for "make my site like example.com") gives an address,
// and the site gets that website's pages with their design. It works in two halves:
//
// 1. copyWebsite (a job, so the editor shows its progress): headless Chrome opens the start page
//    and then the pages its menus and links lead to on the same site, up to `maxPages`. Each page
//    runs its own scripts (sites built with React and the like have nothing in their HTML), is
//    scrolled to the bottom so lazy images load, and is then frozen as it looks: its rendered HTML,
//    its stylesheets (style rules frameworks inject through the CSSOM included), a picture on a
//    computer and a phone. The images and fonts it uses are downloaded into the site
//    (assets/img/copied/, assets/fonts/copied/), so nothing loads from the old website. Everything
//    else is kept in .git/twinstack-copy/ (never a change): site.json lists the pages.
// 2. Each page is then brought in like an original page (original-pages.js): prepareCopiedPage
//    saves it as an HTML upload and makes the content page, and the browser runs the kept-styles
//    conversion (page-convert), the first page also giving the site its header and footer.
//
// This runs on the app's server with addresses the owner typed, so every request, the browser's
// included, may only reach public addresses (safe-fetch.js), and everything has a limit.

export const COPY_DIR = ".git/twinstack-copy";
const MANIFEST = `${COPY_DIR}/site.json`;
export const DEFAULT_PAGES = 8;
export const MAX_PAGES = 25;
const PAGE_TIMEOUT_MS = 45_000;
const COPY_TIMEOUT_MS = 20 * 60_000;
const MAX_ASSETS = 400;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 120 * 1024 * 1024;
const MAX_SHEETS = 10; // saveHtmlSource's limit
const MAX_SHEET_BYTES = 1.9 * 1024 * 1024;
const MAX_PAGE_HTML = 1.9 * 1024 * 1024;
const SCREENS = {
  computer: { width: 1280, height: 800, maxHeight: 6000, scale: 0.5, mobile: false },
  phone: { width: 390, height: 844, maxHeight: 5000, scale: 0.75, mobile: true },
};
// Addresses that aren't pages, or are pages nobody wants copied.
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|7z|gz|mp4|mov|webm|mp3|wav|docx?|xlsx?|pptx?|csv|xml|json|txt|rss|atom|exe|dmg|apk)$/i;
const SKIPPED_PATH = /\/(wp-admin|wp-login|wp-json|admin|login|logout|signin|sign-in|signup|register|cart|checkout|account|my-account|basket|feed|xmlrpc\.php|cdn-cgi)(\/|$|\.)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The address as typed, made a full https URL ("example.com" → "https://example.com/"). */
export function normaliseStartUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 2000) throw new WorkspaceError("Give the address of the website to copy, like https://example.com.", 400);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return checkUrl(withScheme).href;
  } catch (err) {
    throw new WorkspaceError(err instanceof FetchRefused ? err.message : "That isn't a web address.", 400);
  }
}

/** The same site, www or not. */
const siteHost = (host) => host.toLowerCase().replace(/^www\./, "");

/** A page's address without what doesn't change the page (#…, tracking parameters, a trailing slash). */
function pageKey(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(name)) url.searchParams.delete(name);
    url.hostname = url.hostname.toLowerCase();
    // "/index.html" and "/blog/index.php" are the folder's page: "/" and "/blog".
    url.pathname = url.pathname.replace(/\/index\.(html?|php|aspx?|jsp)$/i, "/");
    if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.href;
  } catch {
    return null;
  }
}

/** Whether a link is a page of the same website that's worth copying. */
function isCopyable(raw, host) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (siteHost(url.hostname) !== host) return false;
    if (url.search && url.search !== "?") return false;
    return !NOT_A_PAGE.test(url.pathname) && !SKIPPED_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Where a copied page goes on this site: "/" stays the homepage; any other page gets a .html
 * address made of plain words ("/About Us/" → "/about-us.html", "/shop/item.php" → "/shop/item.html"),
 * which createPageAt accepts and the template builds as that file.
 */
export function addressFor(raw, taken) {
  const { pathname } = new URL(raw);
  if (pathname === "/" || /^\/index\.(html?|php|aspx?)$/i.test(pathname)) {
    // The start page took "/" when it wasn't the website's own homepage (copyNow).
    if (!taken.has("/")) {
      taken.add("/");
      return "/";
    }
    let home = "/home.html";
    for (let n = 2; taken.has(home); n++) home = `/home-${n}.html`;
    taken.add(home);
    return home;
  }
  const parts = decodeURIComponent(pathname)
    .replace(/\/(index\.(html?|php|aspx?|jsp))?$/i, "")
    .replace(/\.(html?|php|aspx?|jsp|cfm)$/i, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "page");
  let address = `/${parts.join("/")}.html`;
  for (let n = 2; taken.has(address); n++) address = `/${parts.join("/")}-${n}.html`;
  taken.add(address);
  return address;
}


// The page as it looks, ready to copy. Runs inside the page. Lazy images get their real source,
// every address becomes absolute (the server maps them), scripts and what only matters to them go,
// and style rules a framework put in through the CSSOM (empty <style> tags in the HTML) are written
// out as text. Returns the HTML, the stylesheets' addresses in order, and the links.
const SNAPSHOT = `(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'data-hi-res-src'];
  for (const img of document.querySelectorAll('img')) {
    const lazy = LAZY.map((a) => img.getAttribute(a)).find(Boolean);
    const src = img.currentSrc || img.src || lazy;
    if (lazy && (!img.getAttribute('src') || /^data:|placeholder|blank|spacer/i.test(img.getAttribute('src')))) img.setAttribute('src', abs(lazy));
    else if (src) img.setAttribute('src', src);
    for (const a of ['srcset', 'sizes', 'loading', 'decoding', ...LAZY, 'data-srcset']) img.removeAttribute(a);
  }
  for (const source of document.querySelectorAll('picture > source')) source.remove();
  for (const el of document.querySelectorAll('[data-bg], [data-background], [data-background-image]')) {
    const bg = el.getAttribute('data-bg') || el.getAttribute('data-background') || el.getAttribute('data-background-image');
    if (bg && !el.style.backgroundImage) el.style.backgroundImage = 'url("' + abs(bg.replace(/^url\\((['"]?)(.*)\\1\\)$/, '$2')) + '")';
  }
  for (const el of document.querySelectorAll('[src], [href], [poster], [action]')) {
    for (const attr of ['src', 'href', 'poster', 'action']) {
      const value = el.getAttribute(attr);
      if (value === null || /^(#|javascript:|mailto:|tel:|data:)/i.test(value.trim())) continue;
      const full = abs(value.trim());
      if (full) el.setAttribute(attr, full);
    }
  }
  for (const el of document.querySelectorAll('[style*="url("]')) {
    el.setAttribute('style', el.getAttribute('style').replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g, (m, q, u) => /^data:/i.test(u) ? m : 'url("' + (abs(u) || u) + '")'));
  }
  for (const style of document.querySelectorAll('style')) {
    try {
      const rules = [...(style.sheet?.cssRules ?? [])].map((r) => r.cssText).join('\\n');
      if (rules && rules.length > style.textContent.length * 1.5) style.textContent = rules;
    } catch {}
  }
  for (const sheet of document.adoptedStyleSheets ?? []) {
    try { const s = document.createElement('style'); s.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\\n'); document.head.append(s); } catch {}
  }
  const sheets = [];
  for (const link of document.querySelectorAll('link[rel~="stylesheet"], link[rel="preload"][as="style"]')) {
    const href = link.href;
    if (!href || link.disabled || /alternate/i.test(link.rel) || sheets.some((s) => s.href === href)) { link.remove(); continue; }
    sheets.push({ href, media: link.media && link.media !== 'all' ? link.media : '' });
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('data-twinstack-sheet', String(sheets.length - 1));
  }
  const drop = 'script, noscript, base, link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"], link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="manifest"], link[rel~="canonical"], link[rel~="alternate"], meta[http-equiv], meta[property^="og:"], meta[name^="twitter:"]';
  for (const el of document.querySelectorAll(drop)) el.remove();
  for (const el of document.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  }
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, nav: Boolean(a.closest('header, nav, [role="navigation"], footer')) }));
  return { html: '<!doctype html>\\n' + document.documentElement.outerHTML, title: document.title.trim().slice(0, 120), lang: document.documentElement.lang || '', sheets, links };
})()`;

// Scrolls to the bottom a screen at a time (lazy images and "appear on scroll" sections load),
// then back to the top.
const SCROLL = `(async () => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  let y = 0;
  for (let i = 0; i < 40 && y < document.documentElement.scrollHeight && y < 25000; i++) { y += Math.round(innerHeight * 0.8); scrollTo(0, y); await pause(250); }
  scrollTo(0, 0);
  await pause(300);
  return true;
})()`;

/** A browser that may only reach public addresses, with a way to wait for a page to settle. */
async function openBrowser() {
  const chrome = findChrome();
  if (!chrome) throw noBrowser("copy websites");
  const client = await launch(chrome);
  const publicHosts = new Map();
  const isAllowed = async (raw) => {
    if (raw.startsWith("data:") || raw.startsWith("blob:")) return true;
    try {
      checkUrl(raw);
    } catch {
      return false;
    }
    const { hostname } = new URL(raw);
    if (!publicHosts.has(hostname)) publicHosts.set(hostname, hostIsPublic(hostname));
    return publicHosts.get(hostname);
  };
  let inflight = 0;
  let lastActivity = Date.now();
  let loaded = null;
  client.on((m) => {
    if (m.method === "Fetch.requestPaused") {
      const { requestId, request, resourceType } = m.params;
      // Video and audio are never copied, and waiting for them only slows every page down.
      if (resourceType === "Media") return void client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      void isAllowed(request.url).then((ok) => client.send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId, ...(ok ? {} : { errorReason: "BlockedByClient" }) }));
    } else if (m.method === "Network.requestWillBeSent") {
      inflight++;
      lastActivity = Date.now();
    } else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    } else if (m.method === "Page.loadEventFired") loaded?.();
  });
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  // No downloads, no permission prompts, no pop-up windows.
  await client.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

  /** Waits until nothing has loaded for `quietMs` (at most `maxMs`). */
  const settle = async (quietMs, maxMs) => {
    const until = Date.now() + maxMs;
    while (Date.now() < until && (inflight > 0 || Date.now() - lastActivity < quietMs)) await sleep(150);
  };
  const open = async (url, screen) => {
    await client.send("Emulation.setDeviceMetricsOverride", { width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.mobile });
    inflight = 0;
    const done = new Promise((resolve) => { loaded = resolve; });
    const nav = await client.send("Page.navigate", { url });
    if (nav.result?.errorText) throw new Error(`it didn't open (${nav.result.errorText})`);
    await Promise.race([done, sleep(25_000)]);
    await settle(800, 8_000);
    await client.evaluate(SCROLL);
    await settle(600, 5_000);
    await client.evaluate("document.fonts.ready.then(() => true)");
    return client.evaluate("location.href");
  };
  const shoot = async (screen) => {
    const height = Math.min(screen.maxHeight, (await client.evaluate("document.documentElement.scrollHeight")) || screen.height);
    const shot = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: true, clip: { x: 0, y: 0, width: screen.width, height, scale: screen.scale } });
    return shot.result?.data ? Buffer.from(shot.result.data, "base64") : null;
  };
  const resizeAndShoot = async (screen) => {
    await client.send("Emulation.setDeviceMetricsOverride", { width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.mobile });
    await sleep(700);
    await settle(400, 3_000);
    return shoot(screen);
  };
  /** A part of the page from `y`, at most `height` px tall: small enough for the AI to read in full detail. */
  const shootPart = async (screen, y, height) => {
    const total = (await client.evaluate("document.documentElement.scrollHeight")) || screen.height;
    const top = Math.min(y, Math.max(0, total - 1));
    const shot = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: true, clip: { x: 0, y: top, width: screen.width, height: Math.max(1, Math.min(height, total - top)), scale: screen.scale } });
    return shot.result?.data ? Buffer.from(shot.result.data, "base64") : null;
  };
  const resizeAndShootPart = async (screen, y, height) => {
    await client.send("Emulation.setDeviceMetricsOverride", { width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.mobile });
    await sleep(700);
    await settle(400, 3_000);
    return shootPart(screen, y, height);
  };
  return { open, shoot, resizeAndShoot, shootPart, resizeAndShootPart, evaluate: client.evaluate, close: client.close };
}

const EXTENSIONS = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg", "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico", "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf", "application/font-woff": ".woff",
  "application/font-woff2": ".woff2", "application/x-font-woff": ".woff", "application/x-font-ttf": ".ttf", "application/vnd.ms-fontobject": ".eot",
};
const FONT = /\.(woff2?|ttf|otf|eot)$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|avif|svg|ico)$/i;
const NAMED = /\.(woff2?|ttf|otf|eot|jpe?g|png|gif|webp|avif|svg|ico)(?=$|[^a-z0-9])/i;

/** What a file is from its first bytes, as browsers decide (a name like "font.woff%3Fv=3" says little). */
function sniff(bytes) {
  const head = bytes.subarray(0, 16);
  const ascii = head.toString("latin1");
  if (head[0] === 0x89 && ascii.slice(1, 4) === "PNG") return ".png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpg";
  if (ascii.startsWith("GIF8")) return ".gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return ".webp";
  if (ascii.slice(4, 12) === "ftypavif") return ".avif";
  if (ascii.startsWith("wOFF")) return ".woff";
  if (ascii.startsWith("wOF2")) return ".woff2";
  if (ascii.startsWith("OTTO")) return ".otf";
  if (head.readUInt32BE(0) === 0x00010000 || ascii.startsWith("true")) return ".ttf";
  if (bytes.length > 36 && bytes[34] === 0x4c && bytes[35] === 0x50) return ".eot";
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b/i.test(bytes.subarray(0, 1024).toString("utf8"))) return ".svg";
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return ".ico";
  return null;
}

/**
 * Downloads images and fonts into the site, once each, within the limits. `local(url)` resolves to
 * the repo-relative file ("assets/img/copied/example-com/hero-1a2b3c4d.jpg") or null when the file
 * can't be had (it then keeps loading from where it was).
 */
function assetStore(dir, host, notes) {
  const files = new Map();
  let total = 0;
  let count = 0;
  const folder = host.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase();
  const local = (raw) => {
    if (!raw || /^data:/i.test(raw)) return Promise.resolve(null);
    let url;
    try {
      url = new URL(raw);
    } catch {
      return Promise.resolve(null);
    }
    url.hash = "";
    const key = url.href;
    if (!files.has(key)) {
      files.set(key, (async () => {
        if (count >= MAX_ASSETS || total >= MAX_TOTAL_ASSET_BYTES) return null;
        count++;
        try {
          const res = await safeFetch(key, { maxBytes: MAX_ASSET_BYTES, timeoutMs: 20_000 });
          if (res.status !== 200 || !res.body.length) {
            if (notes.length < 50) notes.push(`${key.slice(0, 120)}: the website answered ${res.status}`);
            return null;
          }
          const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          const fromName = NAMED.exec(url.pathname)?.[0].toLowerCase().replace(".jpeg", ".jpg") ?? null;
          const ext = sniff(res.body) ?? EXTENSIONS[type] ?? fromName;
          if (!ext) {
            if (notes.length < 50) notes.push(`${key.slice(0, 120)}: not a picture or font (${type || "unknown type"})`);
            return null;
          }
          total += res.body.length;
          let name = path.posix.basename(url.pathname);
          try {
            name = decodeURIComponent(name);
          } catch {
            // Kept as it is.
          }
          const stem = name.replace(/\.[a-z0-9]+([?#].*)?$/i, "").replace(/\?.*$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
          const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
          const file = `assets/${FONT.test(ext) ? "fonts" : "img"}/copied/${folder}/${stem}-${hash}${ext}`;
          await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
          await fs.writeFile(path.join(dir, file), res.body);
          return file;
        } catch (err) {
          if (notes.length < 50) notes.push(`${key.slice(0, 120)}: ${err.message}`);
          return null;
        }
      })());
    }
    return files.get(key);
  };
  return { local, stats: () => ({ files: [...files.values()].length, count, bytes: total }) };
}

const CSS_URL = /url\(\s*(["']?)([^"')]+?)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*(["']?)([^"')]+?)\1\s*\)|(["'])([^"']+)\3)\s*([^;]*);/gi;

/** `text` with every async replacement of `pattern` applied (String.replace can't await). */
async function replaceAsync(text, pattern, replace) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index), replace(...match));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return (await Promise.all(parts)).join("");
}

/**
 * A stylesheet from where it's published, as a browser would see it: @imports pulled in (to a
 * depth of 3) and every url() it uses made to point at the downloaded file, relative to where the
 * conversion keeps a page's stylesheet (assets/css/imported/), so it works under any base path.
 */
async function copyStylesheet(href, assets, depth = 0) {
  const res = await safeFetch(href, { maxBytes: 4 * 1024 * 1024, accept: "text/css,*/*;q=0.1" });
  if (res.status !== 200) throw new Error(`it answered ${res.status}`);
  let css = res.body.toString("utf8");
  css = await replaceAsync(css, CSS_IMPORT, async (whole, q1, u1, q2, u2, media) => {
    if (depth >= 3) return "";
    const target = new URL(u1 ?? u2, res.url).href;
    try {
      const inner = await copyStylesheet(target, assets, depth + 1);
      return media?.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
    } catch {
      return "";
    }
  });
  return rewriteCssUrls(css, res.url, assets);
}

// A url() this file already pointed at a downloaded file. An @import's sheet is copied (and its
// url()s rewritten) before the sheet that imports it is, so those must not be resolved again against
// the outer sheet's address (they became "https://site/…/fonts/copied/…", which doesn't exist).
const COPIED_REF = /^(?:\.\.\/\.\.\/|\/assets\/)(?:img|fonts)\/copied\//;

/** url()s in `css` (relative to `base`) pointing at the downloaded files, relative to assets/css/imported/. */
function rewriteCssUrls(css, base, assets) {
  return replaceAsync(css, CSS_URL, async (whole, quote, raw) => {
    const ref = raw.trim();
    if (/^(data:|#)/i.test(ref) || COPIED_REF.test(ref)) return whole;
    let target;
    try {
      target = new URL(ref, base).href;
    } catch {
      return whole;
    }
    const file = await assets.local(target);
    return `url("${file ? path.posix.relative("assets/css/imported", file) : target}")`;
  });
}

/**
 * Turns one frozen page into what's kept: its stylesheets (at most MAX_SHEETS, in order; the rest
 * joined into the last), its images and inline backgrounds pointing at downloaded files, and links
 * to the other copied pages pointing at their new addresses.
 */
async function finishPage(snapshot, { address, addresses, assets, notes }) {
  // Comments go (old browsers' conditional comments hold <script> tags), except inside <style>.
  let html = snapshot.html.replace(/<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi, (block) => (block.startsWith("<!--") ? "" : block));

  // Stylesheets: each <link> becomes "copy-N.css", the name its upload gets.
  const sheets = [];
  for (const [index, sheet] of snapshot.sheets.entries()) {
    try {
      let css = await copyStylesheet(sheet.href, assets);
      if (sheet.media) css = `@media ${sheet.media} {\n${css}\n}`;
      sheets.push({ index, css });
    } catch (err) {
      notes.push(`Stylesheet ${sheet.href.slice(0, 120)} couldn't be copied: ${err.message}`);
      sheets.push({ index, css: null });
    }
  }
  const kept = sheets.filter((s) => s.css !== null);
  const groups = kept.slice(0, MAX_SHEETS - 1).map((s) => [s]);
  if (kept.length >= MAX_SHEETS) groups.push(kept.slice(MAX_SHEETS - 1));
  const css = [];
  const nameOf = new Map();
  for (const [n, group] of groups.entries()) {
    const name = `copy-${n + 1}.css`;
    const text = group.map((s) => s.css).join("\n");
    if (Buffer.byteLength(text) > MAX_SHEET_BYTES) {
      notes.push(`${name} is over 2 MB, so it was left out: this page may not look right.`);
      continue;
    }
    css.push({ name, content: text });
    group.forEach((s, i) => nameOf.set(s.index, i === 0 ? name : null));
  }
  html = html.replace(/<link\b[^>]*\bdata-twinstack-sheet="(\d+)"[^>]*>/gi, (whole, index) => {
    const name = nameOf.get(Number(index));
    return name ? `<link rel="stylesheet" href="${name}">` : "";
  });

  // <style> blocks: their url()s too.
  html = await replaceAsync(html, /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, async (whole, open, body, close) => `${open}${await rewriteCssUrls(body, snapshot.url, assets)}${close}`);

  // Images: <img src>, <video poster>, <input type=image>. Root addresses: the build adds the base path.
  html = await replaceAsync(html, /(<(?:img|input|video)\b[^>]*?\s(?:src|poster)\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, async (whole, lead, quote, url) => {
    const file = await assets.local(url.replace(/&amp;/g, "&"));
    return file ? `${lead}${quote}/${file}${quote}` : whole;
  });
  // Inline backgrounds: root addresses. The editor's preview maps url(/…) into its own prefix, and
  // the template's build adds the base path to url(/…) in a page's HTML as it does to href and src.
  // (Page-relative addresses broke in the preview, whose homepage address has no trailing slash.)
  html = await replaceAsync(html, /(\sstyle\s*=\s*)(["'])([^"']*url\([^"']*)\2/gi, async (whole, lead, quote, style) => {
    const fixed = await replaceAsync(style.replace(/&quot;/g, '"'), CSS_URL, async (m, q, raw) => {
      const file = /^https?:/i.test(raw.trim()) ? await assets.local(raw.trim().replace(/&amp;/g, "&")) : null;
      return file ? `url('/${file}')` : m;
    });
    return `${lead}${quote}${quote === '"' ? fixed.replace(/"/g, "'") : fixed}${quote}`;
  });

  // Links to pages that were copied go to their new addresses; links to the rest keep going to the old site.
  html = html.replace(/(<a\b[^>]*?\shref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (whole, lead, quote, href) => {
    const raw = href.replace(/&amp;/g, "&");
    const hash = raw.includes("#") ? raw.slice(raw.indexOf("#")) : "";
    const target = addresses.get(pageKey(raw));
    if (!target) return whole;
    return `${lead}${quote}${target === address && hash ? hash : `${target}${hash}`}${quote}`;
  });

  if (Buffer.byteLength(html) > MAX_PAGE_HTML) throw new Error("its HTML is over 2 MB once copied, which is more than a page can hold");
  return { html, css };
}

/** The pages to visit: the start page, then links in menus and footers before other links, breadth first. */
function nextPages(queue, seen, links, host) {
  const sorted = [...links.filter((l) => l.nav), ...links.filter((l) => !l.nav)];
  for (const { href } of sorted) {
    const key = pageKey(href);
    if (!key || seen.has(key) || !isCopyable(key, host)) continue;
    seen.add(key);
    queue.push(key);
  }
}

/**
 * The job step: copies up to `maxPages` pages of the website at `url` into the workspace (see the
 * top of this file). `log` reports progress in plain words; lines starting with "▸ n/total" are
 * the progress the status strip shows.
 */
// One copy (or look) at a time across the whole server: each one runs a browser, the heaviest thing it does.
let turn = Promise.resolve();
let waiting = 0;

/** Runs `work` once the browser is free. */
function oneAtATime(work) {
  const run = turn.then(work);
  turn = run.catch(() => {});
  return run;
}

// What a designer notes about a page, read inside it: fonts, the colours covering the most of it,
// the menu, the headings, how many sections, and the site's other pages.
const DESIGN_FACTS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const fonts = new Map();
  for (const el of [document.body, ...document.querySelectorAll('h1, h2, h3, p, a, button, li')].slice(0, 400)) {
    if (!visible(el)) continue;
    const family = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
    const kind = /^H[1-3]$/.test(el.tagName) ? 'headings' : 'text';
    fonts.set(family + ' (' + kind + ')', (fonts.get(family + ' (' + kind + ')') || 0) + 1);
  }
  const colours = new Map();
  const area = innerWidth * Math.min(document.documentElement.scrollHeight, 6000);
  for (const el of [document.documentElement, document.body, ...document.querySelectorAll('header, nav, main, section, footer, div, a, button')].slice(0, 2500)) {
    const style = getComputedStyle(el);
    const bg = style.backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
    const r = el.getBoundingClientRect();
    colours.set(bg, (colours.get(bg) || 0) + Math.min(area, r.width * r.height));
  }
  const accents = new Map();
  for (const el of document.querySelectorAll('a, button, [class*="btn"], [class*="button"]')) {
    if (!visible(el)) continue;
    const style = getComputedStyle(el);
    for (const c of [style.backgroundColor, style.color]) if (c && c !== 'rgba(0, 0, 0, 0)') accents.set(c, (accents.get(c) || 0) + 1);
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const menu = [...document.querySelectorAll('header a, nav a')].filter(visible).map(text).filter(Boolean);
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(visible).map((h) => h.tagName.toLowerCase() + ': ' + text(h).slice(0, 90)).filter((t) => t.length > 4);
  const sections = document.querySelectorAll('main > section, main > div, body > section').length;
  const host = location.hostname.replace(/^www\\./, '');
  const pages = [...new Set([...document.querySelectorAll('a[href]')].map((a) => { try { const u = new URL(a.href); return u.hostname.replace(/^www\\./, '') === host && !u.search ? u.origin + u.pathname : null; } catch { return null; } }).filter(Boolean))];
  return {
    title: document.title.trim(),
    description: document.querySelector('meta[name="description"]')?.content?.trim() || '',
    fonts: top(fonts, 5), colours: top(colours, 6), accents: top(accents, 5),
    menu: [...new Set(menu)].slice(0, 20), headings: headings.slice(0, 25), sections, pages: pages.slice(0, 40),
    height: document.documentElement.scrollHeight,
  };
})()`;

/**
 * The AI's look at a website before copying or improving it (look_at_website): pictures of the
 * page on a computer and a phone, a screen or two from `fromY`, and its design facts.
 */
export function lookAtWebsite(rawUrl, fromY = 0) {
  const url = normaliseStartUrl(rawUrl);
  return oneAtATime(async () => {
    const browser = await openBrowser();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const landed = await browser.open(url, SCREENS.computer);
          const facts = await browser.evaluate(DESIGN_FACTS);
          if (!facts) throw new WorkspaceError("The website couldn't be read.", 400);
          const y = Math.max(0, Math.min(Math.trunc(fromY) || 0, Math.max(0, facts.height - 400)));
          const computer = await browser.shootPart(SCREENS.computer, y, 2400);
          const phone = await browser.resizeAndShootPart(SCREENS.phone, Math.round(y / 2), 1600);
          return { url: landed, facts, fromY: y, shots: { computer, phone } };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new WorkspaceError("The website took too long to open.", 504)), PAGE_TIMEOUT_MS * 2);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      browser.close();
    }
  });
}

export function copyWebsiteStep(key, { url, maxPages }) {
  return {
    display: `Copying ${url}`,
    run: ({ log, signal }) => {
      if (waiting > 0) log("Waiting for another website copy on this server to finish…");
      waiting++;
      return oneAtATime(() => {
        waiting--;
        if (signal?.aborted) throw new WorkspaceError("Stopped before it started.", 400);
        return copyNow(key, { url, maxPages }, log, signal);
      });
    },
  };
}

async function copyNow(key, { url, maxPages }, log, signal) {
  const stopped = () => {
    if (signal?.aborted) throw new WorkspaceError("You stopped copying the website.", 400);
  };
  // Settles (as a stop) the moment the owner cancels, so nothing waits out a page's timeout.
  const cancelled = new Promise((_, reject) => {
    if (!signal) return;
    const stop = () => reject(new WorkspaceError("You stopped copying the website.", 400));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  cancelled.catch(() => {});
  const dir = workspaceDir(key);
  const start = normaliseStartUrl(url);
  const limit = Math.min(MAX_PAGES, Math.max(1, Number(maxPages) || DEFAULT_PAGES));
  const host = siteHost(new URL(start).hostname);
  const deadline = Date.now() + COPY_TIMEOUT_MS;
  await fs.rm(path.join(dir, COPY_DIR), { recursive: true, force: true });
  await fs.mkdir(path.join(dir, COPY_DIR, "pages"), { recursive: true });
  await fs.mkdir(path.join(dir, COPY_DIR, "shots"), { recursive: true });

  const notes = [];
  const assets = assetStore(dir, host, notes);
  const browser = await openBrowser();
  // A cancel closes the browser at once, so a page that's still loading gives up too.
  const onAbort = () => browser.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  const frozen = [];
  const skipped = [];
  try {
    // First pass: visit and freeze every page, so links between them can be mapped after.
    const queue = [pageKey(start)];
    const seen = new Set(queue);
    while (queue.length && frozen.length < limit && Date.now() < deadline) {
      stopped();
      const target = queue.shift();
      log(`▸ ${frozen.length + 1}/${limit} Looking at ${target}`);
      try {
        const page = await Promise.race([
          (async () => {
            const shots = {};
            const landed = pageKey(await browser.open(target, SCREENS.computer));
            if (!landed || siteHost(new URL(landed).hostname) !== host) throw new Error(`it sends visitors to another website (${landed})`);
            shots.computer = await browser.shoot(SCREENS.computer);
            const snapshot = await browser.evaluate(SNAPSHOT);
            if (!snapshot?.html) throw new Error("it couldn't be read");
            // The phone picture: the same page at a phone's width (its CSS reflows without a reload).
            shots.phone = await browser.resizeAndShoot(SCREENS.phone);
            return { url: landed, requested: target, snapshot: { ...snapshot, url: landed }, shots };
          })(),
          sleep(PAGE_TIMEOUT_MS * 2).then(() => { throw new Error("it took too long to load"); }),
          cancelled,
        ]);
        if (frozen.some((p) => p.url === page.url)) continue;
        frozen.push(page);
        nextPages(queue, seen, page.snapshot.links, host);
      } catch (err) {
        stopped();
        skipped.push({ url: target, reason: err.message });
        log(`  ! Skipped ${target}: ${err.message}`);
        if (!frozen.length) throw new WorkspaceError(`The website couldn't be opened: ${err.message}`, 400);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    browser.close();
  }

  // Second pass: addresses on this site, then each page's files.
  const taken = new Set();
  const addresses = new Map();
  for (const [i, page] of frozen.entries()) {
    // The page the owner gave is the new site's homepage, wherever it was on the old website.
    if (i === 0) taken.add("/");
    page.address = i === 0 ? "/" : addressFor(page.url, taken);
    addresses.set(page.url, page.address);
    addresses.set(page.requested, page.address);
  }
  const existing = new Set((await sitePages(dir, await readSiteConfig(key))).map((p) => p.url));
  const pages = [];
  for (const [i, page] of frozen.entries()) {
    stopped();
    log(`▸ ${i + 1}/${frozen.length} Copying the pictures, fonts and styles of ${page.address}`);
    const id = String(i + 1).padStart(2, "0");
    try {
      const { html, css } = await Promise.race([finishPage(page.snapshot, { address: page.address, addresses, assets, notes }), cancelled]);
      await fs.writeFile(path.join(dir, COPY_DIR, "pages", `${id}.html`), html);
      await fs.mkdir(path.join(dir, COPY_DIR, "css", id), { recursive: true });
      for (const sheet of css) await fs.writeFile(path.join(dir, COPY_DIR, "css", id, sheet.name), sheet.content);
      for (const [screen, bytes] of Object.entries(page.shots)) if (bytes) await fs.writeFile(path.join(dir, COPY_DIR, "shots", `${id}-${screen}.jpg`), bytes);
      pages.push({
        id,
        url: page.url,
        address: page.address,
        title: page.snapshot.title || null,
        css: css.map((c) => c.name),
        shots: Object.keys(page.shots).filter((s) => page.shots[s]),
        replaces: existing.has(page.address) && page.address !== "/",
      });
    } catch (err) {
      stopped();
      skipped.push({ url: page.url, reason: err.message });
      log(`  ! Skipped ${page.url}: ${err.message}`);
    }
  }
  if (!pages.length) throw new WorkspaceError("None of the website's pages could be copied.", 400);
  const stats = assets.stats();
  const manifest = { url: start, host, copiedAt: new Date().toISOString(), maxPages: limit, pages, skipped, notes: notes.slice(0, 50), assets: { files: stats.count, bytes: stats.bytes } };
  await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  log(`Copied ${pages.length} page${pages.length === 1 ? "" : "s"} of ${host}, with ${stats.count} pictures and fonts (${(stats.bytes / 1024 / 1024).toFixed(1)} MB).`);
  if (skipped.length) log(`Left out ${skipped.length}: ${skipped.map((s) => s.url).slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
  log("Next: bring the pages into the site (Pages → Copy a website).");
}

/** What the last copy holds, for the Pages screen and the AI: the website and each page, with whether it's in the site yet. */
export async function readCopiedWebsite(key) {
  const dir = workspaceDir(key);
  const manifest = JSON.parse((await fs.readFile(path.join(dir, MANIFEST), "utf8").catch(() => "null")) ?? "null");
  if (!manifest) return null;
  const pages = await sitePages(dir, await readSiteConfig(key));
  const same = (url) => url.replace(/(^|\/)index\.html$/, "$1");
  const list = [];
  for (const [i, item] of manifest.pages.entries()) {
    const page = pages.find((p) => same(p.url) === item.address) ?? null;
    const text = page ? await fs.readFile(path.join(dir, page.file), "utf8").catch(() => "") : "";
    // Brought in once the page at its address uses a converted page's stylesheet (as original pages are).
    list.push({ ...item, page: page?.file ?? null, broughtIn: text.includes("/assets/css/imported/"), chromeSource: i === 0 });
  }
  return { url: manifest.url, host: manifest.host, copiedAt: manifest.copiedAt, pages: list, skipped: manifest.skipped, notes: manifest.notes, assets: manifest.assets };
}

/** A page's picture from the last copy ("computer" or "phone"), or null. */
export async function copiedPageShot(key, id, screen) {
  if (!/^\d{2}$/.test(String(id)) || !(screen in SCREENS)) return null;
  return fs.readFile(path.join(workspaceDir(key), COPY_DIR, "shots", `${id}-${screen}.jpg`)).catch(() => null);
}

/** The repo-relative path of a page's picture, for page-edit's --reference (null when there's none). */
export function copiedShotPath(key, id, screen = "computer") {
  if (!/^\d{2}$/.test(String(id)) || !(screen in SCREENS)) return null;
  const rel = `${COPY_DIR}/shots/${id}-${screen}.jpg`;
  return existsSync(path.join(workspaceDir(key), rel)) ? rel : null;
}

/**
 * Gets one copied page ready for page-convert, as prepareOriginalPage does: saves it and its
 * stylesheets as the HTML upload and makes sure a content page exists at its address. Returns
 * `{ page, source, css, js, address, chromeSource }`.
 */
export async function prepareCopiedPage(key, id) {
  const copied = await readCopiedWebsite(key);
  const item = copied?.pages.find((p) => p.id === id);
  if (!item) throw new WorkspaceError("That page isn't in the copied website. Copy the website again.", 404);
  const dir = path.join(workspaceDir(key), COPY_DIR);
  const html = await fs.readFile(path.join(dir, "pages", `${id}.html`), "utf8").catch(() => null);
  if (html === null) throw new WorkspaceError("The copied page is gone. Copy the website again.", 409);
  const css = [];
  for (const name of item.css) css.push({ name, content: await fs.readFile(path.join(dir, "css", id, name), "utf8") });
  const saved = await saveHtmlSource(key, { name: item.address === "/" ? "home" : path.posix.basename(item.address, ".html"), content: html, css });
  let page = item.page;
  if (!page) {
    page = (await createPageAt(key, { url: item.address, title: item.title ?? undefined })).file;
    await markCreated(key, id, page);
  }
  return { page, source: saved.source, css: saved.css.map((c) => c.source), js: [], address: item.address, chromeSource: item.chromeSource };
}

/** Notes in site.json that the copy made this page, so finishCopiedWebsite may remove it if it never got its content. */
async function markCreated(key, id, file) {
  const manifestFile = path.join(workspaceDir(key), MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  const item = manifest.pages.find((p) => p.id === id);
  if (item) item.created = file;
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every content page and the header and footer partials: where links to copied pages are. */
async function linkingFiles(dir) {
  const out = [];
  const walk = async (rel) => {
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const file = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (/\.md$/i.test(entry.name)) out.push(file);
    }
  };
  await walk("content");
  for (const partial of ["templates/partials/header.html", "templates/partials/footer.html"]) if (existsSync(path.join(dir, partial))) out.push(partial);
  return out;
}

/**
 * After "Bring in all": every copied page that isn't in the site (its conversion failed, or the
 * owner left it out) has the empty page the copy made for it removed, and links to its address
 * point at the page on the old website again, so the site check never fails on them and visitors
 * still get somewhere. Returns `{ removed: [files], relinked: n }`.
 */
export async function finishCopiedWebsite(key) {
  const copied = await readCopiedWebsite(key);
  if (!copied) throw new WorkspaceError("There's no copied website to finish.", 404);
  const dir = workspaceDir(key);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), "utf8"));
  const missing = copied.pages.filter((p) => !p.broughtIn && p.address !== "/");
  const release = acquire(key, "finishing the copied website");
  const removed = [];
  let relinked = 0;
  try {
    // Pages the owner had at that address before stay, and so do links to them.
    const gone = [];
    for (const item of missing) {
      const made = manifest.pages.find((p) => p.id === item.id)?.created;
      if (made && item.page === made) {
        await fs.rm(path.join(dir, made), { force: true });
        removed.push(made);
        gone.push(item);
      } else if (!item.page) gone.push(item);
    }
    if (gone.length) {
      const back = new Map(gone.map((p) => [p.address, p.url]));
      const pattern = new RegExp(`(\\shref\\s*=\\s*)(["'])(${gone.map((p) => escapeRegExp(p.address)).join("|")})(#[^"']*)?\\2`, "g");
      for (const file of await linkingFiles(dir)) {
        const full = path.join(dir, file);
        const text = await fs.readFile(full, "utf8");
        let count = 0;
        const next = text.replace(pattern, (whole, lead, quote, address, hash = "") => {
          count++;
          return `${lead}${quote}${back.get(address)}${hash}${quote}`;
        });
        if (count) {
          await fs.writeFile(full, next);
          relinked += count;
        }
      }
    }
  } finally {
    release();
  }
  return { removed, relinked, missing: missing.map((p) => p.address) };
}

/** Removes the last copy's kept pages (not the pages brought in, nor the downloaded files they use). */
export async function clearCopiedWebsite(key) {
  const release = acquire(key, "clearing the copied website");
  try {
    await fs.rm(path.join(workspaceDir(key), COPY_DIR), { recursive: true, force: true });
  } finally {
    release();
  }
}
