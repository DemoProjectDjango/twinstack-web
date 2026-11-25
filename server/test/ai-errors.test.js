import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_BUSY, AI_FAILED, neutralLine, neutralText } from "../src/ai-errors.js";

const balanceBody = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });

test("a script's final error line becomes the maintenance message", () => {
  const line = `  Edit failed: Anthropic API 400: ${balanceBody}`;
  assert.equal(neutralLine(line), `  Edit failed: ${AI_BUSY}`);
});

test("the proxy's own neutral error is shown as its message", () => {
  const body = JSON.stringify({ type: "error", error: { type: "api_error", message: AI_BUSY } });
  assert.equal(neutralLine(`  Edit failed: Anthropic API 503: ${body}`), `  Edit failed: ${AI_BUSY}`);
});

test("a fallback line keeps what came before and says it briefly", () => {
  const out = neutralLine(`  ! deepseek-flash failed: Anthropic API 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`);
  assert.equal(out, "  ! deepseek-flash failed: the AI service is busy right now.");
});

test("brackets around the error stay balanced", () => {
  const out = neutralLine(`  ! The API rejected the request (Anthropic API 400: {"type":"error","error":{"type":"invalid_request_error","message":"bad image"}}).`);
  assert.equal(out, "  ! The API rejected the request (the AI couldn't handle the request).");
});

test("the SDK's raw error alone is replaced whole", () => {
  assert.equal(neutralLine(`400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}`), AI_FAILED);
  assert.equal(neutralLine(`401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`), AI_BUSY);
});

test("the account's own out-of-credits line is kept for the browser to find", () => {
  const line = `  Edit failed: Anthropic API 402: {"type":"error","error":{"type":"billing_error","message":"You've used all your Claude credits."}}`;
  assert.equal(neutralLine(line), line);
});

test("ordinary lines are untouched", () => {
  for (const line of ["Claude is combining styles/main.css…", "  error: broken link /about/", "Done.", ""]) assert.equal(neutralLine(line), line);
  const text = "Building\nAnthropic API 500: {\"type\":\"error\"}\nDone.\n";
  assert.equal(neutralText(text), `Building\n${AI_BUSY}\nDone.\n`);
});
