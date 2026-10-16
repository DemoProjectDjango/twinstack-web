import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { noteProviderError } from "./provider-health.js";

// OpenAI (ChatGPT) models behind Claude's Messages API. The site's scripts and the assistant's site
// details shortcut send every request in Claude's format; DeepSeek takes that format as it is, but
// OpenAI doesn't, so its requests are translated to OpenAI's Responses API here and its replies,
// streamed or not, back into Claude's: the same message, the same stream events (message_start,
// content_block_*, message_delta with the usage, message_stop), the same error shape. The proxy's
// metering (credits.js) and the scripts' readers then work unchanged.
//
// Only what the fast model is sent is supported: a system prompt, user and assistant turns of text,
// and images. Anything else (tools such as web search, documents, tool results) is refused as an
// invalid request, and the scripts fall back to Claude as they do for any failed request.

export const OPENAI_UPSTREAM = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

// Effort levels Claude's requests may carry (output_config.effort) that OpenAI's reasoning takes.
const EFFORTS = new Set(["low", "medium", "high"]);

class Unsupported extends Error {}

const textOf = (blocks) => blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n\n");

/** One user content block as an OpenAI input part. */
function userPart(block) {
  if (block?.type === "text") return { type: "input_text", text: block.text };
  if (block?.type === "image") {
    const source = block.source ?? {};
    if (source.type === "base64") return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}`, detail: "auto" };
    if (source.type === "url") return { type: "input_image", image_url: source.url, detail: "auto" };
  }
  throw new Unsupported(`OpenAI models can't take ${block?.type ?? "this"} content here.`);
}

/** A Claude messages request as an OpenAI Responses request. Throws Unsupported for what can't be sent. */
export function toResponsesRequest(request) {
  if (request.tools?.length) throw new Unsupported("OpenAI models can't use Claude's tools (such as web search).");
  const system = typeof request.system === "string" ? request.system : Array.isArray(request.system) ? textOf(request.system) : "";
  const input = (request.messages ?? []).map(({ role, content }) => {
    if (typeof content === "string") return { role, content };
    if (!Array.isArray(content)) throw new Unsupported("A message has no content.");
    // Earlier replies are text only: their thinking stays behind.
    if (role === "assistant") {
      if (content.some((b) => b?.type === "tool_use")) throw new Unsupported("OpenAI models can't continue a Claude tool call.");
      return { role, content: textOf(content) };
    }
    return { role, content: content.map(userPart) };
  });
  const body = { model: request.model, input, store: false };
  if (system) body.instructions = system;
  if (Number.isFinite(request.max_tokens)) body.max_output_tokens = request.max_tokens;
  if (request.stream) body.stream = true;
  if (EFFORTS.has(request.output_config?.effort)) body.reasoning = { effort: request.output_config.effort };
  return body;
}

/** OpenAI's usage as Claude's: cached input is reported apart from the rest, as Claude does. */
export function toUsage(usage = {}) {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** Why a finished response stopped, as Claude's stop_reason. */
function stopReason(response, refused) {
  if (response?.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    return reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : "end_turn";
  }
  return refused ? "refusal" : "end_turn";
}

/** A finished OpenAI response as a Claude message. */
export function toMessage(response, model) {
  let text = "";
  let refused = false;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text") text += part.text;
      else if (part.type === "refusal") refused = true;
    }
  }
  return {
    id: response.id ?? `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: response.model ?? model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: stopReason(response, refused),
    stop_sequence: null,
    usage: toUsage(response.usage),
  };
}

/** A Claude error body. */
const claudeError = (type, message) => ({ type: "error", error: { type, message } });

/** An OpenAI HTTP error as Claude's: `{ status, body }`. A refused app key is the server's fault, not the script's. */
function toError(status, payload) {
  const message = payload?.error?.message ?? `OpenAI answered ${status}.`;
  if (status === 401 || status === 403) {
    console.error(`OpenAI refused the app's key (${status}): ${message}`);
    return { status: 502, body: claudeError("api_error", "The OpenAI model isn't available right now.") };
  }
  if (status === 400 || status === 422) return { status: 400, body: claudeError("invalid_request_error", message) };
  if (status === 404) return { status: 404, body: claudeError("not_found_error", message) };
  if (status === 429) return { status: 429, body: claudeError("rate_limit_error", message) };
  if (status === 503) return { status: 529, body: claudeError("overloaded_error", message) };
  return { status: status >= 500 ? status : 500, body: claudeError("api_error", message) };
}

/** OpenAI's server-sent events, parsed, one at a time. */
async function* readEvents(stream) {
  const decoder = new TextDecoder();
  let pending = "";
  const parse = (raw) => {
    const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end;
    while ((end = pending.indexOf("\n\n")) !== -1) {
      const event = parse(pending.slice(0, end));
      pending = pending.slice(end + 2);
      if (event) yield event;
    }
  }
  const last = pending.trim() && parse(pending);
  if (last) yield last;
}

/** OpenAI's stream as Claude's stream events. */
async function* toClaudeEvents(stream, model) {
  let started = false;
  let open = false;
  let refused = false;
  const start = (response) => {
    started = true;
    return {
      type: "message_start",
      message: {
        id: response?.id ?? `msg_${randomBytes(12).toString("hex")}`,
        type: "message",
        role: "assistant",
        model: response?.model ?? model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // OpenAI reports usage only when the response is done (message_delta below).
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  };
  for await (const event of readEvents(stream)) {
    switch (event.type) {
      case "response.created":
        if (!started) yield start(event.response);
        break;
      case "response.output_text.delta":
        if (!started) yield start(null);
        if (!open) {
          open = true;
          yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: event.delta ?? "" } };
        break;
      case "response.refusal.delta":
        refused = true;
        break;
      case "response.completed":
      case "response.incomplete":
        if (!started) yield start(event.response);
        if (open) yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: stopReason(event.response, refused), stop_sequence: null },
          usage: toUsage(event.response?.usage),
        };
        yield { type: "message_stop" };
        return;
      case "response.failed":
        yield claudeError("api_error", event.response?.error?.message ?? "The OpenAI model couldn't finish its reply.");
        return;
      case "error":
        yield claudeError(/overloaded|server_error/i.test(event.code ?? "") ? "overloaded_error" : "api_error", event.message ?? "The OpenAI model stopped with an error.");
        return;
      default:
        break;
    }
  }
  yield claudeError("api_error", "The OpenAI model's reply ended early.");
}

/**
 * Sends a Claude messages `request` (an object) to OpenAI with `apiKey`. Resolves to one of
 * `{ status, body }` (an error, as Claude's), `{ status: 200, message }` (not streamed), or
 * `{ status: 200, events }` (streamed: an async iterable of Claude stream events). `headers` holds
 * the reply headers worth passing on (retry-after).
 */
export async function sendToOpenAI(request, { apiKey, signal }) {
  let body;
  try {
    body = toResponsesRequest(request);
  } catch (err) {
    if (err instanceof Unsupported) return { status: 400, body: claudeError("invalid_request_error", err.message), headers: {} };
    throw err;
  }
  const upstream = await fetch(`${OPENAI_UPSTREAM}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const retryAfter = upstream.headers.get("retry-after");
  const headers = retryAfter ? { "retry-after": retryAfter } : {};
  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => null);
    if (apiKey === config.openaiKey) noteProviderError("openai", upstream.status, `${payload?.error?.code ?? ""} ${payload?.error?.message ?? ""}`);
    return { ...toError(upstream.status, payload), headers };
  }
  if (body.stream) return { status: 200, events: toClaudeEvents(upstream.body, request.model), headers };
  return { status: 200, message: toMessage(await upstream.json(), request.model), headers };
}

/** An error from createMessage: `status` and Claude's error `type`, like the Anthropic SDK's. */
export class OpenAIBridgeError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `OpenAI request failed (${status}).`);
    this.status = status;
    this.type = body?.error?.type ?? "api_error";
  }
}

/** Like the Anthropic SDK's `messages.create` (not streamed) for an OpenAI model: the Claude message, or throws OpenAIBridgeError. */
export async function createMessage(params, { apiKey, signal }) {
  const reply = await sendToOpenAI({ ...params, stream: false }, { apiKey, signal });
  if (reply.message) return reply.message;
  throw new OpenAIBridgeError(reply.status, reply.body);
}
