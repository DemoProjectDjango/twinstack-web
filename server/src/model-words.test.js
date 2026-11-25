import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_MODELS, IMAGE_MODELS } from "./ai-providers.js";
import { CLAUDE_MODELS } from "./claude-models.js";
import { publicJobView, scrubModelNames } from "./model-words.js";

const VENDOR = /claude|anthropic|deepseek|openai|chatgpt|gpt|sonnet|opus|haiku|fable|luna\b|flash\b/i;

test("the template's log lines lose their model ids", () => {
  assert.equal(scrubModelNames("Search text added by deepseek-flash"), "Search text added by the AI");
  assert.equal(scrubModelNames("Asking claude-opus-5-5 (effort medium)…"), "Asking the AI (effort medium)…");
  assert.equal(scrubModelNames("Work-log summary by claude-haiku-4-5-20251001."), "Work-log summary by the AI.");
  assert.equal(scrubModelNames("gpt-6-luna failed the checks; falling back to claude-sonnet-5-5"), "The AI failed the checks; falling back to the AI");
});

test("names, families and companies, keeping sentences readable", () => {
  assert.equal(scrubModelNames("Claude is writing the page."), "The AI is writing the page.");
  assert.equal(scrubModelNames("The first homepage is written by Claude Opus 5.5."), "The first homepage is written by the AI.");
  assert.equal(scrubModelNames("Reviewed by Sonnet."), "Reviewed by the AI.");
  assert.equal(scrubModelNames("the Claude model replied"), "the AI model replied");
  assert.equal(scrubModelNames("a DeepSeek request"), "an AI request");
  assert.equal(scrubModelNames("OpenAI refused the picture request."), "The AI refused the picture request.");
  assert.equal(scrubModelNames("line one\nClaude's design is ready"), "line one\nThe AI's design is ready");
  assert.equal(scrubModelNames("▸ Claude designs your homepage"), "▸ The AI designs your homepage");
  assert.equal(scrubModelNames("Missing ANTHROPIC_API_KEY"), "Missing AI_API_KEY");
});

test("ordinary words and other text are left alone", () => {
  const text = "A fable about a sonnet and a haiku. Building 12 pages, 3 images (gpt is not here: gptx). Flash sale!";
  assert.equal(scrubModelNames("A fable about a sonnet and a haiku. Flash sale!"), "A fable about a sonnet and a haiku. Flash sale!");
  assert.match(scrubModelNames(text), /Building 12 pages/);
  assert.equal(scrubModelNames(""), "");
  assert.equal(scrubModelNames(null), null);
});

test("every catalogued model id and name is scrubbed", () => {
  for (const m of [...CLAUDE_MODELS, ...FAST_MODELS, ...IMAGE_MODELS]) {
    assert.doesNotMatch(scrubModelNames(`Using ${m.id} now`), VENDOR, m.id);
    assert.doesNotMatch(scrubModelNames(`Using ${m.name} now`), /claude|deepseek|gpt|opus|sonnet|fable/i, m.name);
  }
});

test("a running job's unfinished line waits for the next poll", () => {
  const view = { id: "j", label: "Write SEO with Claude", status: "running", output: "Start\nSearch text added by deeps", next: 128 };
  const shown = publicJobView(view);
  assert.equal(shown.output, "Start\n");
  assert.equal(shown.next, 128 - "Search text added by deeps".length);
  assert.equal(shown.label, "Write SEO with the AI");
  const done = publicJobView({ ...view, status: "done", output: "Search text added by deepseek-flash" });
  assert.equal(done.output, "Search text added by the AI");
  assert.equal(done.next, 128);
  assert.equal(publicJobView(view, { admin: true }), view);
});
