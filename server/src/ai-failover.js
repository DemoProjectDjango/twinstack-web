import Anthropic from "@anthropic-ai/sdk";
import { providerOf } from "./ai-providers.js";
import { AiUnavailableError } from "./ai-errors.js";
import { DEFAULT_MODEL } from "./claude-models.js";
import { config } from "./config.js";
import { OpenAIBridgeError, sendToOpenAI } from "./openai-bridge.js";
import { errorKind, isProviderDown } from "./provider-health.js";

// Failover between the app's AI providers (Claude, DeepSeek, OpenAI), all paid for by the app on
// its own keys. When the provider a request asked for can't take it because of the app's account
// (out of balance, key refused, overloaded or failing after the retries, unreachable), the request
// goes to the next provider that has a key and isn't known to be down, before anything of the reply
// has reached the caller. A request's own problem (a 400 for what it sent) never fails over, and
// neither does a request on the account's own key (OWN_KEYS in credits.js): that error is theirs.
//
// Order: a Claude request goes to DeepSeek's stronger model, then OpenAI's strongest; a fast-model
// request (fast-model.js) to the other fast provider's model of the same tier, then Claude. A
// provider that answered "balance" or "auth" is skipped for a few minutes (provider-health.js:
// markProviderDown). Each target gets the request adapted to what it takes (adaptRequest), or is
// skipped when it can't do the request at all (web search, Claude's files…). When nobody can take
// it, the caller gets AiUnavailableError (ai-errors.js: AI_BUSY).
//
// Used by the metering proxy for the site's scripts (claude-proxy.js, on raw HTTP) and, through
// withFailover and openStream, by the assistant (assistant/turn.js) and site updates' merges.

export const DEEPSEEK_UPSTREAM = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, "");

// The model each provider stands in with, by the tier of the model asked for. Claude's work goes to
// the strong tier.
export const STAND_INS = {
  deepseek: { strong: "deepseek-v4-pro", fast: "deepseek-flash" },
  openai: { strong: "gpt-6.1-sol", fast: "gpt-6-luna" },
};
// The cheaper models; any other DeepSeek or OpenAI model counts as the strong tier.
const FAST_TIER = new Set(["deepseek-flash", "gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-nano", "gpt-5.4-mini"]);

/** The app's key for a provider, or null. */
export function appKeyFor(provider) {
  if (provider === "claude") return config.platformAnthropicKey;
  if (provider === "deepseek") return config.deepseekKey;
  if (provider === "openai") return config.openaiKey;
  return null;
}

/**
 * Every model a request for `model` may run on, in order, the model itself first: only providers
 * with a key. `claudeModel` is the Claude model a fast-model request falls back to.
 */
export function failoverModels(model, { claudeModel = DEFAULT_MODEL } = {}) {
  const provider = providerOf(model);
  let list;
  if (provider === "claude") list = [model, STAND_INS.deepseek.strong, STAND_INS.openai.strong];
  else {
    const tier = FAST_TIER.has(model) ? "fast" : "strong";
    const other = provider === "deepseek" ? "openai" : "deepseek";
    list = [model, STAND_INS[other][tier], claudeModel];
  }
  return [...new Set(list)].filter((m) => appKeyFor(providerOf(m)));
}

/** failoverModels without the providers marked down for now. Empty when every one of them is. */
export function attemptOrder(model, options) {
  return failoverModels(model, options).filter((m) => !isProviderDown(providerOf(m)));
}

/**
 * Why a provider's failure should hand the request on: "balance", "auth", "rate_limit",
 * "overloaded" or "connection"; null when the request itself was at fault (or it's unknown).
 * `status` is the HTTP status (0 or null when the provider couldn't be reached).
 */
export function failoverReason(provider, status, text = "") {
  if (!status) return "connection";
  const kind = errorKind(provider, status, text);
  if (kind === "balance" || kind === "auth") return kind;
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 529 || status >= 500) return "overloaded";
  return null;
}

const isAbort = (err) => err?.name === "AbortError" || err instanceof Anthropic.APIUserAbortError;

/** failoverReason for an error thrown by the Anthropic SDK, openai-bridge.js or fetch. */
export function failoverReasonOf(err, provider) {
  if (!err || isAbort(err)) return null;
  if (err.failoverReason) return err.failoverReason;
  if (err instanceof Anthropic.APIConnectionError) return "connection";
  if (err instanceof Anthropic.APIError || err instanceof OpenAIBridgeError) {
    // The bridge reports a refused key as a 502 and a spent quota as a 429: both hand on.
    return failoverReason(provider, err.status ?? 0, `${err.message ?? ""} ${err.type ?? ""}`);
  }
  // fetch's own failures (no answer at all).
  if (err instanceof TypeError && /fetch failed|network|ECONN|ETIMEDOUT/i.test(`${err.message} ${err.cause?.code ?? ""}`)) return "connection";
  return null;
}

/* ------------------------------------------------------------ adapting requests */

class CantRun extends Error {}

// Fields only Claude's API takes. The others ignore or refuse them.
const CLAUDE_ONLY_FIELDS = ["fallbacks", "cache_control", "thinking", "context_management", "betas", "metadata", "container", "mcp_servers", "service_tier", "inference_geo"];
const FILE_GONE = (what) => ({ type: "text", text: `(${what} attached here can't be shown right now.)` });

/** One content block for a non-Claude provider: thinking dropped, Claude's own data cut away. */
function adaptBlock(block, target) {
  if (!block || typeof block !== "object") return block;
  switch (block.type) {
    case "thinking":
    case "redacted_thinking":
      return null;
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "image": {
      const source = block.source ?? {};
      if (source.type === "base64" || source.type === "url") return { type: "image", source };
      return FILE_GONE("An image");
    }
    case "document": {
      const source = block.source ?? {};
      if (source.type === "text" && typeof source.data === "string") return { type: "text", text: block.title ? `${block.title}:\n${source.data}` : source.data };
      return FILE_GONE(`A document${block.title ? ` (${block.title})` : ""}`);
    }
    case "tool_use":
      if (target === "openai") throw new CantRun("tool calls");
      return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
    case "tool_result": {
      if (target === "openai") throw new CantRun("tool results");
      const content = Array.isArray(block.content) ? block.content.map((b) => adaptBlock(b, target)).filter(Boolean) : block.content;
      return { type: "tool_result", tool_use_id: block.tool_use_id, content, ...(block.is_error && { is_error: true }) };
    }
    default:
      // Server tools' calls and results (web search…) and anything newer: only Claude reads them.
      throw new CantRun(block.type);
  }
}

/**
 * `request` (a Claude messages request) as `model` takes it: the model swapped, and for DeepSeek or
 * OpenAI everything only Claude understands removed (betas, fallbacks, cache control, thinking and
 * its blocks, context management, files from Claude's Files API). Null when it can't run there at
 * all: Claude's server tools (web search, web fetch, code execution), or for OpenAI any tools.
 */
export function adaptRequest(request, model) {
  const target = providerOf(model);
  if (target === "claude") return { ...request, model };
  try {
    const tools = request.tools ?? [];
    if (tools.some((t) => t?.type != null && t.type !== "custom")) return null;
    if (target === "openai" && tools.length) return null;
    const adapted = { ...request, model };
    for (const field of CLAUDE_ONLY_FIELDS) delete adapted[field];
    // DeepSeek's Anthropic API takes no effort level; the bridge turns it into OpenAI's reasoning effort.
    if (target === "deepseek") delete adapted.output_config;
    if (tools.length) adapted.tools = tools.map(({ name, description, input_schema }) => ({ name, ...(description && { description }), input_schema }));
    else {
      delete adapted.tools;
      delete adapted.tool_choice;
    }
    if (Array.isArray(request.system)) adapted.system = request.system.map((b) => adaptBlock(b, target)).filter(Boolean);
    adapted.messages = (request.messages ?? []).map(({ role, content }) => {
      if (!Array.isArray(content)) return { role, content };
      const blocks = content.map((b) => adaptBlock(b, target)).filter(Boolean);
      return { role, content: blocks.length ? blocks : [{ type: "text", text: "(no reply)" }] };
    });
    return adapted;
  } catch (err) {
    if (err instanceof CantRun) return null;
    throw err;
  }
}

/* ------------------------------------------------------------ in-process callers */

/**
 * Runs `run(params, model, progress)` on the request's own model and, when that provider fails on
 * the app's account before anything of the reply arrived (`run` sets `progress.started` once the
 * first event is in), on the next one (attemptOrder), with `params` adapted to it. Resolves to
 * `{ result, model }`. `enabled: false` (the account's own key) runs the model alone, as before.
 * Throws the request's own error as it is, or AiUnavailableError when nobody could take it.
 * `onFailover(model, reason, err)` is told of each provider given up on.
 */
export async function withFailover(params, run, { enabled = true, claudeModel, onFailover = () => {} } = {}) {
  const requested = params.model;
  if (!enabled) return { result: await run(params, requested, { started: false }), model: requested };
  const order = attemptOrder(requested, { claudeModel });
  let last = null;
  for (const model of order) {
    const attempt = model === requested ? params : adaptRequest(params, model);
    if (!attempt) continue;
    const progress = { started: false };
    try {
      return { result: await run(attempt, model, progress), model };
    } catch (err) {
      if (progress.started || isAbort(err)) throw err;
      const reason = failoverReasonOf(err, providerOf(model));
      // The request's own problem, on the model it asked for: the caller handles it as before.
      if (!reason && model === requested) throw err;
      last = err;
      onFailover(model, reason ?? "refused", err);
    }
  }
  throw new AiUnavailableError(last);
}

const deepseekClient = () => new Anthropic({ apiKey: config.deepseekKey, baseURL: DEEPSEEK_UPSTREAM, maxRetries: 2 });
const claudeClient = () => new Anthropic({ apiKey: config.platformAnthropicKey, ...(process.env.ANTHROPIC_BASE_URL && { baseURL: process.env.ANTHROPIC_BASE_URL }) });

/**
 * A streamed request to `model`'s provider with the app's key, as the Anthropic SDK's MessageStream
 * is used here: `.on("streamEvent", (event, snapshot) => …)`, `.finalMessage()`, `.abort()`.
 * `client` is the caller's own Claude client (it may hold the account's key), used for Claude.
 */
export function openStream(model, params, { client = null, signal } = {}) {
  const provider = providerOf(model);
  if (provider === "claude") return (client ?? claudeClient()).beta.messages.stream(params, { signal });
  if (provider === "deepseek") return deepseekClient().messages.stream(params, { signal });
  return openAIStream(params, signal);
}

/** OpenAI's reply (openai-bridge.js) behind the same small interface as the SDK's MessageStream. */
function openAIStream(params, signal) {
  const listeners = [];
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  const done = (async () => {
    const reply = await sendToOpenAI({ ...params, stream: true }, { apiKey: config.openaiKey, signal: controller.signal });
    if (reply.body) throw new OpenAIBridgeError(reply.status, reply.body);
    let message = null;
    const text = [];
    for await (const event of reply.events) {
      if (event.type === "error") throw new OpenAIBridgeError(event.error?.type === "overloaded_error" ? 529 : 500, event);
      if (event.type === "message_start") message = { ...event.message, content: [] };
      else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text.push(event.delta.text);
      else if (event.type === "message_delta" && message) {
        message.stop_reason = event.delta?.stop_reason ?? message.stop_reason;
        message.usage = { ...message.usage, ...event.usage };
      }
      const snapshot = message && { ...message, content: text.length ? [{ type: "text", text: text.join("") }] : [] };
      for (const listener of listeners) listener(event, snapshot);
    }
    if (!message) throw new OpenAIBridgeError(500, null);
    return { ...message, content: text.length ? [{ type: "text", text: text.join("") }] : [] };
  })();
  done.catch(() => {});
  return {
    on(name, listener) {
      if (name === "streamEvent") listeners.push(listener);
      return this;
    },
    finalMessage: () =>
      done.catch((err) => {
        if (controller.signal.aborted) throw new Anthropic.APIUserAbortError();
        throw err;
      }),
    abort: () => controller.abort(),
  };
}
