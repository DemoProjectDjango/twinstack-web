import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";
import { inside, readText } from "./site-files.js";

// The SEO tab: every page's title, description, focus keyphrase, social image,
// canonical and noindex, as the copy's own scripts/seo.js measures them. The
// script writes its audit to SEO_REPORT (inside .git, so it's never a change)
// whenever it runs with --report, and this module only reads that file back:
// the rules (pixel widths, defaults, scores) live in the copy's scripts/lib/seo.js.

export const SEO_SCRIPT = "scripts/seo.js";
export const SEO_REPORT = ".git/twinstack-seo.json";
const PAGE_SHELL = "templates/partials/base.html";
// base.html renders page.seo (built by scripts/build.js with lib/seo.js); older shells don't.
const SHELL_MARKER = "page.seo.";

// What a copy made before SEO existed needs from the template: the script, its library,
// the build and check that use it, the content loader that marks auto descriptions, and the
// page shell that renders the tags. updateFromTemplate replaces them as uncommitted changes.
export const SEO_FILES = [
  SEO_SCRIPT,
  "scripts/lib/seo.js",
  "scripts/build.js",
  "scripts/check.js",
  "scripts/lib/content.js",
  PAGE_SHELL,
];
export const SEO_MARKERS = { [SEO_SCRIPT]: "--report", "scripts/lib/seo.js": "auditPages", "scripts/build.js": "pageSeo", [PAGE_SHELL]: SHELL_MARKER };
const SEO_NPM_SCRIPTS = {
  seo: "node --env-file-if-exists=.env scripts/seo.js",
  "seo:report": "node scripts/seo.js --html=seo-report.html",
  "seo:claude": "node --env-file-if-exists=.env scripts/seo.js --claude",
  "seo:claude:preview": "node --env-file-if-exists=.env scripts/seo.js --claude --dry-run",
};

// Files whose changes can change the audit: pages, the site's settings, the shell and the rules.
const WATCHED = ["site.config.json", PAGE_SHELL, "scripts/lib/seo.js", "assets/img"];

const LEVELS = new Set(["error", "warning", "tip", "note"]);
const FIELDS = ["metaTitle", "metaDescription", "focusKeyword", "ogImage", "ogImageAlt", "canonical"];
const str = (value, max = 2000) => (typeof value === "string" ? value.slice(0, max) : "");

async function newestChange(dir) {
  let newest = 0;
  const visit = async (full) => {
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(full)) if (!entry.startsWith(".")) await visit(path.join(full, entry));
  };
  for (const target of ["content", ...WATCHED]) await visit(path.join(dir, target));
  return newest;
}

/** The report as the UI uses it, every value checked (the copy's script wrote it). */
function cleanReport(raw) {
  if (!raw || !Array.isArray(raw.pages)) return null;
  const site = raw.site ?? {};
  return {
    createdAt: str(raw.createdAt, 40),
    site: { name: str(site.name, 200), shortName: str(site.shortName, 200), url: str(site.url, 300) },
    limits: raw.limits && typeof raw.limits === "object" ? raw.limits : null,
    summary: {
      pages: Number(raw.summary?.pages) || 0,
      average: Number(raw.summary?.average) || 0,
      errors: Number(raw.summary?.errors) || 0,
      warnings: Number(raw.summary?.warnings) || 0,
    },
    pages: raw.pages.slice(0, 2000).map((page) => ({
      file: str(page.file, 300),
      url: str(page.url, 300),
      absoluteUrl: str(page.absoluteUrl, 400),
      collection: str(page.collection, 100),
      title: str(page.title, 300),
      draft: page.draft === true,
      date: typeof page.date === "string" ? page.date.slice(0, 40) : null,
      fields: {
        ...Object.fromEntries(FIELDS.map((field) => [field, str(page.fields?.[field])])),
        noindex: page.fields?.noindex === true,
      },
      seo: {
        title: str(page.seo?.title),
        defaultTitle: str(page.seo?.defaultTitle),
        description: str(page.seo?.description),
        defaultDescription: str(page.seo?.defaultDescription),
        descriptionSource: ["seo", "page", "body"].includes(page.seo?.descriptionSource) ? page.seo.descriptionSource : "page",
        socialTitle: str(page.seo?.socialTitle),
        image: str(page.seo?.image),
        imagePath: str(page.seo?.imagePath),
        defaultImagePath: str(page.seo?.defaultImagePath),
        imageAlt: str(page.seo?.imageAlt),
        canonical: str(page.seo?.canonical),
        robots: str(page.seo?.robots, 100),
        type: page.seo?.type === "article" ? "article" : "website",
      },
      score: Math.max(0, Math.min(100, Number(page.score) || 0)),
      issues: (Array.isArray(page.issues) ? page.issues : [])
        .filter((issue) => LEVELS.has(issue?.level))
        .slice(0, 50)
        .map((issue) => ({ level: issue.level, field: str(issue.field, 40), message: str(issue.message, 500) })),
    })),
  };
}

/**
 * What the SEO tab shows: whether the copy has scripts/seo.js (`available`) and a page shell that
 * renders its tags (`template`), and the latest audit, `stale` when a page or setting changed after it.
 */
export async function readSeo(key) {
  const dir = workspaceDir(key);
  const available = existsSync(path.join(dir, SEO_SCRIPT));
  const template = ((await readText(path.join(dir, PAGE_SHELL))) ?? "").includes(SHELL_MARKER);
  if (!available) return { available, template, report: null, stale: false };

  const reportPath = path.join(dir, SEO_REPORT);
  let report = null;
  let stale = true;
  try {
    report = cleanReport(JSON.parse((await readText(reportPath)) ?? "null"));
    if (report) stale = (await fs.stat(reportPath)).mtimeMs < (await newestChange(dir));
  } catch {
    report = null;
  }
  return { available, template, report, stale };
}

/**
 * Copies SEO_FILES from the template (`files`: { path: content }) and adds the seo npm scripts.
 * Like the other template updates, these are uncommitted changes the user reviews.
 */
export async function installSeo(key, files) {
  const dir = workspaceDir(key);
  const release = acquire(key, "adding SEO");
  try {
    const written = [];
    for (const file of SEO_FILES) {
      if (typeof files[file] !== "string") throw new WorkspaceError(`${file} is missing from the template.`, 409);
      const target = inside(dir, file);
      if ((await readText(target)) === files[file]) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, files[file]);
      written.push(file);
    }
    const packagePath = path.join(dir, "package.json");
    const packageText = await readText(packagePath);
    if (packageText !== null) {
      const pkg = JSON.parse(packageText);
      const missing = Object.entries(SEO_NPM_SCRIPTS).filter(([name]) => !pkg.scripts?.[name]);
      if (pkg.scripts && missing.length) {
        Object.assign(pkg.scripts, Object.fromEntries(missing));
        const eol = packageText.includes("\r\n") ? "\r\n" : "\n";
        await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`.replace(/\n/g, eol));
        written.push("package.json");
      }
    }
    return { written };
  } finally {
    release();
  }
}
