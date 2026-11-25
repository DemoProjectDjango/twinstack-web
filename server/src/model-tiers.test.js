import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_MODELS, IMAGE_MODELS } from "./ai-providers.js";
import { fastModelForTier, fastTierOf, imageModelForTier, imageTierOf, neutralFastView, neutralImageView } from "./model-tiers.js";

const VENDOR = /claude|anthropic|deepseek|openai|chatgpt|gpt|sonnet|opus|haiku|fable|luna|flash|sol\b|astra|terra|sunburst|flare|nano|mini/i;

const fastView = (over = {}) => ({
  choice: "default",
  unavailable: false,
  default: { id: "deepseek-flash", name: "DeepSeek Flash" },
  active: { id: "deepseek-flash", name: "DeepSeek Flash" },
  models: FAST_MODELS.map((m) => ({ ...m, available: m.provider === "deepseek", price: { output: m.id === "deepseek-flash" ? 1.2 : 4 } })),
  creditsPerDollar: 10_000,
  mainPrice: { output: 20 },
  ...over,
});

const imageView = (over = {}) => ({
  choice: "default",
  unavailable: false,
  available: true,
  default: { id: "gpt-image-2", name: "GPT Image 2" },
  active: { id: "gpt-image-2", name: "GPT Image 2" },
  models: IMAGE_MODELS.map((m) => ({ ...m, price: null, pictureCredits: m.id === "gpt-image-1-mini" ? 100 : 400 })),
  ...over,
});

test("owners' routine-work view names no model or provider", () => {
  const view = neutralFastView(fastView());
  assert.doesNotMatch(JSON.stringify(view), VENDOR);
  assert.equal(view.choice, "default");
  assert.equal(view.default, "fastest");
  assert.deepEqual(
    view.options.map((o) => [o.id, o.label, o.available]),
    [
      ["default", "Recommended", true],
      ["best", "Best quality", true],
      ["balanced", "Balanced", true],
      ["fastest", "Fastest and cheapest", true],
    ],
  );
  // 1.2 $/M output × 1,333 tokens × 10,000 credits/$ ≈ 16; the main AI's 20 $/M ≈ 267.
  assert.equal(view.options.find((o) => o.id === "fastest").creditsPer1000Words, 16);
  assert.equal(view.options.find((o) => o.id === "best").creditsPer1000Words, 267);
});

test("admins also get the model names", () => {
  const view = neutralFastView(fastView(), { admin: true });
  assert.equal(view.models.active.name, "DeepSeek Flash");
  assert.equal(neutralImageView(imageView(), { admin: true }).models.default.name, "GPT Image 2");
});

test("a tier maps to the admin's default when it lists it, else its first model that can run", () => {
  assert.equal(fastModelForTier("fastest", fastView()), "deepseek-flash");
  assert.equal(fastModelForTier("balanced", fastView()), "deepseek-v4-pro");
  assert.equal(fastModelForTier("best", fastView()), "off");
  assert.equal(fastModelForTier("default", fastView()), "default");
  assert.equal(fastModelForTier("gpt-6-luna", fastView()), undefined);
  const openaiOnly = fastView({ default: { id: "gpt-6-luna", name: "x" }, models: FAST_MODELS.map((m) => ({ ...m, available: m.provider === "openai", price: null })) });
  assert.equal(fastModelForTier("fastest", openaiOnly), "gpt-6-luna");
  assert.equal(fastModelForTier("balanced", openaiOnly), "gpt-6.1-sol");
  const none = fastView({ default: null, models: FAST_MODELS.map((m) => ({ ...m, available: false, price: null })) });
  assert.equal(fastModelForTier("fastest", none), null);
  assert.equal(neutralFastView(none).options.find((o) => o.id === "fastest").available, false);
});

test("stored model choices read back as tiers", () => {
  assert.equal(fastTierOf("off"), "best");
  assert.equal(fastTierOf("deepseek-v4-pro"), "balanced");
  assert.equal(fastTierOf("gpt-6-astra"), "custom");
  assert.equal(imageTierOf("gpt-image-1-mini"), "fastest");
  assert.equal(imageTierOf("gpt-image-2.5-flare"), "balanced");
  const custom = neutralFastView(fastView({ choice: "gpt-6-astra", active: { id: "gpt-6-astra", name: "GPT-6 Astra" } }));
  assert.equal(custom.choice, "custom");
  assert.equal(custom.options.at(-1).id, "custom");
  assert.doesNotMatch(JSON.stringify(custom), VENDOR);
});

test("pictures: tiers, costs and no names", () => {
  const view = neutralImageView(imageView());
  assert.doesNotMatch(JSON.stringify(view), VENDOR);
  assert.equal(view.options.find((o) => o.id === "fastest").pictureCredits, 100);
  assert.equal(imageModelForTier("fastest", imageView()), "gpt-image-1-mini");
  assert.equal(imageModelForTier("best", imageView()), "gpt-image-2");
  assert.equal(imageModelForTier("balanced", imageView()), "gpt-image-2");
  assert.equal(imageModelForTier("balanced", imageView({ default: { id: "gpt-image-1-mini" } })), "gpt-image-2.5-flare");
});
