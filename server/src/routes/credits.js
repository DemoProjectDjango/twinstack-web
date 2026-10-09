import { Router } from "express";
import { config } from "../config.js";
import { CREDITS_PER_USD, MAX_PURCHASE, PURCHASE_STEP, creditsView } from "../credits.js";
import { addPurchasedCredits, listClaudeUsage, listCreditPurchases, usageByProvider } from "../db.js";
import { requireAuth } from "../session.js";
import { handle, requireJson } from "./helpers.js";

// The account's Claude credits: the balance (polled by the navbar while Claude works), buying
// more, and the history of purchases and Claude requests.

export const creditsRouter = Router();
creditsRouter.use(requireAuth, requireJson);

const HISTORY_TYPES = { usage: listClaudeUsage, purchases: listCreditPurchases };

creditsRouter.get(
  "/",
  handle(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await creditsView(req.user.id));
  }),
);

/**
 * `?type=usage|purchases&before=<ISO date>&limit=<1-100>`, newest first. Usage comes a run per
 * item (one job or assistant answer, its credits merged and split by model), and its newest page
 * also carries `summary`: the credits used, merged and split by provider (Claude, DeepSeek).
 */
creditsRouter.get(
  "/history",
  handle(async (req, res) => {
    const list = HISTORY_TYPES[req.query.type];
    if (!list) return res.status(400).json({ error: "Ask for usage or purchases." });
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
    if (before && Number.isNaN(before.getTime())) return res.status(400).json({ error: "That date isn't valid." });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
    const [items, summary] = await Promise.all([
      list(req.user.id, { before, limit }),
      req.query.type === "usage" && !before ? usageByProvider(req.user.id) : null,
    ]);
    res.json({ items, more: items.length === limit, ...(summary && { summary }) });
  }),
);

/**
 * `{ credits }`: a whole number of PURCHASE_STEPs. For now a demo: the credits are added straight
 * away and no payment is taken. A payment provider will create the purchase as pending here and
 * add the credits from its webhook.
 */
creditsRouter.post(
  "/purchases",
  handle(async (req, res) => {
    if (!config.demoPurchases) return res.status(403).json({ error: "Buying credits isn't available yet." });
    const credits = req.body?.credits;
    if (!Number.isInteger(credits) || credits < PURCHASE_STEP || credits > MAX_PURCHASE || credits % PURCHASE_STEP !== 0) {
      return res.status(400).json({
        error: `Choose a multiple of ${PURCHASE_STEP.toLocaleString("en")} credits, up to ${MAX_PURCHASE.toLocaleString("en")}.`,
      });
    }
    const purchase = await addPurchasedCredits({
      userId: req.user.id,
      credits,
      // What the credits are worth in Claude use; nothing is charged in the demo.
      priceCents: Math.round((credits / CREDITS_PER_USD) * 100),
      currency: "usd",
      provider: "demo",
    });
    res.status(201).json({ purchase, credits: await creditsView(req.user.id) });
  }),
);
