import { anthropicError, json, mock, openAIReply, resetMock, streamReply } from "./env.js";
import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, test } from "node:test";

const { AI_BUSY } = await import("../src/ai-errors.js");
const { sendWithFailover, setRetryDelaysForTests } = await import("../src/claude-proxy.js");
const { clearProviderDown, isProviderDown } = await import("../src/provider-health.js");

setRetryDelaysForTests([1, 1]);

/** A stand-in for credits.js's Spend: everything allowed, every tracked event kept. */
function fakeSpend() {
  return {
    events: [],
    clamped: false,
    shortfall: null,
    async fitMaxTokens(requested) {
      return requested;
    },
    track(event) {
      this.events.push(event);
      return false;
    },
    get model() {
      return this.events.find((e) => e?.type === "message_start")?.message.model ?? null;
    },
  };
}

/** Sends `request` through the proxy's failover as a site script would, and reads the reply. */
async function send(request, { headers = {} } = {}) {
  const spend = fakeSpend();
  const server = http.createServer((req, res) => {
    sendWithFailover(req, res, request, spend, { userId: "user-1" }).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
      body: JSON.stringify(request),
    });
    return { status: res.status, headers: res.headers, text: await res.text(), spend };
  } finally {
    server.close();
  }
}

const page = (model = "claude-opus-5-5", extra = {}) => ({
  model,
  max_tokens: 2000,
  stream: true,
  system: "Write the page.",
  messages: [{ role: "user", content: "Make it blue." }],
  ...(model.startsWith("claude") && { fallbacks: "default", output_config: { effort: "high" } }),
  ...extra,
});
const creditBalance = anthropicError("invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");

beforeEach(() => {
  resetMock();
  clearProviderDown();
});
afterEach(() => clearProviderDown());

test("Claude out of balance: DeepSeek answers, the script never sees the error, and it's charged as DeepSeek", async () => {
  mock.handlers.claude = (body, req, res) => json(res, 400, creditBalance);
  mock.handlers.deepseek = (body, req, res) => streamReply(res, body.model, "Blue page");
  const reply = await send(page(), { headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } });
  assert.equal(reply.status, 200);
  assert.match(reply.text, /Blue page/);
  assert.doesNotMatch(reply.text, /credit balance/);
  assert.equal(reply.spend.model, "deepseek-v4-pro");
  const sent = mock.calls.deepseek[0];
  assert.equal(sent.body.model, "deepseek-v4-pro");
  for (const field of ["fallbacks", "output_config", "metadata"]) assert.equal(field in sent.body, false, field);
  assert.equal(sent.headers["anthropic-beta"], undefined);
  assert.equal(sent.headers["x-api-key"], "test-deepseek-key");
  assert.equal(mock.calls.claude[0].body.metadata.user_id.length > 0, true);
  assert.equal(isProviderDown("claude"), true);

  // The next request skips Claude straight away.
  const again = await send(page());
  assert.equal(again.status, 200);
  assert.equal(mock.calls.claude.length, 1);
  assert.equal(mock.calls.deepseek.length, 2);
});

test("a bad request is the script's own: passed back as it was, no failover", async () => {
  const error = anthropicError("invalid_request_error", "messages.0.content: Field required");
  mock.handlers.claude = (body, req, res) => json(res, 400, error);
  const reply = await send(page());
  assert.equal(reply.status, 400);
  assert.deepEqual(JSON.parse(reply.text), error);
  assert.equal(mock.calls.deepseek.length, 0);
  assert.equal(mock.calls.openai.length, 0);
});

test("overloaded as the stream begins: handed over before anything reached the script", async () => {
  mock.handlers.claude = (body, req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: error\ndata: ${JSON.stringify(anthropicError("overloaded_error", "Overloaded"))}\n\n`);
  };
  mock.handlers.deepseek = (body, req, res) => streamReply(res, body.model, "From the stand-in");
  const reply = await send(page());
  assert.equal(reply.status, 200);
  assert.match(reply.text, /From the stand-in/);
  assert.doesNotMatch(reply.text, /Overloaded/);
  // Overloaded is passing: Claude isn't marked down for it.
  assert.equal(isProviderDown("claude"), false);
});

test("every provider out: the neutral message, not to be retried", async () => {
  mock.handlers.claude = (body, req, res) => json(res, 401, anthropicError("authentication_error", "invalid x-api-key"));
  mock.handlers.deepseek = (body, req, res) => json(res, 402, anthropicError("invalid_request_error", "Insufficient Balance"));
  mock.handlers.openai = (body, req, res) => json(res, 429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } });
  const reply = await send(page());
  assert.equal(reply.status, 503);
  assert.equal(reply.headers.get("x-should-retry"), "false");
  assert.equal(JSON.parse(reply.text).error.message, AI_BUSY);
  assert.equal(mock.calls.openai[0].body.model, "gpt-6-astra");
  assert.equal(reply.spend.events.length, 0);
  for (const provider of ["claude", "deepseek", "openai"]) assert.equal(isProviderDown(provider), true, provider);
});

test("a request only Claude can run (web search) isn't sent anywhere else", async () => {
  mock.handlers.claude = (body, req, res) => json(res, 400, creditBalance);
  const reply = await send(page("claude-opus-5-5", { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }] }));
  assert.equal(reply.status, 503);
  assert.equal(JSON.parse(reply.text).error.message, AI_BUSY);
  assert.equal(mock.calls.deepseek.length + mock.calls.openai.length, 0);
});

test("the fast model out of balance: the other fast provider answers, translated", async () => {
  mock.handlers.deepseek = (body, req, res) => json(res, 402, anthropicError("invalid_request_error", "Insufficient Balance"));
  mock.handlers.openai = (body, req, res) => openAIReply(res, body.model, "Fast answer");
  const reply = await send(page("deepseek-flash", { stream: false }));
  assert.equal(reply.status, 200);
  const message = JSON.parse(reply.text);
  assert.equal(message.content[0].text, "Fast answer");
  assert.equal(mock.calls.openai[0].body.model, "gpt-6-luna");
  assert.equal(reply.spend.model, "gpt-6-luna");
  assert.equal(mock.calls.claude.length, 0);
});

test("unreachable after the retries counts as unavailable", async () => {
  mock.handlers.claude = (body, req, res) => req.socket.destroy();
  mock.handlers.deepseek = (body, req, res) => streamReply(res, body.model, "Still here");
  const reply = await send(page());
  assert.equal(reply.status, 200);
  assert.match(reply.text, /Still here/);
  assert.equal(mock.calls.claude.length, 3);
});
