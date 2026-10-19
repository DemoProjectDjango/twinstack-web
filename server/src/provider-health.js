import { config } from "./config.js";
import { CREDITS_PER_USD, PLATFORM_SHARE, totalsMoney } from "./credits.js";
import {
  chargedByProvider,
  chargedByProviderPerDay,
  creditActivity,
  listAllPurchases,
  getAppSetting,
  listProviderCosts,
  outstandingCredits,
  providerErrorSummary,
  recordProviderError,
  saveProviderCost,
  setAppSetting,
} from "./db.js";
import { sendEmail } from "./email.js";
import { DAY as ONE_DAY, addDays, dayStartOf, localDate, zoneOf } from "./zoned-days.js";

// Whether the app's own keys (Claude, DeepSeek, OpenAI) have the money to keep running, shown on
// /admin/providers. For each provider in use:
//   balance   DeepSeek's from its API (GET /user/balance); Anthropic and OpenAI don't report a
//             prepaid balance, so an admin enters it after each top-up (appSettings
//             "providerBalance:<provider>"), and what's been spent since is taken off.
//   spend     what claudeUsage recorded as charged, at the app's prices (credits.js PRICES).
//   runway    the balance left ÷ the daily spend (the larger of the last 24 hours and the 7-day
//             average, so a busy day counts at once).
//   errors    the providers' refusals (noteProviderError), kept 30 days: out of balance, rate
//             limited, key refused, overloaded.
//   activity  for a date range: credits bought, free credits given, and credits used per provider
//             and per account (creditActivityReport, the page's "Credits by date" section).
//   costs     once a day, the providers' own cost reports for the last days next to what the app
//             recorded (Anthropic's and OpenAI's need an admin key), so a stale price table shows.
// Admins (ADMIN_EMAILS) are emailed when a provider runs low or out, a key is refused, or a day's
// costs disagree, at most once per ALERT_EVERY_MS for each.

export const PROVIDER_NAMES = { claude: "Anthropic (Claude)", deepseek: "DeepSeek", openai: "OpenAI" };
const MONITOR_EVERY_MS = 15 * 60 * 1000;
const ALERT_EVERY_MS = 12 * 60 * 60 * 1000;
const ERROR_ALERT_EVERY_MS = 60 * 60 * 1000;
const DEEPSEEK_BALANCE_EVERY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A day's costs agree when they're this close (whichever is larger).
const COST_TOLERANCE = { share: 0.05, usd: 0.5 };
// Each daily check looks again at this many complete days: providers may still adjust a day.
const COST_DAYS = 3;
const COST_HISTORY_DAYS = 14;
const ALERTS_SETTING = "providerAlerts";
const RECENT_PURCHASES = 8;
const MAX_ACTIVITY_DAYS = 366;

const usd = (credits) => credits / CREDITS_PER_USD;
const money = (n) => `$${n.toFixed(2)}`;
const dayOf = (date) => date.toISOString().slice(0, 10);
const startOfUtcDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** The providers the app has a key for. */
export function providersInUse() {
  return [config.platformAnthropicKey && "claude", config.deepseekKey && "deepseek", config.openaiKey && "openai"].filter(Boolean);
}

export class ProviderHealthError extends Error {}

/* ------------------------------------------------------------ alerts */

/** Emails the admins about `key` unless they were told within `every`. Survives restarts. */
async function alertOnce(key, every, subject, text) {
  if (!config.adminEmails.length) return;
  const doc = await getAppSetting(ALERTS_SETTING);
  const sent = doc?.value ?? {};
  if (sent[key] && Date.now() - new Date(sent[key]).getTime() < every) return;
  // Alerts older than a month are forgotten, so the record stays small.
  const kept = Object.entries(sent).filter(([, at]) => Date.now() - new Date(at).getTime() < 30 * DAY_MS);
  await setAppSetting(ALERTS_SETTING, { ...Object.fromEntries(kept), [key]: new Date().toISOString() }, "provider-health");
  await sendEmail({ to: config.adminEmails, subject, text: `${text}\n\nSee ${config.clientUrl}/admin/providers` });
}

/* ------------------------------------------------------------ errors */

/** What a provider's error means: "balance", "rate_limit", "auth", "overloaded", or "other". */
export function errorKind(provider, status, message = "") {
  const text = String(message);
  if (provider === "claude" && /credit balance/i.test(text)) return "balance";
  if (provider === "openai" && /insufficient_quota|exceeded your current quota|billing/i.test(text)) return "balance";
  if (provider === "deepseek" && (status === 402 || /insufficient balance/i.test(text))) return "balance";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  return "other";
}

const ERROR_ALERTS = {
  balance: (name) => [`${name} is out of balance`, `${name} refused a request because the account has no balance left. Claude work that uses it stops until it's topped up.`],
  auth: (name) => [`${name} refused the app's key`, `${name} refused the app's API key (revoked, or the account was suspended). Requests that use it fail until it's fixed.`],
};

/**
 * A provider refused a request made on the app's key: recorded (only the kinds worth counting, not a
 * bad request a script sent), and the admins are told at once when it's out of balance or the key is
 * refused. Never throws, never waits: callers carry on with their own error handling.
 */
export function noteProviderError(provider, status, message) {
  const kind = errorKind(provider, status, message);
  if (kind === "other" && status < 500) return;
  void (async () => {
    await recordProviderError({ provider, kind, status, message });
    const alert = ERROR_ALERTS[kind];
    if (alert) {
      const [subject, text] = alert(PROVIDER_NAMES[provider]);
      await alertOnce(`error:${provider}:${kind}`, ERROR_ALERT_EVERY_MS, `Twinstack: ${subject}`, `${text}\n\nWhat it said: ${String(message).slice(0, 300)}`);
    }
  })().catch((err) => console.error(`Couldn't record a ${provider} error:`, err.message));
}

/* ------------------------------------------------------------ balances */

let deepseekBalance = null;

/** DeepSeek's balance in dollars (yuan converted at CNY_PER_USD), cached for a few minutes. */
async function fetchDeepseekBalance({ fresh = false } = {}) {
  if (!config.deepseekKey) return null;
  if (!fresh && deepseekBalance && Date.now() - deepseekBalance.checkedAt < DEEPSEEK_BALANCE_EVERY_MS) return deepseekBalance;
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${config.deepseekKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.message ?? `DeepSeek answered ${res.status}`);
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    const inUsd = infos.find((b) => b.currency === "USD");
    const inCny = infos.find((b) => b.currency === "CNY");
    const amountUsd = inUsd
      ? Number(inUsd.total_balance)
      : inCny
        ? Number(inCny.total_balance) / config.providerHealth.cnyPerUsd
        : Number.NaN;
    if (!Number.isFinite(amountUsd)) throw new Error("DeepSeek didn't report a balance");
    deepseekBalance = {
      source: "live",
      amountUsd,
      currency: inUsd ? "USD" : "CNY",
      original: inUsd ? null : Number(inCny.total_balance),
      available: body.is_available !== false,
      asOf: new Date(),
      checkedAt: Date.now(),
    };
  } catch (err) {
    deepseekBalance = { source: "live", error: err.message, asOf: new Date(), checkedAt: Date.now() };
  }
  return deepseekBalance;
}

/** The balance an admin entered for Anthropic or OpenAI, less what the app recorded since. */
async function enteredBalance(provider) {
  const doc = await getAppSetting(`providerBalance:${provider}`);
  if (!doc?.value || typeof doc.value.amountUsd !== "number") return { source: null, autoReload: doc?.value?.autoReload ?? false };
  const spent = usd((await chargedByProvider(doc.updatedAt))[provider]);
  return {
    source: "entered",
    amountUsd: doc.value.amountUsd,
    asOf: doc.updatedAt,
    setBy: doc.updatedBy,
    spentSinceUsd: spent,
    remainingUsd: doc.value.amountUsd - spent,
    autoReload: Boolean(doc.value.autoReload),
  };
}

/** Saves what an admin read off Anthropic's or OpenAI's billing page. */
export async function setProviderBalance(provider, { amountUsd, autoReload }, by) {
  if (provider !== "claude" && provider !== "openai") throw new ProviderHealthError("Only Anthropic's and OpenAI's balances are entered by hand.");
  const current = (await getAppSetting(`providerBalance:${provider}`))?.value ?? {};
  const next = { ...current };
  if (amountUsd !== undefined) {
    if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd < 0 || amountUsd > 1_000_000) {
      throw new ProviderHealthError("Enter the balance in dollars, like 120.50.");
    }
    next.amountUsd = Math.round(amountUsd * 100) / 100;
  }
  if (autoReload !== undefined) next.autoReload = Boolean(autoReload);
  await setAppSetting(`providerBalance:${provider}`, next, by);
}

/* ------------------------------------------------------------ status */

/** Everything /admin/providers shows. `fresh` asks DeepSeek again rather than using the cache. */
export async function providerHealth({ fresh = false } = {}) {
  const now = new Date();
  const providers = providersInUse();
  const [last24h, last7d, errors24h, errors7d, outstanding, costs, recentPurchases] = await Promise.all([
    chargedByProvider(new Date(now - DAY_MS)),
    chargedByProvider(new Date(now - 7 * DAY_MS)),
    providerErrorSummary(new Date(now - DAY_MS)),
    providerErrorSummary(new Date(now - 7 * DAY_MS)),
    outstandingCredits(),
    listProviderCosts(dayOf(new Date(now - COST_HISTORY_DAYS * DAY_MS))),
    listAllPurchases({ limit: RECENT_PURCHASES }),
  ]);

  const rows = await Promise.all(
    providers.map(async (provider) => {
      const spend = {
        last24hUsd: usd(last24h[provider]),
        last7dUsd: usd(last7d[provider]),
        last24hCredits: last24h[provider],
        last7dCredits: last7d[provider],
      };
      // The larger: a sudden busy day counts straight away, a quiet one doesn't hide a busy week.
      spend.perDayUsd = Math.max(spend.last24hUsd, spend.last7dUsd / 7);

      let balance;
      if (provider === "deepseek") {
        const live = await fetchDeepseekBalance({ fresh });
        balance = live?.error ? live : { ...live, remainingUsd: live?.amountUsd };
      } else {
        balance = await enteredBalance(provider);
      }

      const remaining = balance.remainingUsd;
      const runwayDays = typeof remaining === "number" && spend.perDayUsd > 0 ? Math.max(0, remaining) / spend.perDayUsd : null;
      const outOfBalanceToday = (errors24h[provider]?.counts.balance ?? 0) > 0;
      const level =
        typeof remaining !== "number"
          ? outOfBalanceToday
            ? "empty"
            : "unknown"
          : remaining <= 0 || outOfBalanceToday || balance.available === false
            ? "empty"
            : runwayDays !== null && runwayDays < config.providerHealth.alertDays
              ? "low"
              : "ok";

      return {
        provider,
        name: PROVIDER_NAMES[provider],
        balance,
        spend,
        runwayDays,
        level,
        errors: { last24h: errors24h[provider]?.counts ?? {}, last7d: errors7d[provider]?.counts ?? {}, latest: errors7d[provider]?.latest ?? null },
        costCheck: costCheckAvailable(provider),
        costs: costs.filter((c) => c.provider === provider),
      };
    }),
  );

  return {
    providers: rows,
    outstanding: { ...outstanding, usd: usd(outstanding.credits) },
    recentPurchases,
    alertDays: config.providerHealth.alertDays,
    emailsTo: config.adminEmails.length,
    emailConfigured: Boolean(config.email.resendKey),
    checkedAt: now,
  };
}

/* ------------------------------------------------------------ activity */

/**
 * Credits bought and used between two local dates (`from` and `to`, "YYYY-MM-DD", both included) in
 * the admin's time zone `tz`, with what the use cost at the providers and what buyers paid.
 */
export async function creditActivityReport({ from, to, tz }) {
  const zone = zoneOf(tz);
  const start = dayStartOf(zone, from);
  const last = dayStartOf(zone, to);
  if (start === null || last === null) throw new ProviderHealthError("Choose the dates to show.");
  if (last < start) throw new ProviderHealthError("The start date is after the end date.");
  const end = addDays(zone, last, 1);
  if ((end - start) / ONE_DAY > MAX_ACTIVITY_DAYS + 1) throw new ProviderHealthError(`Choose at most ${MAX_ACTIVITY_DAYS} days.`);

  const [activity, purchases] = await Promise.all([
    creditActivity({ start: new Date(start), end: new Date(end), zone }),
    listAllPurchases({ since: new Date(start), before: new Date(end), limit: RECENT_PURCHASES }),
  ]);
  const costUsd = Object.fromEntries(Object.entries(activity.totals.usage).map(([p, u]) => [p, usd(u.credits)]));
  return {
    from,
    to,
    zone,
    today: localDate(zone, Date.now()),
    ...activity,
    costUsd,
    totalCostUsd: Object.values(costUsd).reduce((a, b) => a + b, 0),
    revenueUsd: (activity.totals.purchases.paidCents - activity.totals.purchases.refundedCents) / 100,
    // Profit on what was paid in these dates: the share kept, less Stripe's fees (credits.js PLATFORM_SHARE).
    profit: profitOf({ ...activity.totals.purchases, paidCredits: activity.totals.purchases.credits }),
    days: activity.days.map((d) => ({ ...d, profit: profitOf(d) })),
    users: activity.users.map((u) => ({ ...u, profit: profitOf(u) })),
    platformShare: PLATFORM_SHARE,
    creditsPerUsd: CREDITS_PER_USD,
    recentPurchases: purchases,
  };
}

/** Kept, Stripe's fees (estimated where not reported yet) and profit (cents) of paid purchases' sums. */
function profitOf(sums) {
  const m = totalsMoney({ ...sums, credits: sums.paidCredits });
  return { paidCents: m.paidCents, keptCents: m.keptCents, feeCents: m.feeCents, profitCents: m.profitCents };
}

/* ------------------------------------------------------------ cost reports */

function costCheckAvailable(provider) {
  if (provider === "claude") return Boolean(config.providerHealth.anthropicAdminKey);
  if (provider === "openai") return Boolean(config.providerHealth.openaiAdminKey);
  return false;
}

/** Anthropic's cost report: dollars per UTC day from `start` (inclusive) to `end` (exclusive). */
async function anthropicCosts(start, end) {
  const { anthropicAdminKey, anthropicWorkspaceId } = config.providerHealth;
  const days = {};
  let page = null;
  do {
    const params = new URLSearchParams({ starting_at: start.toISOString(), ending_at: end.toISOString(), bucket_width: "1d", limit: "31" });
    if (anthropicWorkspaceId) params.append("group_by[]", "workspace_id");
    if (page) params.set("page", page);
    const res = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${params}`, {
      headers: { "x-api-key": anthropicAdminKey, "anthropic-version": "2023-06-01", "user-agent": "Twinstack/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.message ?? `Anthropic answered ${res.status}`);
    for (const bucket of body.data ?? []) {
      const day = bucket.starting_at.slice(0, 10);
      // Amounts are cents, as decimal strings. The default workspace is null ("default" here).
      const mine = (bucket.results ?? []).filter((r) => !anthropicWorkspaceId || (r.workspace_id ?? "default") === anthropicWorkspaceId);
      days[day] = (days[day] ?? 0) + mine.reduce((sum, r) => sum + Number(r.amount) / 100, 0);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);
  return days;
}

/** OpenAI's costs: dollars per UTC day from `start` (inclusive) to `end` (exclusive). */
async function openaiCosts(start, end) {
  const { openaiAdminKey, openaiProjectId } = config.providerHealth;
  const days = {};
  let page = null;
  do {
    const params = new URLSearchParams({
      start_time: String(Math.floor(start / 1000)),
      end_time: String(Math.floor(end / 1000)),
      bucket_width: "1d",
      limit: "31",
    });
    if (openaiProjectId) params.append("group_by", "project_id");
    if (page) params.set("page", page);
    const res = await fetch(`https://api.openai.com/v1/organization/costs?${params}`, {
      headers: { Authorization: `Bearer ${openaiAdminKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.message ?? `OpenAI answered ${res.status}`);
    for (const bucket of body.data ?? []) {
      const day = dayOf(new Date(bucket.start_time * 1000));
      const mine = (bucket.results ?? []).filter((r) => !openaiProjectId || r.project_id === openaiProjectId);
      days[day] = (days[day] ?? 0) + mine.reduce((sum, r) => sum + Number(r.amount?.value ?? 0), 0);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);
  return days;
}

const COST_REPORTS = { claude: anthropicCosts, openai: openaiCosts };

/**
 * Checks the last COST_DAYS complete UTC days of each provider's cost report against what the app
 * recorded, and saves each day. A day that disagrees beyond COST_TOLERANCE is flagged, and the
 * admins are told about the latest one.
 */
export async function checkProviderCosts() {
  const end = startOfUtcDay(new Date());
  const start = new Date(end - COST_DAYS * DAY_MS);
  const ours = await chargedByProviderPerDay(start);
  for (const provider of providersInUse().filter(costCheckAvailable)) {
    let theirs;
    try {
      theirs = await COST_REPORTS[provider](start, end);
    } catch (err) {
      await saveProviderCost(provider, dayOf(new Date(end - DAY_MS)), { error: err.message });
      continue;
    }
    for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
      const day = dayOf(new Date(t));
      const providerUsd = theirs[day] ?? 0;
      const recordedUsd = usd(ours[day]?.[provider] ?? 0);
      const differenceUsd = recordedUsd - providerUsd;
      const flagged = Math.abs(differenceUsd) > Math.max(COST_TOLERANCE.usd, providerUsd * COST_TOLERANCE.share);
      await saveProviderCost(provider, day, { providerUsd, recordedUsd, differenceUsd, flagged, error: null });
      if (flagged && t === end.getTime() - DAY_MS) {
        const name = PROVIDER_NAMES[provider];
        await alertOnce(
          `cost:${provider}:${day}`,
          Number.POSITIVE_INFINITY,
          `Twinstack: ${name}'s costs for ${day} don't match`,
          `${name} charged ${money(providerUsd)} on ${day}, but the app recorded ${money(recordedUsd)} (${differenceUsd < 0 ? "charging users less" : "more"} than it cost).\n` +
            (differenceUsd < 0
              ? "Users may be charged too little: check PRICES in server/src/credits.js against the provider's prices, and whether something else uses this key."
              : "The app may charge more than it costs: check PRICES in server/src/credits.js."),
        );
      }
    }
  }
}

/* ------------------------------------------------------------ monitor */

async function checkRunway() {
  const { providers } = await providerHealth();
  for (const p of providers) {
    if (p.level !== "low" && p.level !== "empty") continue;
    const left = typeof p.balance.remainingUsd === "number" ? money(Math.max(0, p.balance.remainingUsd)) : "nothing";
    const days = p.runwayDays === null ? "" : ` That's about ${p.runwayDays.toFixed(1)} days at ${money(p.spend.perDayUsd)} a day.`;
    const reload = p.balance.autoReload ? " Auto-reload is on: check that its card works." : " Top it up, or turn on auto-reload in its billing settings.";
    await alertOnce(
      `runway:${p.provider}:${p.level}`,
      ALERT_EVERY_MS,
      p.level === "empty" ? `Twinstack: ${p.name} has run out` : `Twinstack: ${p.name} is running low`,
      `${p.name} has ${left} left.${days}${reload}`,
    );
  }
}

let lastCostCheckDay = null;

async function monitor() {
  try {
    await checkRunway();
    // Once a day, after 02:00 UTC, when the previous day's costs have settled.
    const now = new Date();
    if (now.getUTCHours() >= 2 && lastCostCheckDay !== dayOf(now)) {
      lastCostCheckDay = dayOf(now);
      await checkProviderCosts();
    }
  } catch (err) {
    console.error("Provider health check failed:", err.message);
  }
}

/** Starts the checks: now, then every MONITOR_EVERY_MS. One API process runs them. */
export function startProviderMonitor() {
  if (!providersInUse().length) return;
  void monitor();
  setInterval(() => void monitor(), MONITOR_EVERY_MS).unref();
}
