import { Router } from "express";
import { requireAuth, requireGithub } from "../session.js";
import { planSetup, previewSetup, skillsCatalog } from "../site-setup.js";
import { handle, requireJson } from "./helpers.js";

// A new site's setup, asked before the site exists (the client's SetupFlow, from Create a new site):
// the skills it asks from, the AI's analysis after the owner's name, what they do and their brief,
// and the review's preview of what gets saved (site-setup.js). The answers are saved once the site
// has opened, through the workspace's POST …/setup.

export const setupRouter = Router();
setupRouter.use(requireAuth, requireGithub, requireJson);

setupRouter.get(
  "/skills",
  handle(async (req, res) => {
    res.set("Cache-Control", "private, max-age=300");
    res.json({ skills: skillsCatalog() });
  }),
);

setupRouter.post(
  "/plan",
  handle(async (req, res) => {
    const { name, what, brief } = req.body ?? {};
    res.json(await planSetup({ userId: req.user.id, name, what, brief }));
  }),
);

setupRouter.post(
  "/preview",
  handle(async (req, res) => res.json(previewSetup(req.body))),
);
