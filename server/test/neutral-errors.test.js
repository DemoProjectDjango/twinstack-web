import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";

const { AI_BUSY, AiUnavailableError, OWN_KEY_REFUSED } = await import("../src/ai-errors.js");
const { friendlyError } = await import("../src/routes/assistant.js");
const { getJob, startJob } = await import("../src/jobs.js");

const apiError = (status, type, message) => Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers());
const NAMES = /claude|anthropic|openai|deepseek|\d{3}|\{/i;

test("the assistant's errors never name a provider or show raw errors", () => {
  const cases = [
    apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."),
    apiError(400, "invalid_request_error", "messages: text content blocks must be non-empty"),
    apiError(401, "authentication_error", "invalid x-api-key"),
    apiError(403, "permission_error", "no access"),
    apiError(429, "rate_limit_error", "slow down"),
    apiError(529, "overloaded_error", "Overloaded"),
    new Anthropic.APIConnectionError({ message: "Connection error." }),
    new AiUnavailableError(),
    new Error("boom"),
  ];
  for (const err of cases) {
    const text = friendlyError(err);
    assert.doesNotMatch(text, NAMES, text);
    assert.doesNotMatch(text, /buy/i, text);
  }
  assert.equal(friendlyError(new AiUnavailableError()), AI_BUSY);
  assert.equal(friendlyError(apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")), AI_BUSY);
  assert.equal(friendlyError(apiError(401, "authentication_error", "invalid x-api-key")), AI_BUSY);
});

test("an own key that's refused is the owner's to fix", () => {
  assert.equal(friendlyError(apiError(401, "authentication_error", "invalid x-api-key"), { ownKey: true }), OWN_KEY_REFUSED);
  assert.doesNotMatch(friendlyError(apiError(400, "invalid_request_error", "Your credit balance is too low"), { ownKey: true }), NAMES);
});

test("a job's log gets plain words instead of a provider's error", async () => {
  const raw = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
  const script = `console.log("  Writing the page"); console.error(${JSON.stringify(`\n  Edit failed: Anthropic API 400: ${raw}\n`)}); process.exit(1);`;
  const started = startJob({
    key: "test-key",
    userId: "user-1",
    command: "page-edit",
    label: "Edit",
    steps: [{ file: process.execPath, args: ["-e", script], display: "edit", timeoutMs: 20_000 }],
    cwd: process.cwd(),
    env: process.env,
    release: () => {},
  });
  let job;
  for (let i = 0; i < 200 && (job = getJob(started.id, "user-1")).status === "running"; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(job.status, "failed");
  assert.match(job.text, /Writing the page/);
  assert.match(job.text, new RegExp(`Edit failed: ${AI_BUSY.replace(/[().]/g, "\\$&")}`));
  assert.doesNotMatch(job.text, /credit balance|Anthropic|\{"type"/);
});
