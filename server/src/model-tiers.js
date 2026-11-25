// A site's AI settings as owners see them (ModelPanel.tsx, GET/PUT …/ai-models): neutral choices
// ("Best quality", "Balanced", "Fastest and cheapest") with what they cost, mapped here to the
// models behind them. Owners never see a model's or provider's name: the views below carry tier
// ids and plain words only. Admins also get `models` (the names), for checking what runs.
// Pure: tests load it without a database or server settings.

// Routine work (fast-model.js). Each tier lists its models, preferred first; the first one that can
// run is used, unless the admin's default is in the tier. "best" is no cheaper model at all: the
// main AI does everything ("off").
export const FAST_TIERS = [
  {
    id: "best",
    label: "Best quality",
    description: "The main AI does all of this site's work. The best results, and the most credits.",
    models: null,
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Routine work goes to a mid-priced AI first. Good results for fewer credits.",
    models: ["deepseek-v4-pro", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.4"],
  },
  {
    id: "fastest",
    label: "Fastest and cheapest",
    description: "Routine work goes to a quick, low-cost AI first. The fewest credits; the main AI redoes anything that doesn't pass the site's checks.",
    models: ["deepseek-flash", "gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-nano", "gpt-5.4-mini"],
  },
];

// Pictures (image-model.js).
export const IMAGE_TIERS = [
  {
    id: "best",
    label: "Best quality",
    description: "The most precise pictures, with clear text in them.",
    models: ["gpt-image-2.5-sunburst", "gpt-image-2", "gpt-image-1.5"],
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Quick, good pictures for everyday use.",
    models: ["gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5"],
  },
  {
    id: "fastest",
    label: "Fastest and cheapest",
    description: "Simpler pictures for about a quarter of the credits.",
    models: ["gpt-image-1-mini"],
  },
];

const DEFAULT_OPTION = { id: "default", label: "Recommended", description: "Twinstack's recommended choice. If it changes, this site follows it." };

// A thousand words are about 1,333 tokens of writing.
const TOKENS_PER_1000_WORDS = 1333;

/** About how many credits 1,000 written words cost at `price` (a PRICES entry), or null. */
export function creditsPer1000Words(price, creditsPerDollar) {
  if (!price?.output || !creditsPerDollar) return null;
  return Math.max(1, Math.round(((price.output * TOKENS_PER_1000_WORDS) / 1e6) * creditsPerDollar));
}

/** The tier a stored routine-work choice belongs to: "default", a tier id, or "custom" (a model no tier lists). */
export function fastTierOf(choice) {
  if (!choice || choice === "default") return "default";
  if (choice === "off") return "best";
  return FAST_TIERS.find((t) => t.models?.includes(choice))?.id ?? "custom";
}

/** The tier a stored picture choice belongs to (the first that lists it), or "custom". */
export function imageTierOf(choice) {
  if (!choice || choice === "default") return "default";
  return IMAGE_TIERS.find((t) => t.models.includes(choice))?.id ?? "custom";
}

/** The model a tier means now: the admin's default when the tier lists it, else its first model that can run. */
function pickFrom(tier, canRun, preferred) {
  if (!tier) return undefined;
  if (preferred && tier.models.includes(preferred) && canRun(preferred)) return preferred;
  return tier.models.find(canRun) ?? null;
}

/**
 * What a routine-work choice saves (chooseSiteFastModel's argument): "default", "off", or the
 * tier's model. `view` is siteFastModelView's. Undefined for an unknown choice, null when the tier
 * has no model that can run.
 */
export function fastModelForTier(choice, view) {
  if (choice === "default") return "default";
  if (choice === "best") return "off";
  const tier = FAST_TIERS.find((t) => t.id === choice && t.models);
  const available = new Set(view.models.filter((m) => m.available).map((m) => m.id));
  return pickFrom(tier, (id) => available.has(id), view.default?.id);
}

/** What a picture choice saves (chooseSiteImageModel's argument), like fastModelForTier. */
export function imageModelForTier(choice, view) {
  if (choice === "default") return "default";
  const tier = IMAGE_TIERS.find((t) => t.id === choice);
  const offered = new Set(view.models.map((m) => m.id));
  return pickFrom(tier, (id) => offered.has(id), view.default?.id);
}

/** A model as an admin sees it on the site's AI settings. */
const named = (m) => m && { id: m.id, name: m.name };

/**
 * Routine work as owners see it, from siteFastModelView's `view`: the choice and what's running
 * as tiers, and each choice with its credits per 1,000 words. `admin` adds the model names.
 */
export function neutralFastView(view, { admin = false } = {}) {
  const priceOf = (id) => view.models.find((m) => m.id === id)?.price ?? null;
  const per1000 = (id) => creditsPer1000Words(id ? priceOf(id) : view.mainPrice, view.creditsPerDollar);
  const options = [
    { ...DEFAULT_OPTION, available: true, creditsPer1000Words: per1000(view.default?.id ?? null) },
    ...FAST_TIERS.map((t) => {
      const model = t.models ? fastModelForTier(t.id, view) : null;
      return { id: t.id, label: t.label, description: t.description, available: !t.models || Boolean(model), creditsPer1000Words: per1000(model) };
    }),
  ];
  const choice = fastTierOf(view.choice);
  return {
    choice,
    unavailable: view.unavailable,
    // Which tier the recommended choice and what runs now are ("best" when the main AI does it all).
    default: fastTierOf(view.default?.id ?? "off"),
    active: fastTierOf(view.active?.id ?? "off"),
    options: choice === "custom" ? [...options, { id: "custom", label: "Custom", description: "A setting Twinstack made for this site.", available: true, creditsPer1000Words: per1000(view.active?.id ?? null) }] : options,
    ...(admin && { models: { choice: view.choice, default: named(view.default), active: named(view.active) } }),
  };
}

/** Pictures as owners see them, from siteImageModelView's `view`, like neutralFastView. */
export function neutralImageView(view, { admin = false } = {}) {
  const creditsOf = (id) => view.models.find((m) => m.id === id)?.pictureCredits ?? null;
  const options = [
    { ...DEFAULT_OPTION, available: true, pictureCredits: creditsOf(view.default?.id) },
    ...IMAGE_TIERS.map((t) => {
      const model = imageModelForTier(t.id, view);
      return { id: t.id, label: t.label, description: t.description, available: Boolean(model), pictureCredits: creditsOf(model) };
    }),
  ];
  const choice = imageTierOf(view.choice);
  return {
    choice,
    unavailable: view.unavailable,
    available: view.available,
    default: imageTierOf(view.default?.id),
    active: view.active ? imageTierOf(view.active.id) : null,
    options: choice === "custom" ? [...options, { id: "custom", label: "Custom", description: "A setting Twinstack made for this site.", available: true, pictureCredits: creditsOf(view.active?.id) }] : options,
    ...(admin && { models: { choice: view.choice, default: named(view.default), active: named(view.active) } }),
  };
}
