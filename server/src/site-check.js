import fs from "node:fs/promises";
import path from "node:path";
import { sitePages } from "./navigation.js";
import { listingOf, readText } from "./site-files.js";
import { workingTreeFingerprint, workspaceDir } from "./workspace.js";

// The site check: the "check" command builds the site and runs the copy's scripts/check.js, the
// same check the deploy workflow runs before it publishes, so a site that fails it never updates.
// What it found is saved (CHECK_REPORT) for the Publish screen and Claude: each "  error    …" line
// as a problem with the page it's on and what it points at. Lines this doesn't recognise are kept
// as printed. `fingerprint` tells whether anything changed since.

export const CHECK_REPORT = ".git/twinstack-check.json";
const MAX_PROBLEMS = 100;
const MAX_WARNINGS = 100;
const FAILURE_LINES = 25;

const STEP = /^\$ node scripts\/(\S+)/;
const ERROR = /^\s*error\s{2,}(.+?)\s*$/;
const WARNING = /^\s*warning\s{2,}(.+?)\s*$/;
const MISSING_LINK = /^(\S+) links to missing (\S+)$/;
const DUPLICATE = /^duplicate URL (\S+): (.+) and (.+)$/;
const NO_DATE = /^(.+): blog post without a date$/;

/** Each step's output lines, by script ("build.js", "check.js"). */
function stepOutput(output) {
  const steps = new Map();
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const step = line.match(STEP);
    if (step) {
      current = step[1];
      steps.set(current, []);
    } else if (current) {
      steps.get(current).push(line);
    }
  }
  return steps;
}

const tail = (lines) =>
  lines
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-FAILURE_LINES)
    .join("\n");

/** An address as check.js compares them: one without a file extension is a folder, ending in "/". */
const normalized = (url) => (url.endsWith("/") || path.posix.extname(url) ? url : `${url}/`);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a page's own file links to `href` (Markdown, HTML or a setting), rather than the site's design doing it. */
function mentions(source, href) {
  const at = `${escapeRegExp(href)}(?:[#?][^\\s"')>]*)?`;
  return new RegExp(`\\]\\(\\s*<?${at}>?(?:\\s|\\))|(?:href|src)\\s*=\\s*["']${at}["']|^[\\w-]+:\\s*["']?${at}["']?\\s*$`, "m").test(source);
}

const slash = (file) => file.trim().replaceAll("\\", "/");

/** One error line as a problem the editor can explain and offer a fix for. */
async function describe(message, { pages, listings, dir }) {
  const byUrl = (url) => pages.find((p) => normalized(p.url) === normalized(url)) ?? null;
  const byFile = (file) => ({ file, title: pages.find((p) => p.file === file)?.title ?? file });

  const missing = message.match(MISSING_LINK);
  if (missing) {
    const [, from, href] = missing;
    const page = byUrl(from);
    // A hidden page isn't in the published site. "/" with no page there means no homepage at all,
    // and a collection's listing address (/blog.html) no listing page.
    const hidden = pages.find((p) => p.draft && normalized(p.url) === normalized(href));
    const listing = listings.find((l) => normalized(l.url) === normalized(href));
    const extension = path.posix.extname(href).toLowerCase();
    const target = hidden
      ? "hidden"
      : normalized(href) === "/"
        ? "home"
        : listing
          ? "listing"
          : !extension || extension === ".html"
            ? "page"
            : "file";
    const source = page ? await readText(path.join(dir, page.file)).catch(() => null) : null;
    return {
      kind: "missing-link",
      message,
      href,
      target,
      ...(hidden && { hiddenPage: { file: hidden.file, title: hidden.title } }),
      ...(target === "listing" && { listing: { collection: listing.collection, label: listing.label } }),
      page: page && { file: page.file, title: page.title, url: page.url },
      // Otherwise the link comes from the site's design: the logo, menu, footer or a layout.
      inPageText: Boolean(source && mentions(source, href)),
    };
  }
  const duplicate = message.match(DUPLICATE);
  if (duplicate) {
    return { kind: "duplicate", message, url: duplicate[1], pages: [duplicate[2], duplicate[3]].map((file) => byFile(slash(file))) };
  }
  const noDate = message.match(NO_DATE);
  if (noDate) return { kind: "no-date", message, page: byFile(slash(noDate[1])) };
  return { kind: "other", message };
}

/** The check job's result as a report. */
export async function checkReport(key, { exitCode, output }) {
  const dir = workspaceDir(key);
  const steps = stepOutput(output);
  const check = steps.get("check.js");
  const errors = [...new Set((check ?? []).map((line) => line.match(ERROR)?.[1]).filter(Boolean))];
  const warnings = [...new Set((check ?? []).map((line) => line.match(WARNING)?.[1]).filter(Boolean))];

  let pages = [];
  let listings = [];
  try {
    const site = JSON.parse((await readText(path.join(dir, "site.config.json"))) ?? "{}");
    pages = await sitePages(dir, site);
    listings = Object.keys(site.collections ?? {})
      .map((name) => listingOf(site, name))
      .filter(Boolean);
  } catch {
    // A config the build couldn't read either: the failure says so.
  }
  const problems = [];
  for (const message of errors.slice(0, MAX_PROBLEMS)) problems.push(await describe(message, { pages, listings, dir }));

  return {
    checkedAt: new Date().toISOString(),
    fingerprint: await workingTreeFingerprint(key),
    ok: exitCode === 0,
    // The build failed, so the check never ran.
    buildFailed: !check,
    // What the build (or a check that failed without listing problems) printed last.
    failure: !check ? tail(steps.get("build.js") ?? output.split(/\r?\n/)) : exitCode !== 0 && !errors.length ? tail(check) : null,
    problems,
    moreProblems: Math.max(0, errors.length - MAX_PROBLEMS),
    warnings: warnings.slice(0, MAX_WARNINGS),
  };
}

/** Saves what a finished check job found (the "check" command's onEnd). */
export async function saveCheckReport(key, result) {
  const report = await checkReport(key, result);
  await fs.writeFile(path.join(workspaceDir(key), CHECK_REPORT), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** The latest check, and whether it's still current: `fresh` is false once a file changed since. */
export async function readCheckReport(key) {
  const text = await readText(path.join(workspaceDir(key), CHECK_REPORT));
  let report = null;
  try {
    report = text ? JSON.parse(text) : null;
  } catch {
    // Unreadable: as good as never checked.
  }
  if (!report) return { report: null, fresh: false };
  return { report, fresh: report.fingerprint === (await workingTreeFingerprint(key)) };
}
