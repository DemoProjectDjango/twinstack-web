// Owners never see which AI models or companies do the work (only admins do): text the site's
// scripts print, such as a job's log ("Search text added by deepseek-flash"), goes through
// scrubModelNames before an owner gets it. Model ids and names come from the catalogues, so a model
// added there is covered; any other claude-*, deepseek-* or gpt-* id is caught by its shape.
// Pure: tests load it without a database or server settings.

import { FAST_MODELS, IMAGE_MODELS } from "./ai-providers.js";
import { CLAUDE_MODELS } from "./claude-models.js";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Everything that names a model or its maker, longest first so "Claude Opus 5.5" goes before "Claude".
const NAMES = [
  ...new Set([
    ...[...CLAUDE_MODELS, ...FAST_MODELS, ...IMAGE_MODELS].flatMap((m) => [m.id, m.name]),
    // Work-log summaries, and names that turn up in older scripts' messages.
    "claude-haiku-4-5",
    "Claude Haiku 4.5",
  ]),
].sort((a, b) => b.length - a.length);

const ID_SHAPE = String.raw`(?:claude|deepseek|gpt|chatgpt)-[a-z0-9][\w.-]*[a-z0-9]`;
const FAMILY = String.raw`(?:opus|sonnet|haiku|fable)(?:[ -]\d+(?:[.-]\d+)?)?`;
const VENDORS = String.raw`(?:anthropic|claude|deepseek|openai|chatgpt|gpt)`;

// A name, with "the", "a" or "an" before it taken in so "the Claude model" doesn't become "the the AI model".
const PATTERN = new RegExp(
  String.raw`(?:\b(the|a|an)\s+)?(?<![A-Za-z0-9])(?:${ID_SHAPE}|${NAMES.map(escape).join("|")}|${FAMILY}|${VENDORS})(?![A-Za-z0-9])`,
  "gi",
);

const capital = (text) => text[0].toUpperCase() + text.slice(1);

/** `text` with every model id, model name and AI company name replaced by "the AI". */
export function scrubModelNames(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(PATTERN, (match, article, offset, whole) => {
    const word = article ? match.replace(/^(the|a|an)\s+/i, "") : match;
    // Bare lower-case "sonnet", "haiku", "fable" or "opus" are ordinary words.
    if (/^(opus|sonnet|haiku|fable)$/i.test(word) && word[0] === word[0].toLowerCase()) return match;
    // Inside an UPPER_CASE name (ANTHROPIC_API_KEY): just "AI".
    if (!article && word === word.toUpperCase() && /[A-Z]/.test(word) && (whole[offset + match.length] === "_" || whole[offset - 1] === "_")) return "AI";
    const replacement = article ? (article.toLowerCase() === "the" ? "the AI" : "an AI") : "the AI";
    // A sentence's first word keeps its capital.
    const starts = article ? /^[A-Z]/.test(article) : offset === 0 || /(?:^|[.!?:]\s+|\n\s*|▸\s*)$/.test(whole.slice(Math.max(0, offset - 4), offset));
    return starts ? capital(replacement) : replacement;
  });
}

/**
 * A job as an owner gets it (serializeJob's view): the log and label with model and company names
 * scrubbed. While the job runs, a line still being written is held back until it ends, so a name
 * split between two polls is never sent half-scrubbed. Admins get the view as it is.
 */
export function publicJobView(view, { admin = false } = {}) {
  if (admin || !view) return view;
  let { output, next } = view;
  if (view.status === "running" && typeof output === "string") {
    const end = output.lastIndexOf("\n") + 1;
    next -= output.length - end;
    output = output.slice(0, end);
  }
  return { ...view, label: scrubModelNames(view.label), output: scrubModelNames(output), next };
}
