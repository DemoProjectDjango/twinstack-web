import { randomBytes } from "node:crypto";
import http from "node:http";
import { config } from "./config.js";
import { OUT_OF_CREDITS, hasCredits, meterClaude } from "./credits.js";

// The site's Claude scripts never see the app's Anthropic key: a copy is a repo its owner can
// change, so its scripts could print any key they're given. Instead a Claude command run on
// credits gets a one-off job token as ANTHROPIC_API_KEY and this proxy as ANTHROPIC_BASE_URL (every
// version of the scripts reads both). The proxy checks the token and the balance, forwards the
// request to Anthropic with the app's key, streams the reply straight back, and charges what the
// reply's usage says. It listens on a loopback port of its own, so it isn't reachable through
// Nginx, and a token only works while its job runs.

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_JSON_REPLY_BYTES = 16 * 1024 * 1024;
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
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
 * request is recorded against (`userId`, `siteId`, `command`).
 */
export function issueProxyToken(info) {
  if (!baseUrl) throw new Error("The Claude proxy isn't running.");
  const apiKey = `twinstack-job-${randomBytes(24).toString("hex")}`;
  grants.set(apiKey, info);
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

/** Folds one streamed event into the request's usage (message_start, then cumulative message_delta). */
function readEvent(data, state) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }
  if (event.type === "message_start" && event.message) {
    state.model = event.message.model ?? state.model;
    state.usage = { ...event.message.usage };
  } else if (event.type === "message_delta" && event.usage) {
    state.usage ??= {};
    for (const [field, value] of Object.entries(event.usage)) if (value != null) state.usage[field] = value;
  }
}

async function handle(req, res) {
  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "POST" || path !== "/v1/messages") return sendError(res, 404, "not_found_error", "Only Claude messages go through here.");

  const token = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const grant = typeof token === "string" ? grants.get(token) : null;
  if (!grant) return sendError(res, 401, "authentication_error", "This Claude run has ended. Start it again.");
  if (!config.platformAnthropicKey) return sendError(res, 503, "api_error", "Claude isn't available on this server.");
  if (!(await hasCredits(grant.userId))) return sendError(res, 402, "billing_error", OUT_OF_CREDITS);

  const body = await readBody(req);
  if (!body) return sendError(res, 413, "request_too_large", "This request is too big to send to Claude.");
  let requestedModel = null;
  try {
    requestedModel = JSON.parse(body.toString("utf8")).model ?? null;
  } catch {
    return sendError(res, 400, "invalid_request_error", "The request isn't valid JSON.");
  }

  const headers = { "x-api-key": config.platformAnthropicKey };
  for (const name of FORWARD_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  const controller = new AbortController();
  // The job was cancelled (or the script gave up): stop the request at Anthropic too.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  const upstream = await fetch(`${UPSTREAM}/v1/messages`, { method: "POST", headers, body, signal: controller.signal });
  const replyHeaders = {};
  for (const [name, value] of upstream.headers) if (RETURN_HEADERS.test(name)) replyHeaders[name] = value;
  res.writeHead(upstream.status, replyHeaders);

  const state = { model: null, usage: null };
  const streamed = /text\/event-stream/i.test(upstream.headers.get("content-type") ?? "");
  const decoder = new TextDecoder();
  let pending = "";
  const json = [];
  let jsonSize = 0;
  try {
    for await (const chunk of upstream.body ?? []) {
      res.write(chunk);
      if (!upstream.ok) continue;
      if (streamed) {
        pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let end;
        while ((end = pending.indexOf("\n\n")) !== -1) {
          const lines = pending.slice(0, end).split("\n");
          pending = pending.slice(end + 2);
          const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (data) readEvent(data, state);
        }
      } else if (jsonSize < MAX_JSON_REPLY_BYTES) {
        json.push(chunk);
        jsonSize += chunk.length;
      }
    }
    res.end();
  } catch (err) {
    if (!controller.signal.aborted) console.error("Claude proxy stream failed:", err.message);
    res.destroy();
  } finally {
    if (upstream.ok && !streamed && json.length) {
      try {
        const message = JSON.parse(Buffer.concat(json).toString("utf8"));
        state.model = message.model ?? null;
        state.usage = message.usage ?? null;
      } catch {
        // Not a message: nothing to charge.
      }
    }
    // A stopped reply is charged for what was used up to then.
    await meterClaude({ ...grant, kind: "command", model: state.model, requestedModel, usage: state.usage, charged: true });
  }
}
