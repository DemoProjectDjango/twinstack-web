import { config } from "./config.js";
import { CREDITS_PER_USD, listedPrices } from "./credits.js";
import { noteProviderError } from "./provider-health.js";
import { sniffImage } from "./site-files.js";

// Pictures "Ask Claude" makes (create_image with a prompt): photos and illustrations for pages, from
// OpenAI's Images API (the site's image model, image-model.js, on OPENAI_API_KEY), which Claude
// can't draw as SVG. One
// image per request, paid for in credits like Claude: the request can't be capped or cut off
// part-way, so its most it could cost is held against the balance first (Spend.reserve), and it's
// charged from the reply's token usage (or that estimate, when the reply has none).

const ENDPOINT = "https://api.openai.com/v1/images/generations";
// Images at high quality can take a minute or two.
const TIMEOUT_MS = 4 * 60 * 1000;
export const MAX_PROMPT_CHARS = 4000;

export const SHAPES = ["square", "landscape", "portrait", "wide"];
export const QUALITIES = ["low", "medium", "high"];
const SIZES = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536", wide: "1536x864" };
// Only the gpt-image-2 family takes sizes other than the three standard ones; older models get
// "wide" as landscape.
const FLEXIBLE_SIZES = /^gpt-image-[2-9]/;
// Image tokens at 1024x1024, at most, by quality (gpt-image-2 lists $0.006 low and $0.211 high
// there, at $30 per million): what a request is held against the balance for. Larger sizes scale.
const OUTPUT_TOKENS = { low: 400, medium: 2400, high: 7200 };
// An image model missing from credits.js's PRICES (an IMAGE_MODEL set by hand).
const UNLISTED_PRICE = { input: 10, output: 40 };
// gpt-image-2's image input costs $8 a million against $5 for text (credits.js): counted as text.
const IMAGE_INPUT_RATIO = 8 / 5;
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** A request's problem in words Claude can act on (draw it as SVG, describe it differently, try later). */
export class ImageError extends Error {}

/** Whether pictures can be made on this server. */
export const imagesAvailable = () => Boolean(config.openaiKey);

function sizeFor(model, shape) {
  return shape === "wide" && !FLEXIBLE_SIZES.test(model) ? SIZES.landscape : SIZES[shape];
}

/** The most an image could cost in credits, and the usage to charge when the reply reports none. */
function estimate(model, size, quality, prompt) {
  const [width, height] = size.split("x").map(Number);
  const usage = {
    input_tokens: Math.ceil(prompt.length / 3),
    output_tokens: Math.ceil((OUTPUT_TOKENS[quality] * width * height) / (1024 * 1024)),
  };
  const price = listedPrices(model) ?? UNLISTED_PRICE;
  const credits = ((usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6) * CREDITS_PER_USD;
  return { usage, credits: Math.ceil(credits) };
}

/** The most a picture costs in credits on `model` (what the AI model screen shows): a medium landscape one by default. */
export function pictureCredits(model, shape = "landscape", quality = "medium") {
  return estimate(model, sizeFor(model, shape), quality, "").credits;
}

/** The reply's usage as credits.js prices it: prompt tokens as input, image tokens as output. */
function usageOf(reply) {
  const u = reply?.usage;
  if (!u || !Number.isFinite(u.output_tokens)) return null;
  const imageInput = u.input_tokens_details?.image_tokens ?? 0;
  const textInput = u.input_tokens_details?.text_tokens ?? (u.input_tokens ?? 0) - imageInput;
  return { input_tokens: Math.max(0, textInput) + Math.ceil(imageInput * IMAGE_INPUT_RATIO), output_tokens: u.output_tokens };
}

async function errorOf(res) {
  const body = await res.json().catch(() => null);
  const message = typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : null;
  noteProviderError("openai", res.status, `${body?.error?.code ?? ""} ${message ?? ""}`);
  if (body?.error?.code === "moderation_blocked" || /safety|moderation/i.test(message ?? "")) {
    return new ImageError("OpenAI's safety checks refused this picture. Describe it differently, or tell the owner it can't be made.");
  }
  if (res.status === 429) return new ImageError("OpenAI is getting too many picture requests right now. Tell the owner to try again in a minute.");
  if (res.status >= 500) return new ImageError("OpenAI couldn't make the picture right now. Tell the owner to try again shortly.");
  if (res.status === 401 || res.status === 403) {
    console.error(`OpenAI refused the image request (${res.status}): ${message}`);
    return new ImageError("Pictures can't be made on this server right now. Draw it as SVG instead, or tell the owner.");
  }
  return new ImageError(`OpenAI refused the picture request: ${message ?? `status ${res.status}`}.`);
}

/**
 * Makes one picture with the image `model`: `{ bytes, extension, mime, size, model }`. `transparent` makes a PNG
 * with a transparent background (for a cut-out or an icon), otherwise a WebP. `beginSpend()`
 * starts the request's Spend (credits.js); null means the account has nothing left. Throws
 * ImageError, with a message for Claude, when it can't be made or paid for.
 */
export async function generateImage({ model, prompt, shape = "landscape", quality = "medium", transparent = false, beginSpend, signal }) {
  if (!imagesAvailable() || !model) throw new ImageError("Pictures can't be made on this server (no OpenAI key). Draw it as SVG instead, or tell the owner.");
  const size = sizeFor(model, shape);
  const guess = estimate(model, size, quality, prompt);

  const spend = await beginSpend();
  if (!spend) throw new ImageError("The owner has no credits left, so the picture can't be made. Tell them to buy more credits.");
  if (!spend.reserve(guess.credits)) {
    await spend.finish();
    const { needed, balance } = spend.shortfall;
    throw new ImageError(
      `The owner doesn't have enough credits for this picture (it needs up to ${needed.toLocaleString("en")}, they have ${balance.toLocaleString("en")}). Offer a lower quality or smaller picture, or tell them to buy more credits.`,
    );
  }

  let usage = null;
  let answered = model;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        quality,
        ...(transparent ? { output_format: "png", background: "transparent" } : { output_format: "webp", output_compression: 85 }),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((err) => {
      if (signal?.aborted) throw err;
      throw new ImageError(err?.name === "TimeoutError" ? "OpenAI took too long to make the picture. Try a lower quality." : "Couldn't reach OpenAI to make the picture. Tell the owner to try again shortly.");
    });
    if (!res.ok) throw await errorOf(res);
    const reply = await res.json();
    // An image was made, so it's charged even if it can't be used.
    usage = usageOf(reply) ?? guess.usage;
    answered = typeof reply?.model === "string" ? reply.model : model;
    const data = reply?.data?.[0]?.b64_json;
    const bytes = typeof data === "string" ? Buffer.from(data, "base64") : null;
    const type = bytes && sniffImage(bytes);
    if (!type || !MIME[type]) throw new ImageError("OpenAI's reply had no picture in it. Try again.");
    return { bytes, extension: type, mime: MIME[type], size, model: answered };
  } finally {
    // Nothing is charged when no image was made (usage stays null).
    await spend.finish(usage ? { model: answered, usage } : {});
  }
}
