import express, { Router } from "express";
import { getAccessToken } from "../github.js";
import { MAX_BATCH_BYTES, MAX_SMALL_BYTES } from "../site-agent-rules.js";
import { agentAsk, agentEvents, agentForget, forgetAgentVisitorsFor, rereadAgentSite, agentHistory, agentOutcome, agentView, deleteAgentData, disableAgent, enableAgent, saveAgentSettings } from "../site-agent.js";
import { WorkspaceError, siteIdFor } from "../workspace.js";
import { handle, keyFor } from "./helpers.js";

// The site agent (site-agent.js). Two routers:
//   agentPublicRouter  public: published sites' widget (assets/js/agent.js) posts here (index.js
//                      mounts it on /api/agent). text/plain bodies, so no preflight; the answer
//                      carries CORS only for the hosts the site is published at.
//   agentRouter        the Site agent screen, under /api/workspaces/:owner/:repo/agent. Every
//                      route answers only the site's creator: anyone else gets a 404.

export const agentPublicRouter = Router();
const batchBody = express.text({ type: "text/plain", limit: MAX_BATCH_BYTES });
const smallBody = express.text({ type: "text/plain", limit: MAX_SMALL_BYTES });
// A too-large or unreadable body is dropped like any other bad request: 204, nothing said.
const quietErrors = (err, req, res, next) => (res.headersSent ? next(err) : res.status(204).end());

agentPublicRouter.post("/:key/events", batchBody, agentEvents, quietErrors);
agentPublicRouter.post("/:key/ask", smallBody, agentAsk, quietErrors);
agentPublicRouter.post("/:key/outcome", smallBody, agentOutcome, quietErrors);
agentPublicRouter.post("/:key/forget", smallBody, agentForget, quietErrors);

export const agentRouter = Router({ mergeParams: true });

async function context(req, res) {
  const key = keyFor(req);
  let siteId;
  try {
    siteId = await siteIdFor(key);
  } catch {
    throw new WorkspaceError("Open the site first.", 409);
  }
  if (typeof siteId !== "number") throw new WorkspaceError("Not found.", 404);
  return { key, siteId, userId: req.user.id, accessToken: await getAccessToken(req, res) };
}

agentRouter.get(
  "/",
  handle(async (req, res) => res.json(await agentView(await context(req, res)))),
);

agentRouter.put(
  "/settings",
  handle(async (req, res) => res.json(await saveAgentSettings(await context(req, res), req.body ?? {}))),
);

agentRouter.post(
  "/enable",
  handle(async (req, res) => res.json(await enableAgent(await context(req, res)))),
);

agentRouter.post(
  "/reread",
  handle(async (req, res) => res.json(await rereadAgentSite(await context(req, res)))),
);

agentRouter.post(
  "/disable",
  handle(async (req, res) => res.json(await disableAgent(await context(req, res)))),
);

// ?from=&to= (instants) and ?before= (the previous page's `next`).
agentRouter.get(
  "/history",
  handle(async (req, res) => {
    const ctx = await context(req, res);
    res.json(await agentHistory(ctx, { from: req.query.from, to: req.query.to, before: req.query.before, tz: req.query.tz }));
  }),
);

// The owner forgets remembered visitors: all of them, or one by its History ref.
agentRouter.delete(
  "/visitors",
  handle(async (req, res) => res.json(await forgetAgentVisitorsFor(await context(req, res)))),
);

agentRouter.delete(
  "/visitors/:ref",
  handle(async (req, res) => res.json(await forgetAgentVisitorsFor(await context(req, res), req.params.ref))),
);

agentRouter.delete(
  "/data",
  handle(async (req, res) => res.json(await deleteAgentData(await context(req, res)))),
);
