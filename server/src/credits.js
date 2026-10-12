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
  // DeepSeek (claude-proxy.js) at its peak-hour prices, which are double the off-peak ones, so a
  // request is never charged too little.
  "deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044 },
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

/**
 * Records one finished Claude (or DeepSeek, through the proxy) request and charges it when it ran
 * on the app's key. `runId` groups the requests of one job, assistant answer or site update for
 * the credits history. Returns the credits charged. Never throws: a failed record mustn't fail the
 * work already done.
 */
export async function meterClaude({ userId, siteId, runId, kind, command, model, requestedModel, usage, charged }) {
  if (!usage) return 0;
  try {
    const credits = creditsFor(usage, model, requestedModel);
    await recordClaudeUsage({ userId, siteId, runId, kind, command, model: model ?? requestedModel, usage, credits, charged });
    return charged ? credits : 0;
  } catch (err) {
    console.error(`Couldn't record Claude usage for account ${userId}:`, err);
    return 0;
  }
}

/* ------------------------------------------------------------ spending */

// A request on credits may take the balance this far below zero, and no further: its max_tokens is
// capped to what the balance buys down to -OVERDRAFT, and its reply is watched as it streams and
// cut off there (ending as a normal "max_tokens" reply, so what it wrote is kept). Every running
// request of the account counts, so two at once stop at the same limit.
export const OVERDRAFT = 200;

// Replies report their output tokens only when they finish, so a running one is estimated from the
// characters it has streamed. Thinking isn't streamed (it comes back empty), so max_tokens, which
// counts it, is what bounds it.
const CHARS_PER_TOKEN = 3.5;
// An image or document sent by reference or as base64 counts as this many input tokens.
const MEDIA_TOKENS = 1600;

const creditsPerToken = (dollarsPerMillion) => (dollarsPerMillion / 1e6) * CREDITS_PER_USD;

// Accounts with requests running on credits: { userId, balance, running: Set<Spend> }. `balance` is
// the stored one (re-read as each request starts and ends); `running` is what isn't charged yet.
const accounts = new Map();

/** Credits the account has above zero, less what its running requests have used so far. */
function left(account) {
  let running = 0;
  for (const spend of account.running) running += spend.credits;
  return account.balance - running;
}

/** A rough count of a request's input tokens, without its base64 data, and whether it uses the cache. */
function inputEstimate(body) {
  let media = 0;
  const text = JSON.stringify(body, (name, value) => {
    if (name === "source" && value && typeof value === "object" && ["base64", "url", "file"].includes(value.type)) {
      media++;
      return null;
    }
    return value;
  });
  return { tokens: Math.ceil(text.length / CHARS_PER_TOKEN) + media * MEDIA_TOKENS, cached: text.includes('"cache_control"') };
}

/** Characters one streamed delta adds to the reply. */
function deltaChars(delta) {
  return (delta?.text ?? delta?.partial_json ?? delta?.thinking ?? "").length;
}

/** One Claude request, from its start to its charge. Made by beginSpend. */
class Spend {
  credits = 0;
  model = null;
  requestedModel = null;
  /** True once the request was cut off at the overdraft limit. */
  stopped = false;
  /** True when max_tokens was lowered to fit the balance, so a "max_tokens" stop means the credits ran out. */
  clamped = false;
  #info;
  #account;
  #usage = null;
  #final = false;
  #chars = 0;
  #done = false;

  constructor(info, account) {
    this.#info = info;
    this.#account = account;
  }

  /**
   * The max_tokens to send instead of `requested`: no more than the balance buys down to
   * -OVERDRAFT, after the request's estimated input. 0 when nothing is left for any output.
   */
  maxTokens(requested, body) {
    this.requestedModel = body.model ?? null;
    if (!this.#account || !Number.isFinite(requested)) return requested;
    const price = priceOf(this.requestedModel ?? "");
    const input = inputEstimate(body);
    const room = left(this.#account) + OVERDRAFT - input.tokens * creditsPerToken(input.cached ? price.cacheRead : price.input);
    const allowed = Math.floor(room / creditsPerToken(price.output));
    if (allowed >= requested) return requested;
    this.clamped = true;
    return Math.max(0, allowed);
  }

  /** Folds one streamed event into the request's usage. True when the request must stop now. */
  track(event) {
    if (event?.type === "message_start" && event.message) {
      this.model = event.message.model ?? this.model;
      this.#usage = { ...event.message.usage };
    } else if (event?.type === "content_block_delta") {
      this.#chars += deltaChars(event.delta);
    } else if (event?.type === "message_delta" && event.usage) {
      this.#usage ??= {};
      for (const [field, value] of Object.entries(event.usage)) if (value != null) this.#usage[field] = value;
      this.#final = true;
    } else {
      return this.stopped;
    }
    if (this.#account && this.#usage) {
      this.credits = creditsFor(this.usage, this.model, this.requestedModel);
      // A reply that has finished has nothing left to stop.
      if (!this.#final && left(this.#account) <= -OVERDRAFT) this.stopped = true;
    }
    return this.stopped;
  }

  /** What the request has used: the reply's own count once it finished, else estimated so far. */
  get usage() {
    if (!this.#usage || this.#final) return this.#usage;
    const streamed = Math.ceil(this.#chars / CHARS_PER_TOKEN);
    return { ...this.#usage, output_tokens: Math.max(this.#usage.output_tokens ?? 0, streamed) };
  }

  /**
   * Records and charges the request (a finished message's `model` and `usage` when given, else what
   * was tracked), then stops counting it as running. Only the first call does anything.
   */
  async finish({ model, usage } = {}) {
    if (this.#done) return;
    this.#done = true;
    const account = this.#account;
    try {
      await meterClaude({
        ...this.#info,
        model: model ?? this.model,
        requestedModel: this.requestedModel,
        usage: usage ?? this.usage,
        charged: Boolean(account),
      });
      if (account) account.balance = (await getCredits(account.userId)).balance;
    } catch (err) {
      console.error(`Couldn't refresh the balance of account ${account?.userId}:`, err);
    } finally {
      if (account) {
        account.running.delete(this);
        if (!account.running.size) accounts.delete(account.userId);
      }
    }
  }
}

/**
 * Starts one Claude request: the Spend that caps, watches and charges it. `info` is what it's
 * recorded against (`userId`, `siteId`, `runId`, `kind`, `command`); with `charged: false` (the
 * account's own key) it's only recorded, never limited. Returns null when the account has nothing
 * left above zero to start it with. Every Spend must end with `finish()`.
 */
export async function beginSpend({ charged = true, ...info }) {
  if (!charged) return new Spend(info, null);
  const { balance } = await getCredits(info.userId);
  let account = accounts.get(info.userId);
  if (account) account.balance = balance;
  else accounts.set(info.userId, (account = { userId: info.userId, balance, running: new Set() }));
  if (left(account) <= 0) {
    if (!account.running.size) accounts.delete(info.userId);
    return null;
  }
  const spend = new Spend(info, account);
  account.running.add(spend);
  return spend;
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
