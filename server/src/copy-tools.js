// Copying a website, uploading one as a zip and bringing a page in all run the site's own converter
// (scripts/edit-page.js and its libraries). A site that hasn't installed the latest site update
// would convert with an older one, and the fixes to copied headers and footers wouldn't reach it.
// So before those run, the converter's files are brought up to the template's newest version:
// only files twinstack-update.json gives the template (they're never the owner's), written as
// ordinary unpublished changes, plus the template's migrations. Nothing happens when they match.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { jobEnv } from "./commands.js";
import { ownerOf, readManifest } from "./site-update.js";
import { git, tryGit, workspaceDir } from "./workspace.js";

const execFileAsync = promisify(execFile);
const REF = "refs/twinstack/copy-tools";
const MANIFEST = "twinstack-update.json";

// What the converter and the pages it makes use: every script and library, the page shell and
// layouts, and the scripts copied pages load.
const TOOLS = [/^scripts\//, /^templates\/layouts\//, /^templates\/partials\/(base|not-found)\.html$/, /^assets\/js\/[^/]+\.js$/];

/**
 * Brings the site's copying tools up to the template's newest version. Returns the files written
 * ([] when they were current). `log` gets one plain line when something changed. Never throws for
 * a template that can't be reached: copying then goes on with the tools the site has.
 */
// Checked at most every few minutes per copy of a site: bringing pages in calls this for each page.
const checkedAt = new Map();
const RECHECK_MS = 5 * 60_000;

export async function updateCopyTools(key, templateToken, log = () => {}) {
  if (Date.now() - (checkedAt.get(key) ?? 0) < RECHECK_MS) return [];
  checkedAt.set(key, Date.now());
  const dir = workspaceDir(key);
  try {
    await git(dir, ["fetch", "--quiet", "--no-tags", `https://github.com/${config.siteTemplate}.git`, `+HEAD:${REF}`], { accessToken: templateToken });
  } catch {
    return [];
  }
  try {
    const manifest = readManifest(await git(dir, ["show", `${REF}:${MANIFEST}`]));
    const files = (await git(dir, ["ls-tree", "-r", "--name-only", "--full-tree", REF])).split("\n").filter(Boolean);
    const written = [];
    for (const file of files) {
      if (!TOOLS.some((re) => re.test(file)) || ownerOf(manifest, file) !== "template") continue;
      const content = await blob(dir, `${REF}:${file}`);
      const target = path.join(dir, file);
      const current = await fs.readFile(target).catch(() => null);
      if (current && current.equals(content)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      written.push(file);
    }
    if (written.length) {
      log(`Brought this site's copying tools up to date (${written.length} files), so copied headers and footers come in right.`);
      // The template's migrations reshape the site's own files for the new tools, as a site update does.
      if (existsSync(path.join(dir, "scripts", "migrate.js"))) {
        await execFileAsync(process.execPath, ["scripts/migrate.js"], { cwd: dir, env: jobEnv(null, null), timeout: 120_000 }).catch(() => {});
      }
    }
    return written;
  } catch {
    return [];
  } finally {
    await tryGit(dir, ["update-ref", "-d", REF]);
  }
}

async function blob(dir, spec) {
  const { stdout } = await execFileAsync("git", ["show", spec], { cwd: dir, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** The same as a job step, run before copying a website. */
export function copyToolsStep(key, templateToken) {
  return {
    display: "Checking this site's copying tools",
    run: async ({ log }) => {
      checkedAt.delete(key);
      await updateCopyTools(key, templateToken, log);
    },
  };
}
