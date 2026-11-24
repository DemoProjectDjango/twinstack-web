import { randomBytes } from "node:crypto";
import http from "node:http";
import { providerOf } from "./ai-providers.js";
import { config } from "./config.js";
import { isClaudeModel } from "./claude-models.js";
import { ClaudeAccessError, OUT_OF_CREDITS, anthropicUserId, beginSpend, countableRequest, listedPrices } from "./credits.js";
import { fastModelKey } from "./fast-model.js";
import { sendToOpenAI } from "./openai-bridge.js";
import { noteProviderError } from "./provider-health.js";
import { PROXY_SCOPE_NOTE } from "./scope-guard.js";

// The site's Claude scripts never see the app's Anthropic key: a copy is a repo its owner can
// change, so its scripts could print any key they're given. Instead a Claude command run on
// credits gets a one-off job token as ANTHROPIC_API_KEY and this proxy as ANTHROPIC_BASE_URL (every
// version of the scripts reads both). The proxy checks the token and the balance, caps max_tokens to
// what the balance buys (credits.js: OVERDRAFT), forwards the request to Anthropic with the app's
// key, streams the reply back, and charges what the reply's usage says. A reply still running when
// the account reaches the overdraft limit is stopped and ended as a "max_tokens" reply, so the
// script keeps what was written. It listens on a loopback port of its own, so it isn't reachable through
// Nginx, and a token only works while its job runs. Requests for the cheaper "fast" model
// (fast-model.js) go to its provider instead, and are charged the same way: deepseek-* models to
// DeepSeek, OpenAI ones to OpenAI (translated by openai-bridge.js).

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_JSON_REPLY_BYTES = 16 * 1024 * 1024;
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
// deepseek-* models (TWINSTACK_FAST_MODEL, see fast-model.js) go to DeepSeek's Anthropic-compatible
// API with the app's DeepSeek key; it takes the same request and streams the same events.
export const DEEPSEEK_UPSTREAM = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
// Headers the scripts send that Anthropic needs; everything else (the token above all) stays here.
// anthropic-beta only with its allowed values (allowedBetas).
const FORWARD_HEADERS = ["content-type", "anthropic-version"];
const RETURN_HEADERS = /^(content-type|request-id|retry-after|anthropic-|x-should-retry)/i;

const grants = new Map();
let baseUrl = null;

export async function startClaudeProxy() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err?.name !== "AbortError") console.error("Claude proxy error:", err);
      if (!res.headersSent) sendError(res, 502, "api_error", "Couldn't reach Claude.");
      else res.destroy();
    });
  });
  // Long Claude replies stream for many minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

/**
 * A token for one job's Claude requests: `{ apiKey, baseUrl, revoke }`. `info` is what each
 * request is recorded against (`userId`, `siteId`, `command`); every request made with the token
 * shares one `runId`, so the credits history shows the job as one entry.
 */
export function issueProxyToken(info) {
  if (!baseUrl) throw new Error("The Claude proxy isn't running.");
  const apiKey = `twinstack-job-${randomBytes(24).toString("hex")}`;
  grants.set(apiKey, { ...info, runId: randomBytes(12).toString("hex") });
  return { apiKey, baseUrl, revoke: () => grants.delete(apiKey) };
}

function sendError(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One streamed event's JSON, or null. */
function parseEvent(raw) {
  const data = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// The site's scripts are code the owner can change, and they spend the app's keys, so only what the
// template's scripts send gets through: anything else could turn on a paid feature that isn't
// charged for (code execution, MCP servers, priority or fast tiers, the long-context price) or make
// Anthropic reach out to any server. Fields the request may have:
const ALLOWED_FIELDS = new Set([
  "model", "max_tokens", "messages", "system", "stream", "metadata",
  "tools", "tool_choice", "thinking", "output_config", "fallbacks", "cache_control",
  "temperature", "top_p", "top_k", "stop_sequences",
]);
// Tools: the site's own (no type, or "custom"), and web search, which creditsFor charges for.
const allowedTool = (tool) => tool && typeof tool === "object" && (tool.type == null || tool.type === "custom" || /^web_search_\d{8}$/.test(tool.type));
// anthropic-beta values passed on; any other is dropped. Kept to ones that change no price.
const ALLOWED_BETA = /^(server-side-fallback|prompt-caching|extended-cache-ttl|interleaved-thinking|token-efficient-tools|fine-grained-tool-streaming)-[\d-]+$/;
// The largest max_tokens a script may ask for (Claude's own limits are lower for most models).
const MAX_OUTPUT_TOKENS = 128_000;

/** Why the request can't go through the proxy (a message for the script), or null when it can. */
function requestProblem(request) {
  const extra = Object.keys(request).filter((field) => !ALLOWED_FIELDS.has(field));
  if (extra.length) return `${extra.join(", ")} can't be used on this server.`;
  if (!Number.isInteger(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > MAX_OUTPUT_TOKENS) {
    return `max_tokens must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}.`;
  }
  if (request.tools != null && (!Array.isArray(request.tools) || !request.tools.every(allowedTool))) return "Only web search and the script's own tools can be used on this server.";
  return null;
}

/** The anthropic-beta header with only ALLOWED_BETA values, or null. */
function allowedBetas(header) {
  const kept = String(header ?? "").split(",").map((b) => b.trim()).filter((b) => ALLOWED_BETA.test(b));
  return kept.length ? kept.join(",") : null;
}

/** The request with PROXY_SCOPE_NOTE as the first block of its system prompt. */
function withScopeNote(request) {
  const note = { type: "text", text: PROXY_SCOPE_NOTE };
  const system = request.system;
  if (system == null || system === "") return { ...request, system: [note] };
  if (typeof system === "string") return { ...request, system: [note, { type: "text", text: system }] };
  if (Array.isArray(system)) return { ...request, system: [note, ...system] };
  return request;
}

const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

async function handle(req, res) {
  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "POST" || path !== "/v1/messages") return sendError(res, 404, "not_found_error", "Only Claude messages go through here.");

  const token = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const grant = typeof token === "string" ? grants.get(token) : null;
  if (!grant) return sendError(res, 401, "authentication_error", "This Claude run has ended. Start it again.");
  if (!config.platformAnthropicKey) return sendError(res, 503, "api_error", "Claude isn't available on this server.");

  let body = await readBody(req);
  if (!body) return sendError(res, 413, "request_too_large", "This request is too big to send to Claude.");
  let request;
  try {
    request = JSON.parse(body.toString("utf8"));
  } catch {
    return sendError(res, 400, "invalid_request_error", "The request isn't valid JSON.");
  }
  if (!request || typeof request !== "object") return sendError(res, 400, "invalid_request_error", "The request isn't a Claude message.");
  const requestedModel = request.model ?? null;
  const provider = providerOf(requestedModel);
  // Claude: the models offered in Settings and the ones the app's own steps use (all priced);
  // others: the fast model's provider must have a key.
  const known = provider === "claude" ? isClaudeModel(requestedModel) || listedPrices(requestedModel) != null : fastModelKey(requestedModel);
  if (!known) return sendError(res, 400, "invalid_request_error", `${requestedModel} isn't available on this server.`);
  const problem = requestProblem(request);
  if (problem) return sendError(res, 400, "invalid_request_error", problem);

  // Every request the site's scripts make is about the website (scope-guard.js): the note goes first
  // in the system prompt, whatever the copy's scripts say. The same text every time, so caching holds.
  request = withScopeNote(request);
  // Which account sent it, as an opaque id, so Anthropic can tell the app's users apart if one misuses it.
  if (provider === "claude") request = { ...request, metadata: { user_id: anthropicUserId(grant.userId) } };
  else delete request.metadata;
  body = Buffer.from(JSON.stringify(request));

  let spend;
  try {
    // Waits while the account is at its running or per-minute limit (credits.js: LIMITS).
    spend = await beginSpend({ ...grant, kind: "command" });
  } catch (err) {
    if (err instanceof ClaudeAccessError) return sendError(res, err.status, err.status === 429 ? "rate_limit_error" : "billing_error", err.message);
    throw err;
  }
  if (!spend) return sendError(res, 402, "billing_error", OUT_OF_CREDITS);
  try {
    // No more output than the balance pays for down to the overdraft limit.
    // Only Claude has a token count: DeepSeek and OpenAI requests keep the estimate.
    const count = provider === "claude" ? (body) => countInputTokens(req, body) : async () => null;
    const maxTokens = await spend.fitMaxTokens(request.max_tokens, request, {}, count);
    if (maxTokens === 0) return sendError(res, 402, "billing_error", OUT_OF_CREDITS);
    if (provider === "openai") return await forwardOpenAI(res, { ...request, max_tokens: maxTokens }, spend);
    if (maxTokens !== request.max_tokens) body = Buffer.from(JSON.stringify({ ...request, max_tokens: maxTokens }));
    await forward(req, res, body, provider === "deepseek", spend);
  } finally {
    // A stopped reply is charged for what was used up to then.
    await spend.finish();
  }
}

/** The request's exact input tokens from Anthropic's count_tokens (free), or null when it can't be had. */
async function countInputTokens(req, request) {
  const headers = { "x-api-key": config.platformAnthropicKey, "content-type": "application/json" };
  if (req.headers["anthropic-version"]) headers["anthropic-version"] = req.headers["anthropic-version"];
  const betas = allowedBetas(req.headers["anthropic-beta"]);
  if (betas) headers["anthropic-beta"] = betas;
  headers["anthropic-version"] ??= "2023-06-01";
  try {
    const res = await fetch(`${UPSTREAM}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify(countableRequest(request)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`count_tokens answered ${res.status}`);
    return (await res.json()).input_tokens ?? null;
  } catch (err) {
    console.warn(`Couldn't count a Claude request's tokens: ${err.message}`);
    return null;
  }
}

// Answers that mean "not now" rather than "no": rate limited, overloaded (529) or a passing server
// error. The site's scripts don't retry, so many requests in a row (bringing in 87 pages) failed
// a third of their pages on these. Nothing has reached the script yet, so the request is simply
// sent again, within the scripts' 5-minute wait for a reply's first byte.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000, 30_000];
const MAX_RETRY_AFTER_MS = 60_000;

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

/** fetch, sent again after a short wait while the provider answers "not now" or can't be reached. */
async function fetchRetrying(url, init) {
  for (let attempt = 0; ; attempt++) {
    let upstream = null;
    let failure = null;
    try {
      upstream = await fetch(url, init);
    } catch (err) {
      if (init.signal.aborted) throw err;
      failure = err;
    }
    const retryable = failure || (RETRY_STATUSES.has(upstream.status) && upstream.headers.get("x-should-retry") !== "false");
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
      if (failure) throw failure;
      return upstream;
    }
    const after = Number(upstream?.headers.get("retry-after"));
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_AFTER_MS) : RETRY_DELAYS_MS[attempt];
    await upstream?.body?.cancel().catch(() => {});
    console.warn(`Claude proxy: ${upstream ? `answered ${upstream.status}` : `failed (${failure.message})`}; trying again in ${Math.round(wait / 1000)} s.`);
    await pause(wait, init.signal);
  }
}

async function forward(req, res, body, deepseek, spend) {
  const headers = { "x-api-key": deepseek ? config.deepseekKey : config.platformAnthropicKey };
  for (const name of FORWARD_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  const betas = allowedBetas(req.headers["anthropic-beta"]);
  if (betas) headers["anthropic-beta"] = betas;
  const controller = new AbortController();
  // The job was cancelled (or the script gave up): stop the request at Anthropic too.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  const upstream = await fetchRetrying(`${deepseek ? DEEPSEEK_UPSTREAM : UPSTREAM}/v1/messages`, { method: "POST", headers, body, signal: controller.signal });
  const replyHeaders = {};
  for (const [name, value] of upstream.headers) if (RETURN_HEADERS.test(name)) replyHeaders[name] = value;
  res.writeHead(upstream.status, replyHeaders);

  const streamed = upstream.ok && /text\/event-stream/i.test(upstream.headers.get("content-type") ?? "");
  const decoder = new TextDecoder();
  let pending = "";
  // The content block being streamed, closed for the script if the reply is cut off inside it.
  let openBlock = null;
  const json = [];
  let jsonSize = 0;
  // A refusal's body, for provider-health.js (out of balance, rate limited, key refused…).
  const failure = [];
  try {
    for await (const chunk of upstream.body ?? []) {
      if (!streamed) {
        res.write(chunk);
        if (upstream.ok && jsonSize < MAX_JSON_REPLY_BYTES) {
          json.push(chunk);
          jsonSize += chunk.length;
        } else if (!upstream.ok && failure.length < 8) failure.push(chunk);
        continue;
      }
      // Whole events only, so the reply can end cleanly between any two of them.
      pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const raw = pending.slice(0, end);
        pending = pending.slice(end + 2);
        res.write(`${raw}\n\n`);
        const event = parseEvent(raw);
        if (event?.type === "content_block_start") openBlock = event.index;
        else if (event?.type === "content_block_stop") openBlock = null;
        if (spend.track(event)) {
          controller.abort();
          endAtLimit(res, openBlock, spend);
          return;
        }
      }
    }
    if (pending) res.write(pending);
    res.end();
  } catch (err) {
    if (!controller.signal.aborted) console.error("Claude proxy stream failed:", err.message);
    res.destroy();
  } finally {
    if (!upstream.ok) noteProviderError(deepseek ? "deepseek" : "claude", upstream.status, Buffer.concat(failure).toString("utf8").slice(0, 2000));
    if (json.length) {
      try {
        const message = JSON.parse(Buffer.concat(json).toString("utf8"));
        spend.track({ type: "message_start", message });
        spend.track({ type: "message_delta", usage: message.usage ?? {} });
      } catch {
        // Not a message: nothing to charge.
      }
    }
  }
}

/**
 * The credits are spent down to the overdraft limit: the model was stopped, so end the reply as one
 * cut off at its token limit, and the script keeps what was written.
 */
function endAtLimit(res, openBlock, spend) {
  if (openBlock != null) res.write(sse({ type: "content_block_stop", index: openBlock }));
  res.write(sse({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: spend.usage?.output_tokens ?? 0 } }));
  res.end(sse({ type: "message_stop" }));
}

/** forward for an OpenAI model: the request (an object) goes through openai-bridge.js, the reply comes back as Claude's. */
async function forwardOpenAI(res, request, spend) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const reply = await sendToOpenAI(request, { apiKey: config.openaiKey, signal: controller.signal });
  if (reply.body) {
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    return res.end(JSON.stringify(reply.body));
  }
  if (reply.message) {
    res.writeHead(200, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.message));
    spend.track({ type: "message_start", message: reply.message });
    spend.track({ type: "message_delta", usage: reply.message.usage });
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...reply.headers });
  let openBlock = null;
  try {
    for await (const event of reply.events) {
      res.write(sse(event));
      if (event.type === "content_block_start") openBlock = event.index;
      else if (event.type === "content_block_stop") openBlock = null;
      if (spend.track(event)) {
        controller.abort();
        endAtLimit(res, openBlock, spend);
        return;
      }
    }
    res.end();
  } catch (err) {
    if (!controller.signal.aborted) console.error("Claude proxy stream from OpenAI failed:", err.message);
    res.destroy();
  }
}
