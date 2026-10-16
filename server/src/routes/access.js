import { Router } from "express";
import { config } from "../config.js";
import { PURCHASE_STATUSES, listAccessRequests, listAllPurchases, publicUser, purchaseTotals, requestAccess, setAccessStatus } from "../db.js";
import { sendEmail } from "../email.js";
import { FastModelError, fastModelView, setFastModel } from "../fast-model.js";
import { ImageModelError, imageModelView, setImageModel } from "../image-model.js";
import { ProviderHealthError, checkProviderCosts, creditActivityReport, providerHealth, setProviderBalance } from "../provider-health.js";
import { requireAuth } from "../session.js";
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
// the totals. /purchases.csv is the whole filtered list as a spreadsheet, for accounting.
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
  res.json({ items, more: items.length === limit, ...(totals && { totals, purchases: config.purchases }) });
});

const CSV_COLUMNS = [
  ["Created", (p) => p.createdAt?.toISOString()],
  ["Paid", (p) => p.paidAt?.toISOString()],
  ["Status", (p) => p.status],
  ["Provider", (p) => p.provider],
  ["Mode", (p) => (p.provider === "demo" ? "" : p.livemode ? "live" : "test")],
  ["Buyer email", (p) => p.buyer?.email ?? p.account.email],
  ["Buyer name", (p) => p.buyer?.name ?? p.account.name],
  ["Account id", (p) => p.account.id],
  ["Account email now", (p) => (p.account.deleted ? "(deleted)" : p.account.email)],
  ["Credits", (p) => p.credits],
  ["Credits taken back", (p) => p.refundedCredits ?? 0],
  ["Currency", (p) => p.currency],
  ["Price", (p) => cents(p.priceCents)],
  ["Paid amount", (p) => cents(p.amountPaidCents)],
  ["Stripe fee", (p) => cents(p.feeCents)],
  ["Refunded", (p) => cents(p.refundedCents)],
  ["Disputed", (p) => cents(p.disputedCents)],
  ["Card", (p) => (p.card ? `${p.card.brand} ${p.card.last4}` : (p.method ?? ""))],
  ["Card country", (p) => p.card?.country],
  ["Stripe payment", (p) => p.paymentIntentId],
  ["Stripe checkout", (p) => p.stripeSessionId],
  ["Stripe customer", (p) => p.customerId],
  ["Receipt", (p) => p.receiptUrl],
];

const cents = (n) => (typeof n === "number" ? (n / 100).toFixed(2) : "");
// Quoted, and a leading = + - @ neutralised so a spreadsheet never runs a buyer's name as a formula.
const csvCell = (value) => {
  const text = value == null ? "" : String(value);
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

adminRouter.get("/purchases.csv", async (req, res) => {
  const items = await listAllPurchases({ ...purchaseFilters(req.query), limit: 10_000 });
  const lines = [CSV_COLUMNS.map(([name]) => csvCell(name)), ...items.map((p) => CSV_COLUMNS.map(([, get]) => csvCell(get(p))))];
  res.set("Cache-Control", "no-store");
  res.attachment(`twinstack-purchases-${new Date().toISOString().slice(0, 10)}.csv`);
  res.type("text/csv").send(`﻿${lines.map((cells) => cells.join(",")).join("\r\n")}\r\n`);
});

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
