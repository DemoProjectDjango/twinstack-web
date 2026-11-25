import { anthropicError, json, mock, resetMock, streamReply } from "./env.js";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const { AiUnavailableError } = await import("../src/ai-errors.js");
const { anthropicClient, runTurn } = await import("../src/assistant/turn.js");
const { clearProviderDown } = await import("../src/provider-health.js");

/** credits.js's Spend, reduced to what runTurn uses: everything allowed, each finish kept. */
function spends() {
  const finished = [];
  const begin = async () => ({
    stopped: false,
    clamped: false,
    shortfall: null,
    usage: null,
    async fitMaxTokens(requested) {
      return requested;
    },
    maxTokens(requested) {
      return requested;
    },
    track() {
      return false;
    },
    async finish(result = {}) {
      finished.push(result);
    },
  });
  return { begin, finished };
}

const history = [{ role: "user", content: "What's on my homepage?" }];

beforeEach(() => {
  resetMock();
  clearProviderDown();
});

test("the assistant carries on with DeepSeek when the app's Claude account is out of balance", async () => {
  mock.handlers.claude = (body, req, res) => json(res, 400, anthropicError("invalid_request_error", "Your credit balance is too low to access the Anthropic API."));
  mock.handlers.deepseek = (body, req, res) => streamReply(res, body.model, "Your homepage has a hero.");
  const { begin, finished } = spends();
  const live = { parts: [], actions: [] };
  const result = await runTurn({ client: anthropicClient("test-claude-key"), key: null, model: "claude-sonnet-5-5", history, live, beginSpend: begin });
  assert.equal(result.model, "deepseek-v4-pro");
  assert.deepEqual(result.appended.at(-1), { role: "assistant", content: [{ type: "text", text: "Your homepage has a hero." }] });
  assert.equal(finished.at(-1).model, "deepseek-v4-pro");
  const sent = mock.calls.deepseek[0].body;
  for (const field of ["betas", "context_management", "fallbacks", "cache_control", "output_config", "metadata"]) assert.equal(field in sent, false, field);
  assert.ok(sent.tools.length > 0);
  assert.ok(sent.tools.every((t) => Object.keys(t).every((k) => ["name", "description", "input_schema"].includes(k))));
});

test("with every provider out, the turn ends with AiUnavailableError", async () => {
  mock.handlers.claude = (body, req, res) => json(res, 400, anthropicError("invalid_request_error", "Your credit balance is too low to access the Anthropic API."));
  mock.handlers.deepseek = (body, req, res) => json(res, 402, anthropicError("invalid_request_error", "Insufficient Balance"));
  const { begin } = spends();
  await assert.rejects(
    runTurn({ client: anthropicClient("test-claude-key"), key: null, model: "claude-sonnet-5-5", history, live: { parts: [], actions: [] }, beginSpend: begin }),
    AiUnavailableError,
  );
  // The assistant's tools can't go to OpenAI: it was never asked.
  assert.equal(mock.calls.openai.length, 0);
});

test("on the account's own key there's no failover", async () => {
  mock.handlers.claude = (body, req, res) => json(res, 401, anthropicError("authentication_error", "invalid x-api-key"));
  const { begin } = spends();
  await assert.rejects(runTurn({ client: anthropicClient("sk-ant-own"), key: null, model: "claude-sonnet-5-5", history, live: { parts: [], actions: [] }, beginSpend: begin }), { status: 401 });
  assert.equal(mock.calls.deepseek.length, 0);
});
