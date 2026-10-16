import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { Router } from "express";
import {
  analyticsLive,
  analyticsReport,
  analyticsSettings,
  analyticsVisits,
  collect,
  deleteAnalyticsData,
  disableAnalytics,
  enableAnalytics,
  filtersOf,
  isSiteCreator,
} from "../analytics.js";
import { EXPORT_FORMATS, exportFileName, exportReport } from "../analytics-export.js";
import { sitePages } from "../navigation.js";
import { getAccessToken } from "../github.js";
import { WorkspaceError, siteIdFor, workspaceDir } from "../workspace.js";
import { handle, keyFor } from "./helpers.js";

// Visit counting (analytics.js). Two routers:
//   collectRouter    public: published sites post their visits here (index.js mounts it)
//   analyticsRouter  the site's Analytics screen, under /api/workspaces/:owner/:repo/analytics.
//                    Every route answers only the site's creator (ownedSite): collaborators who
//                    can open the site, and admins, get a 404.

export const collectRouter = Router();
// sendBeacon posts text/plain, so the request needs no preflight.
collectRouter.post("/:key", express.text({ type: "text/plain", limit: "4kb" }), collect);

export const analyticsRouter = Router({ mergeParams: true });

async function context(req, res) {
  const key = keyFor(req);
  let siteId;
  try {
    siteId = await siteIdFor(key);
  } catch {
    throw new WorkspaceError("Open the site first.", 409);
  }
  // Sites recorded by name only (opened before ids were kept) aren't anyone's: open the site again.
  if (typeof siteId !== "number") throw new WorkspaceError("Not found.", 404);
  return { key, siteId, userId: req.user.id, accessToken: await getAccessToken(req, res) };
}

// Whether to show the Analytics screen at all: only to the site's creator.
analyticsRouter.get(
  "/access",
  handle(async (req, res) => {
    const siteId = await siteIdFor(keyFor(req)).catch(() => null);
    res.json({ creator: typeof siteId === "number" && (await isSiteCreator(siteId, req.user.id)) });
  }),
);

/** The period and filters a request asks for: ?range=<preset>&from=&to=&tz=, plus page, source, device… */
const reportQuery = (req) => ({
  span: { range: req.query.range, from: req.query.from, to: req.query.to },
  tz: req.query.tz,
  filters: filtersOf(req.query),
});

analyticsRouter.get(
  "/",
  handle(async (req, res) => {
    const ctx = await context(req, res);
    const settings = await analyticsSettings(ctx);
    const report = settings.hasData ? await analyticsReport({ ...ctx, ...reportQuery(req) }) : null;
    res.json({ settings, report });
  }),
);

// Visitors in the last 30 minutes and the latest visit, which the screen polls while it's open.
analyticsRouter.get(
  "/live",
  handle(async (req, res) => res.json(await analyticsLive(await context(req, res)))),
);

// "Download full report": the period and filters on screen (same query as GET /) as
// ?format=xlsx (a summary sheet and a sheet per table), pdf (a printable report), csv (one file,
// the tables one after another) or json. All but the PDF include every visit (analytics-export.js).
analyticsRouter.get(
  "/export",
  handle(async (req, res) => {
    const ctx = await context(req, res);
    const format = Object.hasOwn(EXPORT_FORMATS, req.query.format) ? req.query.format : "xlsx";
    const query = reportQuery(req);
    const [report, visits, site] = await Promise.all([analyticsReport({ ...ctx, ...query }), analyticsVisits({ ...ctx, ...query }), siteInfo(ctx.key, req.params.repo)]);
    const file = await exportReport(format, { siteName: site.name, report, visits, titles: site.titles });
    const { extension, type } = EXPORT_FORMATS[format];
    const name = `${exportFileName(site.name, report.period)}.${extension}`;
    res
      .set({ "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": String(file.length), "Cache-Control": "no-store" })
      .send(file);
  }),
);

/** The site's own name (site.config.json → name, else the repo's) and its pages' titles by address. */
async function siteInfo(key, repo) {
  const dir = workspaceDir(key);
  let config = {};
  try {
    config = JSON.parse(await readFile(path.join(dir, "site.config.json"), "utf8"));
  } catch {
    // Unreadable settings: the repo's name, and addresses without titles.
  }
  const titles = new Map();
  for (const page of await sitePages(dir, config).catch(() => [])) {
    // The way the counter records addresses: /x/index.html is /x/.
    if (page.url && page.title) titles.set(page.url.replace(/\/index\.html$/, "/"), page.title);
  }
  const name = typeof config.name === "string" && config.name.trim() ? config.name.trim() : repo;
  return { name, titles };
}

analyticsRouter.post(
  "/enable",
  handle(async (req, res) => res.json({ settings: await enableAnalytics(await context(req, res)) })),
);

analyticsRouter.post(
  "/disable",
  handle(async (req, res) => res.json({ settings: await disableAnalytics(await context(req, res)) })),
);

analyticsRouter.delete(
  "/data",
  handle(async (req, res) => res.json(await deleteAnalyticsData(await context(req, res)))),
);
