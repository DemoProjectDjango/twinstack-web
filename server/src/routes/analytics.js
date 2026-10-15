import express, { Router } from "express";
import {
  analyticsReport,
  analyticsSettings,
  collect,
  deleteAnalyticsData,
  disableAnalytics,
  enableAnalytics,
  isSiteCreator,
} from "../analytics.js";
import { getAccessToken } from "../github.js";
import { WorkspaceError, siteIdFor } from "../workspace.js";
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

analyticsRouter.get(
  "/",
  handle(async (req, res) => {
    const ctx = await context(req, res);
    const settings = await analyticsSettings(ctx);
    const report = settings.hasData ? await analyticsReport({ ...ctx, days: req.query.range }) : null;
    res.json({ settings, report });
  }),
);

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
