import { randomBytes } from "node:crypto";
import http from "node:http";
import { config } from "./config.js";
import { OUT_OF_CREDITS, beginSpend } from "./credits.js";

// The site's Claude scripts never see the app's Anthropic key: a copy is a repo its owner can
// change, so its scripts could print any key they're given. Instead a Claude command run on
// credits gets a one-off job token as ANTHROPIC_API_KEY and this proxy as ANTHROPIC_BASE_URL (every
// version of the scripts reads both). The proxy checks the token and the balance, caps max_tokens to
// what the balance buys (credits.js: OVERDRAFT), forwards the request to Anthropic with the app's
// key, streams the reply back, and charges what the reply's usage says. A reply still running when
// the account reaches the overdraft limit is stopped and ended as a "max_tokens" reply, so the
// script keeps what was written. It listens on a loopback port of its own, so it isn't reachable through
// Nginx, and a token only works while its job runs. Requests for deepseek-* models (the page
// editor's cheaper model) are sent to DeepSeek instead, and charged the same way.

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_JSON_REPLY_BYTES = 16 * 1024 * 1024;
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
// deepseek-* models (TWINSTACK_FAST_MODEL, see config.js) go to DeepSeek's Anthropic-compatible API
// with the app's DeepSeek key; it takes the same request and streams the same events.
export const DEEPSEEK_UPSTREAM = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
const isDeepseek = (model) => typeof model === "string" && model.startsWith("deepseek-");
// Headers the scripts send that Anthropic needs; everything else (the token above all) stays here.
const FORWARD_HEADERS = ["content-type", "anthropic-version", "anthropic-beta"];
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
  const deepseek = isDeepseek(requestedModel);
  if (deepseek && !config.deepseekKey) return sendError(res, 400, "invalid_request_error", `${requestedModel} isn't available on this server.`);

  const spend = await beginSpend({ ...grant, kind: "command" });
  if (!spend) return sendError(res, 402, "billing_error", OUT_OF_CREDITS);
  try {
    // No more output than the balance pays for down to the overdraft limit.
    const maxTokens = spend.maxTokens(request.max_tokens, request);
    if (maxTokens === 0) return sendError(res, 402, "billing_error", OUT_OF_CREDITS);
    if (maxTokens !== request.max_tokens) body = Buffer.from(JSON.stringify({ ...request, max_tokens: maxTokens }));
    await forward(req, res, body, deepseek, spend);
  } finally {
    // A stopped reply is charged for what was used up to then.
    await spend.finish();
  }
}

async function forward(req, res, body, deepseek, spend) {
  const headers = { "x-api-key": deepseek ? config.deepseekKey : config.platformAnthropicKey };
  for (const name of FORWARD_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  const controller = new AbortController();
  // The job was cancelled (or the script gave up): stop the request at Anthropic too.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  const upstream = await fetch(`${deepseek ? DEEPSEEK_UPSTREAM : UPSTREAM}/v1/messages`, { method: "POST", headers, body, signal: controller.signal });
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
  try {
    for await (const chunk of upstream.body ?? []) {
      if (!streamed) {
        res.write(chunk);
        if (upstream.ok && jsonSize < MAX_JSON_REPLY_BYTES) {
          json.push(chunk);
          jsonSize += chunk.length;
        }
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
          // The credits are spent down to the overdraft limit: stop Claude, and end the reply as one
          // cut off at its token limit, so the script keeps what was written.
          controller.abort();
          if (openBlock != null) res.write(sse({ type: "content_block_stop", index: openBlock }));
          res.write(sse({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: spend.usage?.output_tokens ?? 0 } }));
          res.end(sse({ type: "message_stop" }));
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
