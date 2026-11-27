// Builds each starter kit's preview: the kit applied to a copy of the site template with sample
// business details, built by the template's own build.js and checked by its check.js, into
// server/kits/<id>/preview/ (committed: the server only serves it, at /api/kit-preview/<id>/).
// Run after changing a kit or the template:  npm --prefix server run kits:build
// The template is the local twinstack-site checkout beside this repo (with node_modules), or
// TWINSTACK_SITE_DIR.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    for (const page of kit.pages) await fs.copyFile(path.join(kitDir, "pages", page.file), path.join(work, pagesDir, page.file));
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

    const out = path.join(kitDir, "preview");
    await fs.rm(out, { recursive: true, force: true });
    await fs.cp(path.join(work, "dist"), out, { recursive: true });
    console.log(`✔ ${kit.id}: preview built (${kit.pages.length} pages)`);
  } catch (err) {
    failed = true;
    console.error(`✖ ${kit.id}: ${err.message}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
