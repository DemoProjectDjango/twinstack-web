import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Keeps the site's page plan (scripts/site-tree.md, the template's `scaffold-tree-runner.js` format)
// in step with the pages the site has: a page made anywhere (Pages, the AI, the setup, a site
// command) gets its line, and a page removed loses its line. Lines for pages planned but not made
// yet are left alone: "Create missing pages" makes them from there. Never fails the change that
// called it: a copy without the file, or a write that fails, only skips the update.

export const SITE_TREE = "scripts/site-tree.md";

/** A page's address as a tree path: "/" → index.html, "/blog/" → blog/index.html, "/about.html" → about.html. */
export function treePathOf(address) {
  if (typeof address !== "string" || !address.startsWith("/")) return null;
  const clean = address.split(/[?#]/)[0].replace(/^\/+/, "");
  if (!clean || clean.endsWith("/")) return `${clean}index.html`;
  return /\.html?$/i.test(clean) ? clean : `${clean}/index.html`;
}

/**
 * What a tree line's path stands for, compared case-insensitively. A path without an extension is
 * the page `<path>.html` in the tree's own rules, and a folder's index.html is that folder's page,
 * so both spellings of one page match.
 */
function keysOf(treePath) {
  const value = treePath.trim().replace(/^\/+/, "").toLowerCase();
  if (!value || value.endsWith("/")) return [];
  const page = /\.[a-z0-9]+$/.test(path.posix.basename(value)) ? value : `${value}.html`;
  const keys = new Set([page]);
  if (page.endsWith("/index.html")) keys.add(`${page.slice(0, -"/index.html".length)}.html`);
  return [...keys];
}

/** A bullet's path (before any " — " instruction), or null when the line isn't a bullet. */
function bulletPath(line) {
  const bullet = /^\s*-\s+(.*)$/.exec(line.replace(/\r$/, ""));
  if (!bullet) return null;
  const rest = bullet[1].trim();
  return (/^(.+?)\s+(?:—|--)\s+(.*)$/.exec(rest)?.[1] ?? rest).trim();
}

/**
 * Adds a line for each address in `add` the tree doesn't list yet (at the end, as the template's
 * own `appendToSiteTree` does) and removes the lines of the addresses in `remove`. Returns what
 * changed: `{ added, removed }` tree paths.
 */
export async function updateSiteTree(dir, { add = [], remove = [] }) {
  const file = path.join(dir, SITE_TREE);
  const result = { added: [], removed: [] };
  if (!existsSync(file)) return result;
  try {
    const text = await fs.readFile(file, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const removing = new Set(remove.map(treePathOf).filter(Boolean).flatMap(keysOf));
    const kept = [];
    for (const line of text.split(/\r?\n/)) {
      const p = bulletPath(line);
      if (p && keysOf(p).some((k) => removing.has(k))) result.removed.push(p);
      else kept.push(line);
    }
    const listed = new Set(kept.map(bulletPath).filter(Boolean).flatMap(keysOf));
    for (const address of add) {
      const p = treePathOf(address);
      if (!p || keysOf(p).some((k) => listed.has(k))) continue;
      result.added.push(p);
      keysOf(p).forEach((k) => listed.add(k));
    }
    if (!result.added.length && !result.removed.length) return result;
    while (kept.length && kept.at(-1) === "") kept.pop();
    const lines = [...kept, ...result.added.map((p) => `- ${p}`)];
    await fs.writeFile(file, `${lines.join(eol)}${eol}`);
  } catch (err) {
    console.error(`Couldn't update ${SITE_TREE} in ${dir}:`, err.message);
    return { added: [], removed: [] };
  }
  return result;
}

/** Brings the tree in step with a change to the site's pages, from the addresses before and after it. */
export async function syncSiteTree(dir, before, after) {
  const was = new Set(before);
  const now = new Set(after);
  return updateSiteTree(dir, { add: [...now].filter((a) => !was.has(a)), remove: [...was].filter((a) => !now.has(a)) });
}
