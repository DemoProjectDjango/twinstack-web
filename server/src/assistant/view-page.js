import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { jobEnv } from "../commands.js";
import { WorkspaceError, acquire, previewIsFresh, workingTreeFingerprint, workspaceDir } from "../workspace.js";

// Lets the assistant see a page: pictures from headless Chrome, plus measurements (too wide for
// the screen, broken images) that cost almost nothing to read. Each picture is scaled so its long
// side is what Claude reads at full detail, about 600 to 1,400 tokens. A longer page is read a
// picture at a time with from_y.
//
// Site pages can hold code the owner pasted in, and this runs on the app's server. So their scripts
// are off, and requests may only reach the page's own loopback site and public https addresses.

const execFileAsync = promisify(execFile);
const VIEW_DIR = ".git/twinstack-view";
const STAMP = ".git/twinstack-view-built";
const MAX_LONG_SIDE = 1568;
const BUILD_TIMEOUT_MS = 180_000;
const SHOOT_TIMEOUT_MS = 60_000;

export const SCREENS = {
  phone: { width: 390, height: 844, scale: 0.75, label: "Phone, 390 px wide" },
  computer: { width: 1280, height: 900, scale: 0.5, label: "Computer, 1280 px wide" },
};

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) candidates.push(path.join(dir, name));
  }
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

/** The built site to look at: the editor's preview when it's current, else a build of its own inside .git. */
async function builtSite(key) {
  const dir = workspaceDir(key);
  if (await previewIsFresh(key)) return path.join(dir, "dist");
  const out = path.join(dir, VIEW_DIR);
  const fingerprint = await workingTreeFingerprint(key);
  if ((await fs.readFile(path.join(dir, STAMP), "utf8").catch(() => null)) === fingerprint) return out;
  const source = await fs.readFile(path.join(dir, "scripts", "build.js"), "utf8").catch(() => "");
  if (!source.includes("option('out')")) throw new WorkspaceError("This site's tools are too old to look at a page: it needs the latest site update, which the editor offers.", 409);
  await fs.rm(out, { recursive: true, force: true });
  try {
    await execFileAsync(process.execPath, ["scripts/build.js", "--drafts", `--out=${VIEW_DIR}`], { cwd: dir, env: jobEnv(null, null), timeout: BUILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const last = String(err.stderr || err.stdout || err.message).trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw new WorkspaceError(`The site couldn't be built, so the page can't be looked at: ${last}`, 400);
  }
  await fs.writeFile(path.join(dir, STAMP), fingerprint);
  return out;
}

/** A static server for the built site on a free loopback port, with GitHub Pages' clean addresses. Links are never followed. */
function serve(root) {
  const server = http.createServer(async (req, res) => {
    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      // Served as the homepage.
    }
    const candidates = pathname.endsWith("/") ? [`${pathname}index.html`] : [pathname, `${pathname}.html`, `${pathname}/index.html`];
    for (const candidate of candidates) {
      const file = path.resolve(root, `.${candidate}`);
      if (!file.startsWith(root + path.sep)) break;
      const stat = await fs.lstat(file).catch(() => null);
      if (stat?.isFile()) {
        res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
        res.end(await fs.readFile(file));
        return;
      }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Starts the browser and returns a small DevTools client for one page. */
async function launch(executable) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "twinstack-view-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", env: jobEnv(null, null) });
  const close = () => {
    browser.once("exit", () => setTimeout(() => fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {}), 300).unref());
    try {
      browser.kill();
    } catch {
      // Already gone.
    }
  };
  let ws = null;
  for (let i = 0; i < 75 && !ws; i++) {
    try {
      const port = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      // Not up yet.
    }
    if (!ws) await sleep(200);
  }
  if (!ws) {
    close();
    throw new WorkspaceError("The browser that looks at pages didn't start on this server.", 503);
  }
  if (ws.readyState !== WebSocket.OPEN) await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) listeners.forEach((listener) => listener(message));
  });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { send, evaluate, on: (listener) => listeners.push(listener), close: () => { try { ws.close(); } catch { /* Closing anyway. */ } close(); } };
}

/** Whether the page may load this: its own site, data, or a public https address (web fonts, photos). */
function allowed(url, origin) {
  if (url.startsWith(`${origin}/`) || url.startsWith("data:")) return true;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && hostname !== "localhost" && !/^\[|^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  } catch {
    return false;
  }
}

// Measured against the screen's real width: on a phone a too-wide page stretches innerWidth to fit
// itself. Skips what's meant to run past the edge: a scrolling strip, or a menu parked off-screen.
const measure = (width) => `(() => {
  const width = ${width};
  const named = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
  const meant = (el) => {
    for (let at = el; at && at !== document.body; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.position === 'fixed' || style.visibility === 'hidden') return true;
      if (at !== el && style.overflowX !== 'visible') return true;
    }
    return false;
  };
  const past = [...document.body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 1 && !meant(el));
  const right = Math.max(document.documentElement.scrollWidth, ...past.map((el) => Math.ceil(el.getBoundingClientRect().right)));
  const broken = [...document.images].filter((img) => img.complete && !img.naturalWidth).slice(0, 5).map((img) => img.getAttribute('src'));
  return { height: document.documentElement.scrollHeight, wide: past.length ? Math.max(0, right - width) : 0, over: past.slice(0, 5).map(named), broken };
})()`;

async function shoot(client, url, screen, fromY) {
  await client.send("Emulation.setDeviceMetricsOverride", { width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.width < 600 });
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const loaded = new Promise((resolve) => client.on((m) => m.method === "Page.loadEventFired" && resolve()));
  await client.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(15_000)]);
  await client.evaluate("Promise.race([Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))]), new Promise((r) => setTimeout(r, 6000))]).then(() => true)");
  const facts = await client.evaluate(measure(screen.width));
  if (!facts) throw new WorkspaceError("The page couldn't be measured.", 500);
  const y = Math.min(Math.max(0, fromY), Math.max(0, facts.height - 1));
  const height = Math.min(Math.ceil(MAX_LONG_SIDE / screen.scale), facts.height - y);
  const shot = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: true, clip: { x: 0, y, width: screen.width, height, scale: screen.scale } });
  if (!shot.result?.data) throw new WorkspaceError("The picture of the page couldn't be taken.", 500);
  return { ...facts, label: screen.label, fromY: y, toY: y + height, bytes: Buffer.from(shot.result.data, "base64") };
}

async function look(key, url, screens, fromY) {
  const chrome = findChrome();
  if (typeof WebSocket === "undefined" || !chrome) throw new WorkspaceError("This server has no browser to look at pages with (it needs Chrome and Node 22 or later).", 503);
  const release = acquire(key, "looking at a page");
  let server = null;
  let client = null;
  let timer = null;
  try {
    server = await serve(await builtSite(key));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const target = `${origin}${url}`;
    if ((await fetch(target)).status !== 200) throw new WorkspaceError(`There's no page at ${url} in the built site.`, 404);
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkspaceError("Looking at the page took too long.", 504)), SHOOT_TIMEOUT_MS); });
    const work = (async () => {
      client = await launch(chrome);
      client.on((m) => {
        if (m.method !== "Fetch.requestPaused") return;
        const { requestId, request } = m.params;
        void client.send(allowed(request.url, origin) ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId, ...(allowed(request.url, origin) ? {} : { errorReason: "BlockedByClient" }) });
      });
      await client.send("Page.enable");
      await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await client.send("Emulation.setScriptExecutionDisabled", { value: true });
      const views = [];
      for (const screen of screens) views.push(await shoot(client, target, screen, fromY));
      return views;
    })();
    return await Promise.race([limit, work]);
  } finally {
    clearTimeout(timer);
    client?.close();
    server?.close();
    release();
  }
}

// One browser at a time, across all sites: it's the heaviest thing this server runs.
let queue = Promise.resolve();

/** Pictures and measurements of the page at `url`, one per screen. */
export function viewPage(key, url, screens, fromY = 0) {
  const run = queue.then(() => look(key, url, screens, fromY));
  queue = run.catch(() => {});
  return run;
}

/** What a picture can't say, in words. */
export function describeView(view) {
  const more = view.toY < view.height ? ` from_y ${view.toY} shows the next part.` : "";
  return [
    `${view.label}: the page is ${view.height} px tall; this picture shows ${view.fromY} to ${view.toY}.${more}`,
    view.wide ? `Wider than the screen by ${view.wide} px, so visitors can scroll sideways. Reaching past the edge: ${view.over.join(", ")}.` : "It fits the screen's width.",
    view.broken.length ? `Images that didn't load: ${view.broken.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
