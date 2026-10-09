import { config } from "./config.js";
import { getAnthropicKey, getCredits, recordClaudeUsage } from "./db.js";

// Claude credits. Claude runs on the app's key (PLATFORM_ANTHROPIC_KEY) for every account without
// a key of its own, and each request costs credits worked out from what Anthropic charges for it:
// 1 credit = $0.0001, so the 10,000 every account starts with (FREE_CREDITS in db.js) are $1 of
// Claude use. Credits are bought 1,000 at a time.

// Accounts' own Anthropic keys, turned off: everyone uses the app's key through credits. Keys saved
// before stay stored but unused. Set to true to let an account use its own key again (never charged,
// requests still recorded); the settings route and page follow it.
export const OWN_KEYS = false;

export const CREDITS_PER_USD = 10_000;
export const PURCHASE_STEP = 1_000;
export const MAX_PURCHASE = 100_000;

// Dollars per million tokens. A cache write costs 1.25x input (2x for the 1-hour cache), and a web
// search $0.01. A model not listed here (an older copy's own choice) is charged at UNKNOWN_PRICE,
// at least as much as any model a copy might name, so it's never charged too little.
const PRICES = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};
const UNKNOWN_PRICE = { input: 15, output: 75, cacheRead: 1.5 };
const WEB_SEARCH_USD = 0.01;

// Replies name the model as a dated snapshot (claude-haiku-4-5-20251001): priced as its alias.
const priceOf = (model) => PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")] ?? UNKNOWN_PRICE;

/**
 * What a request costs in credits (rounded up). With a refusal fallback the reply may come from a
 * different model than the one asked for, so it's charged at the dearer of the two.
 */
export function creditsFor(usage, ...models) {
  const prices = models.filter(Boolean).map(priceOf);
  const price = prices.length ? prices.reduce((a, b) => (b.output > a.output ? b : a)) : UNKNOWN_PRICE;
  const write = usage.cache_creation_input_tokens ?? 0;
  const writeHour = Math.min(write, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const tokensUsd =
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (write - writeHour) * price.input * 1.25 +
      writeHour * price.input * 2) /
    1e6;
  const usd = tokensUsd + (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
  // The small allowance keeps floating-point noise from adding a credit.
  return Math.max(0, Math.ceil(usd * CREDITS_PER_USD - 1e-9));
}

export class ClaudeAccessError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const OUT_OF_CREDITS = "You've used all your Claude credits. Buy more credits to keep using Claude.";

/** The account's own key when OWN_KEYS allows it, else null. */
const ownKeyOf = async (userId) => (OWN_KEYS ? getAnthropicKey(userId) : null);

/**
 * The key a Claude request for this account runs on: `{ apiKey, charged }`. With OWN_KEYS, the
 * account's own key wins (never charged); otherwise the app's, as long as the balance is above zero.
 * Throws ClaudeAccessError (`anthropic_key_required` or `credits_exhausted`) when Claude can't run.
 */
export async function claudeKeyFor(userId) {
  const own = await ownKeyOf(userId);
  if (own) return { apiKey: own, charged: false };
  if (!config.platformAnthropicKey) {
    throw new ClaudeAccessError(
      "anthropic_key_required",
      OWN_KEYS ? "Claude isn't available yet. Add your own Anthropic API key in Settings to use it." : "Claude isn't available right now. Try again later.",
      400,
    );
  }
  const { balance } = await getCredits(userId);
  if (balance <= 0) throw new ClaudeAccessError("credits_exhausted", OUT_OF_CREDITS, 402);
  return { apiKey: config.platformAnthropicKey, charged: true };
}

/** The key the account's Claude files were uploaded with, for removing them; no balance needed. */
export async function claudeFilesKeyFor(userId) {
  return (await ownKeyOf(userId)) ?? config.platformAnthropicKey;
}

/** Still above zero? Checked between the requests of a run that makes several. */
export async function hasCredits(userId) {
  return (await getCredits(userId)).balance > 0;
}

/**
 * Records one finished Claude request and charges it when it ran on the app's key. Never throws:
 * a failed record mustn't fail the work Claude already did.
 */
export async function meterClaude({ userId, siteId, kind, command, model, requestedModel, usage, charged }) {
  if (!usage) return;
  try {
    const credits = creditsFor(usage, model, requestedModel);
    await recordClaudeUsage({ userId, siteId, kind, command, model: model ?? requestedModel, usage, credits, charged });
  } catch (err) {
    console.error(`Couldn't record Claude usage for account ${userId}:`, err);
  }
}

/* ------------------------------------------------------------ activity */

// Which accounts have Claude working right now (an assistant answer, a Claude command, a site
// update), so the browser checks the balance every few seconds only while it can change.

const active = new Map();

/** Marks the account busy until the returned function is called (once). */
export function beginClaudeActivity(userId) {
  active.set(userId, (active.get(userId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (active.get(userId) ?? 1) - 1;
    if (left > 0) active.set(userId, left);
    else active.delete(userId);
  };
}

export const isClaudeActive = (userId) => active.has(userId);

/** What the browser shows: the balance, whose key Claude runs on, and how buying works. */
export async function creditsView(userId) {
  const [credits, own] = await Promise.all([getCredits(userId), ownKeyOf(userId)]);
  const source = own ? "own" : config.platformAnthropicKey ? "credits" : "none";
  return {
    ...credits,
    source,
    active: isClaudeActive(userId),
    creditsPerDollar: CREDITS_PER_USD,
    purchase: { step: PURCHASE_STEP, max: MAX_PURCHASE, demo: config.demoPurchases },
  };
}
