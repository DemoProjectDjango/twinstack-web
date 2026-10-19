import { Router } from "express";
import { config } from "../config.js";
import { CREDITS_PER_PAID_USD, CREDITS_PER_USD, PLATFORM_SHARE, purchaseMoney, totalsMoney } from "../credits.js";
import { PURCHASE_STATUSES, listAccessRequests, listAllPurchases, publicUser, purchaseTotals, requestAccess, setAccessStatus } from "../db.js";
import { sendEmail } from "../email.js";
import { FastModelError, fastModelView, setFastModel } from "../fast-model.js";
import { ImageModelError, imageModelView, setImageModel } from "../image-model.js";
import { ProviderHealthError, checkProviderCosts, creditActivityReport, providerHealth, setProviderBalance } from "../provider-health.js";
import { INSIGHT_PERIODS, purchaseInsights } from "../purchase-insights.js";
import { siteModelOverrides, usageByModel } from "../db.js";
import { PURCHASE_EXPORT_FORMATS, exportPurchases, purchasesFileName } from "../purchases-export.js";
import { requireAuth } from "../session.js";
import { zoneOf } from "../zoned-days.js";
import { requireJson } from "./helpers.js";

// Who may create sites. An account asks once (POST /api/access/request), which emails the admins
// (ADMIN_EMAILS); an admin approves or denies it on /admin/access, which emails the account.
// Approving is a POST from that page, never a link in an email: mail scanners open links.
// Admins also pick the cheaper "fast" model (DeepSeek or OpenAI) on /admin/models (fast-model.js),
// and the image model pictures are made with (image-model.js). Both are defaults sites can override.
// And they see every account's credit purchases on /admin/purchases, and whether the app's own
// provider keys have the balance to keep going on /admin/providers (provider-health.js).

const MAX_MESSAGE = 500;

export const accessRouter = Router();
accessRouter.use(requireAuth, requireJson);

accessRouter.post("/request", async (req, res) => {
  const { status } = req.user.access;
  if (status !== "none") {
    return res.status(409).json({ error: status === "pending" ? "Your request has already been sent." : "Your account already has an answer." });
  }
  const raw = req.body?.message;
  const message = typeof raw === "string" ? raw.trim().slice(0, MAX_MESSAGE) : "";
  try {
    if (!(await requestAccess(req.user.id, message))) {
      return res.status(409).json({ error: "Your request has already been sent." });
    }
  } catch (err) {
    console.error("Failed to save an access request:", err);
    return res.status(500).json({ error: "Your request couldn't be sent. Please try again." });
  }

  const who = req.user.name ? `${req.user.name} (${req.user.email})` : req.user.email;
  void sendEmail({
    to: config.adminEmails,
    subject: `Twinstack: ${who} asks to create websites`,
    text: [
      `${who} asked for access to create websites on Twinstack.`,
      req.user.github ? `GitHub: @${req.user.github.login}` : "GitHub: not connected yet",
      message ? `\nTheir message:\n${message}` : "",
      `\nApprove or deny it here: ${config.clientUrl}/admin/access`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  res.json({ access: { status: "pending", requestedAt: new Date().toISOString() } });
});

export const adminRouter = Router();
adminRouter.use(requireAuth, requireJson, (req, res, next) => {
  if (!req.user.admin) return res.status(403).json({ error: "Only an admin can do that." });
  next();
});

adminRouter.get("/access", async (req, res) => {
  res.json({ requests: await listAccessRequests() });
});

adminRouter.post("/access/:id", async (req, res) => {
  const status = req.body?.status;
  if (status !== "approved" && status !== "denied") {
    return res.status(400).json({ error: 'Status must be "approved" or "denied".' });
  }
  const account = await setAccessStatus(req.params.id, status, req.user.email);
  if (!account) return res.status(404).json({ error: "There's no such account." });

  const user = publicUser(account);
  const greeting = user.name ? `Hi ${user.name.trim().split(/\s+/)[0]},` : "Hi,";
  const emailed = await sendEmail(
    status === "approved"
      ? {
          to: user.email,
          subject: "You can now create your website on Twinstack",
          text: [
            greeting,
            "",
            "Good news: your Twinstack account has been approved. You can now create your website.",
            "",
            user.github
              ? `Open ${config.clientUrl}/dashboard and click "Create my site".`
              : `Open ${config.clientUrl}/dashboard, connect GitHub (it's free, and the page explains each step), then click "Create my site".`,
          ].join("\n"),
        }
      : {
          to: user.email,
          subject: "About your Twinstack request",
          text: [greeting, "", "Sorry, we can't give your account access to create websites at the moment."].join("\n"),
        },
  );
  res.json({ requests: await listAccessRequests(), emailed });
});

adminRouter.get("/models", (req, res) => {
  res.json(fastModelView());
});

adminRouter.put("/models", async (req, res) => {
  const model = req.body?.model;
  if (typeof model !== "string" || !model) return res.status(400).json({ error: "Choose a model." });
  try {
    await setFastModel(model, req.user.email);
  } catch (err) {
    if (!(err instanceof FastModelError)) throw err;
    return res.status(400).json({ error: err.message });
  }
  res.json(fastModelView());
});

// Every account's credit purchases (stripe.js): `?status=&provider=stripe|demo&mode=live|test&q=`
// narrow the list, `before` (an ISO date) and `limit` page it, newest first. The first page also has
// the totals. /purchases/export downloads the whole filtered list as PDF, Excel or CSV.
function purchaseFilters(query) {
  const pick = (value, allowed) => (typeof value === "string" && allowed.includes(value) ? value : null);
  const before = typeof query.before === "string" ? new Date(query.before) : null;
  return {
    status: pick(query.status, PURCHASE_STATUSES),
    provider: pick(query.provider, ["stripe", "demo"]),
    mode: pick(query.mode, ["live", "test"]),
    q: typeof query.q === "string" ? query.q.slice(0, 200) : "",
    before: before && !Number.isNaN(before.getTime()) ? before : null,
  };
}

adminRouter.get("/purchases", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const filters = purchaseFilters(req.query);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
  const [items, totals] = await Promise.all([listAllPurchases({ ...filters, limit }), filters.before ? null : purchaseTotals()]);
  res.json({
    // Each with its real money (credits.js purchaseMoney): paid, credits' value, refunds, kept, Stripe's fee, profit.
    items: items.map((p) => ({ ...p, money: purchaseMoney(p) })),
    more: items.length === limit,
    ...(totals && {
      totals: { ...totals, allTime: moneyByMode(totals.allTime), last30Days: moneyByMode(totals.last30Days) },
      purchases: config.purchases,
      pricing: { platformShare: PLATFORM_SHARE, creditsPerPaidUsd: CREDITS_PER_PAID_USD, creditsPerUsd: CREDITS_PER_USD },
    }),
  });
});

const moneyByMode = ({ live, test }) => ({ live: totalsMoney(live), test: totalsMoney(test) });

// `?days=7|30|90|365&mode=live|test&tz=<IANA zone>`: the Purchases page's summary for that period
// (purchase-insights.js): profit, the period before to compare, a chart series, top buyers and how
// many purchases are in each status.
adminRouter.get("/purchases/insights", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const days = INSIGHT_PERIODS[req.query.days] ?? 30;
  res.json(await purchaseInsights({ days, live: req.query.mode !== "test", tz: req.query.tz }));
});

// `?format=pdf|xlsx|csv&tz=<IANA zone>` and the list's filters: every matching purchase as a
// file (purchases-export.js), dates in the admin's time zone.
adminRouter.get("/purchases/export", async (req, res) => {
  const format = typeof req.query.format === "string" && PURCHASE_EXPORT_FORMATS[req.query.format] ? req.query.format : null;
  if (!format) return res.status(400).json({ error: "Choose PDF, Excel or CSV." });
  const filters = purchaseFilters(req.query);
  const items = await listAllPurchases({ ...filters, before: null, limit: 10_000 });
  const generatedAt = new Date();
  const body = await exportPurchases(format, { items, filters: filtersWords(filters), zone: zoneOf(req.query.tz), generatedAt });
  res.set("Cache-Control", "no-store");
  res.attachment(purchasesFileName(format, generatedAt));
  res.type(PURCHASE_EXPORT_FORMATS[format].type).send(body);
});

/** The list's filters in words, for the downloads: "Status: paid; Live payments; Search: ann". */
function filtersWords({ status, provider, mode, q }) {
  return [
    status && `Status: ${status}`,
    provider && (provider === "demo" ? "Demo purchases" : "Stripe purchases"),
    mode && (mode === "live" ? "Live payments" : "Test payments"),
    q && `Search: ${q}`,
  ]
    .filter(Boolean)
    .join("; ");
}

// The app's provider balances, spend, runway, refusals and daily cost checks. `?fresh=1` asks
// DeepSeek for its balance again; POST /providers/check also runs the cost check now.
adminRouter.get("/providers", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await providerHealth({ fresh: req.query.fresh === "1" }));
});

// `?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA zone>`: credits bought and used in that range, per day,
// per provider and per account (the AI providers page's "Credits by date").
adminRouter.get("/providers/activity", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(await creditActivityReport({ from: req.query.from, to: req.query.to, tz: req.query.tz }));
  } catch (err) {
    if (!(err instanceof ProviderHealthError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

adminRouter.post("/providers/check", async (req, res) => {
  await checkProviderCosts();
  res.json(await providerHealth({ fresh: true }));
});

// `{ amountUsd?, autoReload? }`: the balance read off Anthropic's or OpenAI's billing page, counted
// down from now by what the app records.
adminRouter.put("/providers/:provider/balance", async (req, res) => {
  try {
    await setProviderBalance(req.params.provider, { amountUsd: req.body?.amountUsd, autoReload: req.body?.autoReload }, req.user.email);
  } catch (err) {
    if (!(err instanceof ProviderHealthError)) throw err;
    return res.status(400).json({ error: err.message });
  }
  res.json(await providerHealth());
});

// `?days=7|30|90`: what each model did on the app's keys in that time (requests, credits, tokens),
// and how many sites chose their own fast and image models: the AI models page's usage, cost
// comparison and override counts.
adminRouter.get("/models/usage", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const [models, overrides] = await Promise.all([usageByModel(new Date(Date.now() - days * 24 * 60 * 60 * 1000)), siteModelOverrides()]);
  res.json({ days, models, overrides });
});

// The image model pictures are made with (image-model.js); IMAGE_MODEL until an admin picks one.
adminRouter.get("/image-model", (req, res) => {
  res.json(imageModelView());
});

adminRouter.put("/image-model", async (req, res) => {
  const model = req.body?.model;
  if (typeof model !== "string" || !model) return res.status(400).json({ error: "Choose a model." });
  try {
    await setImageModel(model, req.user.email);
  } catch (err) {
    if (!(err instanceof ImageModelError)) throw err;
    return res.status(400).json({ error: err.message });
  }
  res.json(imageModelView());
});
