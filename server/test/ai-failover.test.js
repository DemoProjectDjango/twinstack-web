import "./env.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";

// After env.js has set the environment (it waits for its mock to listen, so static imports would run first).
const { AiUnavailableError } = await import("../src/ai-errors.js");
const { adaptRequest, attemptOrder, failoverModels, failoverReason, withFailover } = await import("../src/ai-failover.js");
const { config } = await import("../src/config.js");
const { DOWN_MS, clearProviderDown, isProviderDown, markProviderDown, noteProviderError } = await import("../src/provider-health.js");

afterEach(() => clearProviderDown());

const apiError = (status, type, message) => Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers());

test("Claude hands over to DeepSeek's stronger model, then OpenAI's strongest", () => {
  assert.deepEqual(failoverModels("claude-opus-5-5"), ["claude-opus-5-5", "deepseek-v4-pro", "gpt-6.1-sol"]);
});

test("a fast model hands over to the other fast provider, then Claude", () => {
  assert.deepEqual(failoverModels("deepseek-flash"), ["deepseek-flash", "gpt-6-luna", "claude-opus-5-5"]);
  assert.deepEqual(failoverModels("gpt-6-luna"), ["gpt-6-luna", "deepseek-flash", "claude-opus-5-5"]);
  assert.deepEqual(failoverModels("deepseek-v4-pro"), ["deepseek-v4-pro", "gpt-6.1-sol", "claude-opus-5-5"]);
});

test("only providers with a key are used", () => {
  const key = config.openaiKey;
  config.openaiKey = null;
  try {
    assert.deepEqual(failoverModels("claude-sonnet-5-5"), ["claude-sonnet-5-5", "deepseek-v4-pro"]);
  } finally {
    config.openaiKey = key;
  }
});

test("a provider out of balance is skipped for a while, then tried again", () => {
  const now = Date.now();
  markProviderDown("claude", "balance", now);
  assert.equal(isProviderDown("claude", now + 1000), true);
  assert.deepEqual(attemptOrder("claude-opus-5-5"), ["deepseek-v4-pro", "gpt-6.1-sol"]);
  assert.equal(isProviderDown("claude", now + DOWN_MS + 1), false);
});

test("noteProviderError marks balance and key refusals down, not a bad request", () => {
  noteProviderError("claude", 400, "prompt is too long");
  assert.equal(isProviderDown("claude"), false);
  noteProviderError("deepseek", 402, "Insufficient Balance");
  assert.equal(isProviderDown("deepseek"), true);
  noteProviderError("openai", 401, "invalid key");
  assert.equal(isProviderDown("openai"), true);
});

test("failover only for the provider's side", () => {
  assert.equal(failoverReason("claude", 400, "Your credit balance is too low"), "balance");
  assert.equal(failoverReason("claude", 400, "messages: field required"), null);
  assert.equal(failoverReason("claude", 404, "not found"), null);
  assert.equal(failoverReason("claude", 401, ""), "auth");
  assert.equal(failoverReason("claude", 529, ""), "overloaded");
  assert.equal(failoverReason("claude", 500, ""), "overloaded");
  assert.equal(failoverReason("claude", 429, ""), "rate_limit");
  assert.equal(failoverReason("claude", 0, ""), "connection");
  assert.equal(failoverReason("openai", 429, "insufficient_quota"), "balance");
  assert.equal(failoverReason("deepseek", 402, ""), "balance");
});

test("a request is adapted for DeepSeek: Claude-only fields and thinking go", () => {
  const request = {
    model: "claude-opus-5-5",
    max_tokens: 1000,
    system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Hi" }, { type: "image", source: { type: "file", file_id: "f1" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "x" }, { type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
    ],
    tools: [{ name: "read", description: "Reads", input_schema: { type: "object" }, eager_input_streaming: true, cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    fallbacks: "default",
    betas: ["server-side-fallback-2026-07-01"],
    context_management: { edits: [] },
    cache_control: { type: "ephemeral" },
    metadata: { user_id: "u" },
  };
  const adapted = adaptRequest(request, "deepseek-v4-pro");
  assert.equal(adapted.model, "deepseek-v4-pro");
  for (const field of ["thinking", "output_config", "fallbacks", "betas", "context_management", "cache_control", "metadata"]) assert.equal(field in adapted, false, field);
  assert.deepEqual(adapted.system, [{ type: "text", text: "Be brief." }]);
  assert.deepEqual(adapted.tools, [{ name: "read", description: "Reads", input_schema: { type: "object" } }]);
  assert.equal(adapted.messages[0].content[1].type, "text");
  assert.deepEqual(adapted.messages[1].content, [{ type: "tool_use", id: "t1", name: "read", input: {} }]);
  // The original is untouched.
  assert.equal(request.messages[1].content.length, 2);
});

test("requests that can't run elsewhere aren't sent there", () => {
  const search = { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search_20260209", name: "web_search" }] };
  assert.equal(adaptRequest(search, "deepseek-v4-pro"), null);
  const tools = { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }], tools: [{ name: "read", input_schema: {} }] };
  assert.equal(adaptRequest(tools, "gpt-6.1-sol"), null);
  const plain = { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }], output_config: { effort: "high" } };
  assert.deepEqual(adaptRequest(plain, "gpt-6.1-sol").output_config, { effort: "high" });
});

test("withFailover hands an out-of-balance Claude request to the next provider", async () => {
  const seen = [];
  const { result, model } = await withFailover({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }], fallbacks: "default" }, async (params, target) => {
    seen.push([target, params.fallbacks]);
    if (target === "claude-opus-5-5") throw apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");
    return "answer";
  });
  assert.equal(result, "answer");
  assert.equal(model, "deepseek-v4-pro");
  assert.deepEqual(seen, [["claude-opus-5-5", "default"], ["deepseek-v4-pro", undefined]]);
});

test("withFailover leaves the request's own errors, started replies and own keys alone", async () => {
  const params = { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] };
  await assert.rejects(withFailover(params, async () => { throw apiError(400, "invalid_request_error", "messages: bad"); }), Anthropic.BadRequestError);
  await assert.rejects(
    withFailover(params, async (p, t, progress) => {
      progress.started = true;
      throw apiError(529, "overloaded_error", "Overloaded");
    }),
    Anthropic.APIError,
  );
  let calls = 0;
  await assert.rejects(
    withFailover(params, async () => {
      calls++;
      throw apiError(401, "authentication_error", "invalid x-api-key");
    }, { enabled: false }),
    Anthropic.AuthenticationError,
  );
  assert.equal(calls, 1);
});

test("withFailover gives AiUnavailableError when nobody can take it", async () => {
  const params = { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] };
  await assert.rejects(withFailover(params, async () => { throw apiError(529, "overloaded_error", "Overloaded"); }), AiUnavailableError);
  markProviderDown("claude", "balance");
  markProviderDown("deepseek", "balance");
  markProviderDown("openai", "auth");
  let called = false;
  await assert.rejects(withFailover(params, async () => { called = true; }), AiUnavailableError);
  assert.equal(called, false);
});
