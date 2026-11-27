import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSiteConfig } from "./site-files.js";
import { updateSiteTree } from "./site-tree-sync.js";
import { acquire, workspaceDir } from "./workspace.js";

// Starter kits: ready-made designs a new site can start from (plan: starter-kits-plan.md at the
// twinstack root). Each kit is a folder in server/kits/ with a kit.json and its pages, already
// designed (they pass isDesigned), so a site made from one needs no AI to look finished. Pages take
// the owner's details from site.config.json ({{ site.name }}, {{ site.contact.* }}), which the setup
// saves, so nothing in a kit is written per site. A kit is applied only to a new site's setup
// (setup-build.js's prepareBuild), never over an owner's work: a page already at a kit page's
// address is kept, except the template's starter homepage.

export const KITS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "kits");
const KIT_ID = /^[a-z0-9-]{1,40}$/;
const PAGE_FILE = /^[a-z0-9-]+\.md$/;

let cache = null;

/** Every kit, read once: `{ id, version, label, description, category, free, pages, dir }`. */
export async function loadKits() {
  if (cache) return cache;
  const kits = [];
  for (const entry of await fs.readdir(KITS_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !KIT_ID.test(entry.name)) continue;
    const dir = path.join(KITS_DIR, entry.name);
    try {
      const kit = JSON.parse(await fs.readFile(path.join(dir, "kit.json"), "utf8"));
      if (kit.id !== entry.name || !Array.isArray(kit.pages) || !kit.pages.every((p) => PAGE_FILE.test(p.file) && typeof p.url === "string")) {
        throw new Error("kit.json doesn't match its folder or lists a bad page");
      }
      kits.push({ ...kit, free: kit.free !== false, dir });
    } catch (err) {
      console.error(`Starter kit ${entry.name} is left out:`, err.message);
    }
  }
  cache = kits.sort((a, b) => a.label.localeCompare(b.label));
  return cache;
}

/** What the setup shows: no folder paths. */
export async function listKits() {
  return (await loadKits()).map(({ id, version, label, description, category, free, pages }) => ({
    id,
    version,
    label,
    description,
    category,
    free,
    pages: pages.map((p) => ({ url: p.url, title: p.title })),
  }));
}

export async function kitById(id) {
  return typeof id === "string" ? ((await loadKits()).find((k) => k.id === id) ?? null) : null;
}

/** Page addresses compared the way the site serves them: "/contact", "/contact.html" and "/contact/" are one page. */
export const sameAddress = (a, b) => {
  const norm = (u) => (u === "/" ? "/" : u.replace(/\/index\.html?$/, "").replace(/\.html?$/, "").replace(/\/$/, ""));
  return norm(a) === norm(b);
};

const urlOf = (text) => /^url:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(text.split(/^---\s*$/m)[1] ?? "")?.[1] ?? null;
const STARTER = /One sentence on (what|how)|Replace this with|Opening paragraph: the specific situation/;

/**
 * Writes `kitId`'s pages into the site at `key`. Resolves to `{ kit, pages: [{ file, url, title, menu }] }`
 * for the pages written, or null when there's no such kit.
 */
export async function applyKit(key, kitId) {
  const kit = await kitById(kitId);
  if (!kit) return null;
  const site = await readSiteConfig(key);
  const pagesDir = site.collections?.pages?.dir;
  if (typeof pagesDir !== "string" || !pagesDir) throw new Error("The site has no pages collection.");
  const dir = workspaceDir(key);
  const existing = [];
  for (const name of await fs.readdir(path.join(dir, pagesDir)).catch(() => [])) {
    if (!name.endsWith(".md")) continue;
    const text = await fs.readFile(path.join(dir, pagesDir, name), "utf8");
    existing.push({ name, url: urlOf(text), starter: STARTER.test(text) });
  }
  const written = [];
  const release = acquire(key, `starting the site from the ${kit.label} design`);
  try {
    for (const page of kit.pages) {
      const there = existing.find((e) => e.url && sameAddress(e.url, page.url));
      // Only the template's starter homepage gives way; anything else the site has is kept.
      if (there && !there.starter) continue;
      const name = there?.name ?? page.file;
      if (!there && existing.some((e) => e.name === name)) continue;
      await fs.mkdir(path.join(dir, pagesDir), { recursive: true });
      await fs.copyFile(path.join(kit.dir, "pages", page.file), path.join(dir, pagesDir, name));
      written.push({ file: `${pagesDir}/${name}`, url: page.url, title: page.title, menu: page.menu === true });
    }
    await updateSiteTree(dir, { add: written.map((p) => p.url) }).catch((err) => console.error(`Couldn't add the ${kit.id} kit's pages to the site plan:`, err.message));
  } finally {
    release();
  }
  return { kit: { id: kit.id, version: kit.version }, pages: written };
}

/**
 * GET /api/kit-preview/<kit>/…: each kit's built preview (server/kits/<id>/preview/, made by
 * `npm --prefix server run kits:build`). Public, because the setup shows it in a sandboxed frame,
 * whose requests carry no cookie; it's only our own sample pages. Sandboxed like the site preview.
 */
export function kitPreviewRouter() {
  const router = express.Router();
  const HEADERS = {
    "Content-Security-Policy": "sandbox allow-scripts allow-popups",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=300",
  };
  router.use("/:kit", (req, res, next) => {
    if (!KIT_ID.test(req.params.kit)) return res.status(404).end();
    // The homepage: Next.js's rewrite drops the trailing slash, so "/api/kit-preview/<kit>" arrives bare.
    if (req.url === "" || req.url === "/" || req.url.startsWith("?")) req.url = "/index.html";
    express.static(path.join(KITS_DIR, req.params.kit, "preview"), {
      dotfiles: "ignore",
      redirect: false,
      setHeaders: (r) => r.set(HEADERS),
    })(req, res, () => res.status(404).set(HEADERS).end());
  });
  return router;
}
