import { Router } from "express";
import { config } from "../config.js";
import { creditsForDollars, creditsView } from "../credits.js";
import { createPurchase, listClaudeUsage, listCreditPurchases, usageByProvider } from "../db.js";
import { requireAuth } from "../session.js";
import { CheckoutError, checkoutStatus, startCheckout } from "../stripe.js";
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
 * also carries `summary`: the credits used, merged and split by provider (Claude, DeepSeek, OpenAI).
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

/** `{ dollars }`: a demo purchase (development only). The credits are added at once and nothing is paid. */
creditsRouter.post(
  "/purchases",
  handle(async (req, res) => {
    if (config.purchases !== "demo") return res.status(403).json({ error: "Demo purchases are off." });
    const dollars = req.body?.dollars;
    const credits = creditsForDollars(dollars);
    if (!credits) return res.status(400).json({ error: "Choose an amount the page offers." });
    const purchase = await createPurchase({ userId: req.user.id, buyer: req.user, credits, priceCents: dollars * 100, currency: "usd", provider: "demo" });
    res.status(201).json({ purchase, credits: await creditsView(req.user.id) });
  }),
);

/**
 * `{ dollars, returnTo }`: pays for credits with Stripe (stripe.js). Answers `{ url }`, the payment
 * page to send the browser to; Stripe sends it back to `returnTo` (a path here) with
 * `?checkout=<session id>`, or `?checkout=cancelled`.
 */
creditsRouter.post(
  "/checkout",
  handle(async (req, res) => {
    if (config.purchases !== "stripe") return res.status(403).json({ error: "Buying credits isn't available yet." });
    try {
      res.status(201).json({ url: await startCheckout({ user: req.user, dollars: req.body?.dollars, returnTo: req.body?.returnTo }) });
    } catch (err) {
      if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }),
);

/** The purchase a Checkout Session paid for (checked with Stripe while it's pending) and the balance. */
creditsRouter.get(
  "/checkout/:sessionId",
  handle(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const purchase = config.purchases === "stripe" ? await checkoutStatus(req.user.id, req.params.sessionId) : null;
    if (!purchase) return res.status(404).json({ error: "That payment wasn't found." });
    const { userId: _u, ...view } = purchase;
    res.json({ purchase: view, credits: await creditsView(req.user.id) });
  }),
);

