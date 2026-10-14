import { FAST_MODELS, providerOf } from "./ai-providers.js";
import { CLAUDE_MODELS } from "./claude-models.js";
import { config } from "./config.js";
import { CREDITS_PER_USD, listedPrices } from "./credits.js";
import { getAppSetting, setAppSetting } from "./db.js";

// The cheaper "fast" model: routine page work, header and footer work, search text, markdown edits,
// work-log summaries (the site's scripts, as TWINSTACK_FAST_MODEL) and site details in "Ask Claude"
// (assistant/details-turn.js). An admin picks it on /admin/models, from FAST_MODELS or "off" (Claude
// does everything); until one does, FAST_PAGE_MODEL decides, and unset, DeepSeek Flash when there's a
// DeepSeek key, else GPT-6 Luna when there's an OpenAI key. A model whose provider has no key isn't
// used. The choice is kept in memory (one API process) and in appSettings, read once at startup.

const SETTING = "fastModel";

// The admin's choice: a model id, "off", or null when none was made.
let chosen = null;
let chosenAt = null;
let chosenBy = null;

export async function loadFastModelChoice() {
  const doc = await getAppSetting(SETTING);
  chosen = typeof doc?.value === "string" ? doc.value : null;
  chosenAt = doc?.updatedAt ?? null;
  chosenBy = doc?.updatedBy ?? null;
}

/** The app's key for a fast model's provider, or null. */
export function fastModelKey(model) {
  const provider = providerOf(model);
  if (provider === "deepseek") return config.deepseekKey;
  if (provider === "openai") return config.openaiKey;
  return null;
}

/** What's chosen before checking for a key: the admin's choice, else FAST_PAGE_MODEL, else by key. */
function wanted() {
  if (chosen) return chosen;
  if (config.fastPageModel) return config.fastPageModel;
  if (config.deepseekKey) return "deepseek-flash";
  if (config.openaiKey) return "gpt-6-luna";
  return "off";
}

/** The fast model to use now, or null (Claude does everything). */
export function currentFastModel() {
  const model = wanted();
  if (model === "off") return null;
  return fastModelKey(model) ? model : null;
}

/** What /admin/models shows: the choice, where it came from, what's in use and each model's availability. */
export function fastModelView() {
  const model = wanted();
  return {
    choice: model,
    source: chosen ? "admin" : config.fastPageModel ? "env" : "default",
    active: currentFastModel(),
    updatedAt: chosenAt,
    updatedBy: chosenBy,
    providers: { deepseek: Boolean(config.deepseekKey), openai: Boolean(config.openaiKey) },
    models: [
      ...FAST_MODELS,
      // FAST_PAGE_MODEL may name a model outside the list: show it so it can be kept.
      ...(model !== "off" && !FAST_MODELS.some((m) => m.id === model) ? [{ id: model, provider: providerOf(model), name: model, description: "Set by FAST_PAGE_MODEL on the server." }] : []),
    ].map((m) => ({ ...m, available: Boolean(fastModelKey(m.id)), price: listedPrices(m.id) })),
    // Claude's prices beside them: the account's model choices, and the work-log summaries' Haiku.
    claude: [...CLAUDE_MODELS, { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }].map((m) => ({ id: m.id, name: m.name, price: listedPrices(m.id) })),
    creditsPerDollar: CREDITS_PER_USD,
  };
}

/** A choice setFastModel refuses, with a message for the admin. */
export class FastModelError extends Error {}

/**
 * Saves the admin's choice: a listed model, "off", or the one FAST_PAGE_MODEL names. Throws
 * FastModelError when the model isn't one of those or its provider has no key.
 */
export async function setFastModel(model, adminEmail) {
  const allowed = model === "off" || FAST_MODELS.some((m) => m.id === model) || (model && model === config.fastPageModel);
  if (!allowed) throw new FastModelError("Choose one of the listed models, or Off.");
  if (model !== "off" && !fastModelKey(model)) {
    throw new FastModelError(providerOf(model) === "openai" ? "Set OPENAI_API_KEY on the server to use OpenAI models." : "Set DEEPSEEK_API_KEY on the server to use DeepSeek models.");
  }
  await setAppSetting(SETTING, model, adminEmail);
  chosen = model;
  chosenAt = new Date();
  chosenBy = adminEmail;
}
