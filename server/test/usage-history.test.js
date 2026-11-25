import assert from "node:assert/strict";
import { test } from "node:test";
import { usagePart, usagePurpose, usageRunView, usageSummary, usageTarget } from "../src/usage-history.js";

const VENDOR = /claude|anthropic|deepseek|openai|chatgpt|gpt|sonnet|opus|haiku|fable|luna|flash/i;

const request = (over = {}) => ({ model: "claude-opus-5-5", siteId: 42, credits: 10, charged: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5, ...over });

test("a page edit names the page, the purpose and merges every model's tokens and credits", () => {
  const run = {
    _id: "run1",
    createdAt: new Date("2026-11-25T10:00:00Z"),
    startedAt: new Date("2026-11-25T09:59:00Z"),
    kind: "command",
    command: "page-edit",
    target: { file: "content/pages/about.md", title: "About us", address: "/about/" },
    requests: [request(), request({ model: "deepseek-flash", credits: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 })],
  };
  const view = usageRunView(run, new Map([[42, "Joe's Bakery"]]));
  assert.deepEqual(view, {
    id: "run1",
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    site: { name: "Joe's Bakery" },
    part: "About us (/about/)",
    purpose: "Changing a page",
    pictures: 0,
    requests: 2,
    tokensIn: 135,
    tokensOut: 55,
    charged: true,
    ownKey: false,
    credits: 12,
  });
  assert.doesNotMatch(JSON.stringify(view), VENDOR);
});

test("old records without a target still read sensibly", () => {
  assert.equal(usagePart({ kind: "command", command: "page-edit" }), "A page");
  assert.equal(usagePart({ kind: "command", command: "seo-claude" }), "Search text");
  assert.equal(usagePart({ kind: "command", command: "chrome-design" }), "Header & footer");
  assert.equal(usagePart({ kind: "command", command: null }), "Your site");
  assert.equal(usagePurpose({ kind: "command", command: "something-new" }), "Working on your site");
});

test("the homepage, search text for every page and plan files", () => {
  assert.equal(usagePart({ kind: "command", command: "page-generate", target: { file: "content/pages/home.md", title: "Home", address: "/" } }), "Homepage");
  assert.equal(usagePart({ kind: "command", command: "page-edit", target: { file: "content/pages/home.md" } }), "Homepage");
  assert.equal(usagePart({ kind: "command", command: "page-edit", target: { file: "content/blog/2026-01-02-first-post.md" } }), "first-post");
  assert.equal(usagePart({ kind: "command", command: "seo-claude", target: { all: true } }), "Search text, all pages");
  assert.equal(usagePart({ kind: "command", command: "seo-claude", target: { file: "content/pages/contact.md", title: "Contact" } }), "Search text: Contact");
  assert.equal(usagePart({ kind: "command", command: "md-edit", target: { file: "scripts/site-tree.md" } }), "Page plan");
});

test("assistant answers and setup builds count their pictures without naming the image model", () => {
  const view = usageRunView({ _id: "t", kind: "assistant", command: null, requests: [request(), request({ model: "gpt-image-2", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })] });
  assert.equal(view.part, "Chat with the AI, images");
  assert.equal(view.purpose, "Answering your message");
  assert.equal(view.pictures, 1);
  assert.equal(usagePurpose({ kind: "setup", command: "site-build" }), "Building your site");
  assert.equal(usagePurpose({ kind: "setup" }), "Planning your site");
  assert.doesNotMatch(JSON.stringify(view), VENDOR);
});

test("a removed site has no name, and work with no site has no site", () => {
  assert.deepEqual(usageRunView({ _id: "a", kind: "assistant", requests: [request({ siteId: 7 })] }).site, { name: null });
  assert.equal(usageRunView({ _id: "b", kind: "assistant", requests: [request({ siteId: null })] }).site, null);
});

test("own-key runs aren't charged", () => {
  const view = usageRunView({ _id: "c", kind: "command", command: "page-edit", requests: [request({ charged: false })] });
  assert.equal(view.charged, false);
  assert.equal(view.ownKey, true);
  assert.equal(view.credits, 0);
});

test("the summary splits by purpose, merging kinds that mean the same", () => {
  const summary = usageSummary([
    { _id: { kind: "command", command: "page-edit" }, credits: 300, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { _id: { kind: "command", command: "site-build" }, credits: 100, inputTokens: 1, outputTokens: 1 },
    { _id: { kind: "setup", command: "site-build" }, credits: 50 },
    { _id: { kind: "assistant", command: null }, credits: 0, inputTokens: 0, outputTokens: 0 },
  ]);
  assert.equal(summary.credits, 450);
  assert.deepEqual(
    summary.purposes.map((p) => [p.purpose, p.credits]),
    [
      ["Changing a page", 300],
      ["Building your site", 150],
    ],
  );
  assert.doesNotMatch(JSON.stringify(summary), VENDOR);
});

test("usageTarget records only what names a part of the site", () => {
  assert.deepEqual(usageTarget("page-edit", { page: "content/pages/about.md", instruction: "x" }, { title: "About", url: "/about/" }), {
    file: "content/pages/about.md",
    title: "About",
    address: "/about/",
  });
  assert.deepEqual(usageTarget("seo-claude", { all: true }), { all: true });
  assert.deepEqual(usageTarget("md-edit", { file: "scripts/site-tree.md" }), { file: "scripts/site-tree.md" });
  assert.equal(usageTarget("chrome-design", {}), null);
  assert.equal(usageTarget("page-edit", {}), null);
});
