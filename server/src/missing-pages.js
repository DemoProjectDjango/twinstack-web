import fs from "node:fs/promises";
import path from "node:path";
import { sitePages } from "./navigation.js";
import { listingOf, readText } from "./site-files.js";
import { workingTreeFingerprint, workspaceDir } from "./workspace.js";

// Pages the site links to but doesn't have, found in the built site after every build the editor
// runs (the "preview" and "check" commands' onEnd), so the editor can offer to make them right
// after the change that added the link, on whatever screen the owner is on. It reads dist/ the way
// the copy's scripts/check.js does (a link without an extension is a folder, /about → /about/),
// but takes both quote styles and doesn't depend on check.js's wording or on the Publish screen.
// Links to files that aren't pages (images, PDFs) are left to the Publish screen's check.
// The same scan lists the pages nothing links to and pages that share an address, for the
// Pages screen.

export const MISSING_REPORT = ".git/twinstack-missing.json";
const MAX_MISSING = 50;
const MAX_FROM = 8;
const MAX_HTML_FILES = 2000;

const normalized = (url) => (url.endsWith("/") || path.posix.extname(url) ? url : `${url}/`);

/** Every file under dist/, as the URLs it's served at, and the HTML files with their own URL. */
async function walk(dist) {
  const served = new Set();
  const pages = [];
  async function visit(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await visit(full, `${prefix}/${entry.name}`);
        continue;
      }
      if (entry.name === "index.html") served.add(`${prefix}/`);
      else served.add(`${prefix}/${entry.name}`);
      if (entry.name.endsWith(".html") && pages.length < MAX_HTML_FILES) pages.push({ full, url: entry.name === "index.html" ? `${prefix}/` : `${prefix}/${entry.name}` });
    }
  }
  await visit(dist, "");
  return { served, pages };
}

const LINK = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();

/** Finds the missing pages in the workspace's dist/ and saves them (MISSING_REPORT). */
export async function scanMissingPages(key) {
  const dir = workspaceDir(key);
  const dist = path.join(dir, "dist");
  const { served, pages } = await walk(dist);
  // A build in development mode prefixes links with /dist (the copy's basePath()).
  const devPrefix = !served.has("/dist/") && !(await fs.stat(path.join(dist, "dist")).catch(() => null));

  let site = {};
  try {
    site = JSON.parse((await readText(path.join(dir, "site.config.json"))) ?? "{}");
  } catch {
    // The build reported that already.
  }
  const known = await sitePages(dir, site).catch(() => []);
  const listings = Object.keys(site.collections ?? {}).map((name) => listingOf(site, name)).filter(Boolean);
  const pageAt = (url) => known.find((p) => normalized(p.url) === normalized(url)) ?? null;

  const missing = new Map();
  // Every address some other visible page links to (a menu, a footer and a listing page count).
  const linked = new Set();
  for (const page of pages) {
    const html = await fs.readFile(page.full, "utf8").catch(() => "");
    // A hidden page's links don't count: visitors never see them.
    const fromHidden = pageAt(page.url)?.draft === true;
    for (const m of html.matchAll(LINK)) {
      const raw = HREF.exec(m[1]);
      let href = (raw?.[1] ?? raw?.[2] ?? "").trim().split(/[#?]/)[0];
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      if (devPrefix && href.startsWith("/dist/")) href = href.slice(5) || "/";
      const extension = path.posix.extname(href).toLowerCase();
      // Only links to pages: files are for the Publish screen's check.
      if (extension && extension !== ".html") continue;
      if (!fromHidden && normalized(href) !== normalized(page.url)) linked.add(normalized(href));
      if (served.has(normalized(href)) || served.has(href)) continue;
      const key = normalized(href);
      if (!missing.has(key)) {
        if (missing.size >= MAX_MISSING) continue;
        const listing = listings.find((l) => normalized(l.url) === key);
        const hidden = known.find((p) => p.draft && normalized(p.url) === key);
        missing.set(key, {
          href,
          // How to make it: the homepage and listing pages have their own address rules.
          kind: key === "/" ? "home" : listing ? "listing" : "page",
          ...(listing && { collection: listing.collection }),
          ...(hidden && { hidden: { file: hidden.file, title: hidden.title } }),
          label: "",
          from: [],
        });
      }
      const entry = missing.get(key);
      if (!entry.label) entry.label = textOf(m[2]).slice(0, 80);
      const from = pageAt(page.url);
      if (entry.from.length < MAX_FROM && !entry.from.some((f) => f.url === page.url)) {
        entry.from.push({ url: page.url, file: from?.file ?? null, title: from?.title ?? page.url });
      }
    }
  }

  const report = {
    scannedAt: new Date().toISOString(),
    fingerprint: await workingTreeFingerprint(key),
    // Hidden pages exist: they only need showing, so they aren't offered for creating.
    missing: [...missing.values()].filter((m) => !m.hidden),
    // Visible pages no other page links to: reachable only by their address or from search.
    // The homepage is the way in, so it never counts.
    unlinked: known
      .filter((p) => !p.draft && normalized(p.url) !== "/" && !linked.has(normalized(p.url)))
      .map(({ file, title, url }) => ({ file, title, url })),
    // Pages at one address (/pricing and /pricing/ build the same file): only one of them shows.
    duplicates: [...known.reduce((groups, p) => groups.set(normalized(p.url), [...(groups.get(normalized(p.url)) ?? []), p]), new Map()).values()]
      .filter((group) => group.length > 1)
      .map((group) => group.map(({ file, title, url, draft }) => ({ file, title, url, draft }))),
  };
  await fs.writeFile(path.join(dir, MISSING_REPORT), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** The last scan, and whether the site changed since (`fresh`). */
export async function readMissingPages(key) {
  const text = await readText(path.join(workspaceDir(key), MISSING_REPORT));
  let report = null;
  try {
    report = text ? JSON.parse(text) : null;
  } catch {
    // Unreadable: as good as never scanned.
  }
  if (!report) return { report: null, fresh: false };
  return { report, fresh: report.fingerprint === (await workingTreeFingerprint(key)) };
}
