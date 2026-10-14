// The AIs requests can run on: Claude (Anthropic) for everything, and the cheaper "fast" model for
// routine work, from DeepSeek or OpenAI (ChatGPT), whichever the admin picks on /admin/models
// (fast-model.js). The site's scripts send every request in Claude's format to the metering proxy
// (claude-proxy.js), which sends deepseek-* requests to DeepSeek's Anthropic-compatible API as they
// are and translates OpenAI ones (openai-bridge.js). No imports: db.js and credits.js use it too.

export const PROVIDERS = ["claude", "deepseek", "openai"];

/** Which AI a model belongs to: "deepseek" for deepseek-*, "openai" for gpt-* and o<n>*, else "claude". */
export function providerOf(model) {
  if (typeof model !== "string") return "claude";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (/^(gpt-|o\d)/.test(model)) return "openai";
  return "claude";
}

// A fast model id the server accepts from FAST_PAGE_MODEL (any DeepSeek or OpenAI model).
export const FAST_MODEL_ID = /^(deepseek-|gpt-|o\d)[\w.-]*$/;

// The fast models the admin can choose between. Prices are in credits.js (PRICES).
export const FAST_MODELS = [
  {
    id: "deepseek-flash",
    provider: "deepseek",
    name: "DeepSeek Flash",
    description: "Cheap and quick. Good for routine edits, weaker on design.",
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    name: "DeepSeek V4 Pro",
    description: "DeepSeek's stronger model, at about four times Flash's price.",
  },
  // OpenAI, cheapest first within each generation. Prices compare with Claude's in credits.js.
  {
    id: "gpt-6-luna",
    provider: "openai",
    name: "GPT-6 Luna",
    description: "OpenAI's most efficient model. About a third of DeepSeek Flash's price.",
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    name: "GPT-6.1 Sol",
    description: "OpenAI's balanced model. Better work, at about Claude Sonnet 5.5's price.",
  },
  {
    id: "gpt-6-sol",
    provider: "openai",
    name: "GPT-6 Sol",
    description: "The previous Sol, at the same price as GPT-6.1 Sol.",
  },
  {
    id: "gpt-6-astra",
    provider: "openai",
    name: "GPT-6 Astra",
    description: "OpenAI's flagship. Priced like Claude Fable 5.1, above Claude Opus 5.5.",
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    name: "GPT-5.6 Luna",
    description: "Small and cheap, at about DeepSeek Flash's price.",
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    name: "GPT-5.6 Terra",
    description: "Mid-sized, a little above Claude Sonnet 5.5's price.",
  },
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    name: "GPT-5.6 Sol",
    description: "The larger 5.6 model, at about Claude Opus 5.5's price.",
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    name: "GPT-5.5",
    description: "Older flagship, above Claude Opus 5.5's price.",
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    name: "GPT-5.4 nano",
    description: "Older and the smallest, at about DeepSeek Flash's price.",
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    name: "GPT-5.4 mini",
    description: "Older small model, at about three times DeepSeek Flash's price.",
  },
  {
    id: "gpt-5.4",
    provider: "openai",
    name: "GPT-5.4",
    description: "Older full-size model, a little above Claude Sonnet 5.5's price.",
  },
];

export const PROVIDER_NAMES = { claude: "Claude", deepseek: "DeepSeek", openai: "ChatGPT (OpenAI)" };
