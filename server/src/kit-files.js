import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// No server imports: kits:build (scripts/build-kit-previews.js) uses this without the env.

const DATA_FILE = /^[a-z0-9-]+\.json$/;
const IMAGE_FILE = /^[a-z0-9-]+\.(webp|jpe?g|png|svg)$/;

/**
 * Copies a kit's data files (kit.json → `data`, from data/ to content/data/, only those the site
 * doesn't have, so a page's loops have items) and its photos (images/ to assets/img/kit/<id>/,
 * which its pages name). Shared with kits:build, so the preview is what a site gets.
 */
export async function copyKitFiles(kit, siteDir) {
  for (const name of Array.isArray(kit.data) ? kit.data : []) {
    if (!DATA_FILE.test(name) || name === "navigation.json" || name === "scripts.json") continue;
    const target = path.join(siteDir, "content", "data", name);
    if (existsSync(target)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(kit.dir, "data", name), target);
  }
  const images = await fs.readdir(path.join(kit.dir, "images")).catch(() => []);
  if (!images.length) return;
  const into = path.join(siteDir, "assets", "img", "kit", kit.id);
  await fs.mkdir(into, { recursive: true });
  for (const name of images) if (IMAGE_FILE.test(name)) await fs.copyFile(path.join(kit.dir, "images", name), path.join(into, name));
}

const PHOTO_PATH = /^\/assets\/img\/[\w./-]+$/;

/**
 * Puts the owner's own photos in place of a kit's: `photos` (site paths such as
 * /assets/img/uploads/shop.jpg, in the order the owner added them) take the kit's `photos` slots in
 * order, each replacing that slot's picture (assets/img/kit/<id>/<file>) wherever the site's pages
 * and data files use it. A data item whose image is swapped gets an empty `imageAlt`, since the old
 * description no longer matches. Photos that aren't there, or that aren't site paths, are skipped.
 * Resolves to how many pictures were replaced.
 */
export async function swapKitPhotos(kit, siteDir, photos, { pagesDir = "content/pages" } = {}) {
  const slots = Array.isArray(kit.photos) ? kit.photos : [];
  const swaps = [];
  for (const photo of Array.isArray(photos) ? photos : []) {
    if (swaps.length >= slots.length) break;
    if (typeof photo !== "string" || !PHOTO_PATH.test(photo) || photo.split("/").includes("..")) continue;
    if (!existsSync(path.join(siteDir, photo))) continue;
    swaps.push([`/assets/img/kit/${kit.id}/${slots[swaps.length].file}`, photo]);
  }
  if (!swaps.length) return 0;
  const replaced = new Set();
  const dataDir = path.join(siteDir, "content", "data");
  for (const name of await fs.readdir(path.join(siteDir, pagesDir)).catch(() => [])) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(siteDir, pagesDir, name);
    const text = await fs.readFile(file, "utf8");
    let next = text;
    for (const [from, to] of swaps) if (next.includes(from)) (next = next.split(from).join(to)), replaced.add(from);
    if (next !== text) await fs.writeFile(file, next);
  }
  for (const name of await fs.readdir(dataDir).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dataDir, name);
    let data;
    try {
      data = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    let changed = false;
    for (const item of Array.isArray(data?.items) ? data.items : []) {
      const swap = swaps.find(([from]) => item?.image === from);
      if (!swap) continue;
      item.image = swap[1];
      if ("imageAlt" in item) item.imageAlt = "";
      replaced.add(swap[0]);
      changed = true;
    }
    if (changed) await fs.writeFile(file, `${JSON.stringify(data, null, 2)}
`);
  }
  return replaced.size;
}
