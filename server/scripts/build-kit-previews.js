// Builds each starter kit's preview: the kit applied to a copy of the site template with sample
// business details, built by the template's own build.js and checked by its check.js, into
// server/kits/<id>/preview/ (committed: the server only serves it, at /api/kit-preview/<id>/).
// Run after changing a kit or the template:  npm --prefix server run kits:build
// The template is the local twinstack-site checkout beside this repo (with node_modules), or
// TWINSTACK_SITE_DIR.
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withDescription } from "../src/kit-text.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KITS_DIR = path.resolve(here, "../kits");
const TEMPLATE = process.env.TWINSTACK_SITE_DIR || path.resolve(here, "../../../twinstack-site");
const SKIP = new Set(["node_modules", "dist", ".git", ".env"]);

// What a visitor of the preview sees in place of the owner's details.
const SAMPLE = {
  name: "Your Business",
  description: "A short sentence about what your business does goes here.",
  contact: { email: "hello@yourbusiness.com", phone: "+1 555 0100", address: "123 Main Street, Your Town", hours: "Mon–Fri 9am–5pm" },
};

// Chrome for the gallery thumbnails (CHROME_PATH, else the usual places).
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].find((c) => c && existsSync(c));

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };

/**
 * preview/thumbnail.png: the top of the kit's homepage at 1280×800, saved at half size (640×400),
 * the picture on its gallery card. The preview is served at its own base path for the shot.
 */
async function thumbnail(kitId, previewDir) {
  const base = `/api/kit-preview/${kitId}`;
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (!p.startsWith(base)) return res.writeHead(404).end();
    p = p.slice(base.length) || "/";
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(previewDir, p);
    if (!file.startsWith(previewDir)) return res.writeHead(404).end();
    const data = await fs.readFile(file).catch(() => null);
    if (!data) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(data);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "kit-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let text = "";
      chrome.stderr.on("data", (d) => {
        text += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
        if (m) resolve(m[1]);
      });
      chrome.on("exit", () => reject(new Error("Chrome closed before it started")));
      setTimeout(() => reject(new Error("Chrome didn't start")), 20000);
    });
    const browser = new WebSocket(wsUrl);
    await new Promise((r, j) => ((browser.onopen = r), (browser.onerror = j)));
    let id = 0;
    const waiting = new Map();
    browser.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) {
        const { resolve, reject } = waiting.get(m.id);
        waiting.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        waiting.set(++id, { resolve, reject });
        browser.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}${base}/` }, sessionId);
    // Fonts and styles settle; there's no page load event in flat mode without more wiring.
    await new Promise((r) => setTimeout(r, 3000));
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 } }, sessionId);
    await fs.writeFile(path.join(previewDir, "thumbnail.png"), Buffer.from(shot.data, "base64"));
    browser.close();
  } finally {
    chrome.kill();
    server.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

if (!existsSync(path.join(TEMPLATE, "scripts/build.js")) || !existsSync(path.join(TEMPLATE, "node_modules"))) {
  console.error(`No site template with node_modules at ${TEMPLATE}. Set TWINSTACK_SITE_DIR.`);
  process.exit(1);
}

let failed = false;
for (const entry of await fs.readdir(KITS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const kitDir = path.join(KITS_DIR, entry.name);
  const kit = JSON.parse(await fs.readFile(path.join(kitDir, "kit.json"), "utf8"));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `kit-${kit.id}-`));
  try {
    await fs.cp(TEMPLATE, work, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
    await fs.symlink(path.join(TEMPLATE, "node_modules"), path.join(work, "node_modules"), "junction");

    const configFile = path.join(work, "site.config.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    const pagesDir = config.collections.pages.dir;
    for (const name of await fs.readdir(path.join(work, pagesDir)).catch(() => [])) await fs.rm(path.join(work, pagesDir, name));
    await fs.mkdir(path.join(work, pagesDir), { recursive: true });
    for (const page of kit.pages) {
      const source = await fs.readFile(path.join(kitDir, "pages", page.file), "utf8");
      await fs.writeFile(path.join(work, pagesDir, page.file), page.url === "/" ? withDescription(source, SAMPLE.description) : source);
    }
    Object.assign(config, { name: SAMPLE.name, shortName: SAMPLE.name, description: SAMPLE.description });
    config.brand = { ...config.brand, logoText: SAMPLE.name };
    config.contact = { ...config.contact, ...SAMPLE.contact };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2));

    // The menu as a new site from the kit gets it: the kit's menu pages, no template sample links.
    const navFile = path.join(work, "content/data/navigation.json");
    const nav = JSON.parse(await fs.readFile(navFile, "utf8"));
    nav.header.items = kit.pages.filter((p) => p.menu).map((p) => ({ label: p.title, url: p.url }));
    nav.footer = (nav.footer ?? []).map((column) => ({ ...column, links: (column.links ?? []).filter((l) => l.url !== "/rss.xml") }));
    await fs.writeFile(navFile, JSON.stringify(nav, null, 2));

    const env = { ...process.env, BASE_PATH: `/api/kit-preview/${kit.id}`, SITE_URL: "" };
    const run = (script) => execFileSync(process.execPath, [script], { cwd: work, env, encoding: "utf8", stdio: "pipe" });
    run("scripts/build.js");
    const check = run("scripts/check.js");
    if (/^\s*error\s/m.test(check)) throw new Error(`the site check failed:\n${check}`);
    // Warnings too: a template should start a site with nothing to fix.
    if (/^\s*warning\s/m.test(check)) throw new Error(`the site check has warnings:\n${check}`);

    const out = path.join(kitDir, "preview");
    await fs.rm(out, { recursive: true, force: true });
    await fs.cp(path.join(work, "dist"), out, { recursive: true });
    if (CHROME) await thumbnail(kit.id, out);
    else console.warn(`  ! No Chrome found (set CHROME_PATH): ${kit.id} has no gallery thumbnail.`);
    console.log(`✔ ${kit.id}: preview built (${kit.pages.length} pages${CHROME ? ", thumbnail" : ""})`);
  } catch (err) {
    failed = true;
    console.error(`✖ ${kit.id}: ${err.message}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
