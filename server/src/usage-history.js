// The account's usage history as owners see it (/credits): each run (one job, assistant answer or
// site update) says which site and which part of it the work was for, and why, in plain words,
// with its credits and tokens merged. It never names a model or the company behind one: which AI
// did the work is the builder's business (admins see that on their own pages). No imports beyond
// the model catalogue: tests load this without a database or server settings.

import { IMAGE_MODELS } from "./ai-providers.js";


// Why the work was done, per command the site's scripts ran (kind "command").
const COMMAND_PURPOSES = {
  "page-edit": "Changing a page",
  "page-generate": "Writing a new page",
  "page-convert": "Bringing in a web page",
  "chrome-design": "Designing the header and footer",
  "md-edit": "Updating your site plan",
  "seo-claude": "Writing search text",
  schedule: "Writing planned posts",
  "site-build": "Building your site",
};

/** Why a run used credits, in plain words. */
export function usagePurpose({ kind, command = null }) {
  if (kind === "assistant") return "Answering your message";
  if (kind === "site-update") return "Updating your site to the latest version";
  if (kind === "publish-combine") return "Combining changes before publishing";
  if (kind === "setup") return command === "site-build" ? "Building your site" : "Planning your site";
  return (command && COMMAND_PURPOSES[command]) ?? "Working on your site";
}

const clip = (value, max = 120) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/**
 * What a command worked on, recorded with each of its requests (`target` on claudeUsage) so the
 * history can name the part of the site: the page (`file`, `title`, `address`), every page
 * (`all`), or the markdown file a plan edit changed. Null when the command names none.
 */
export function usageTarget(command, input, page = null) {
  if (command === "seo-claude" && input?.all === true) return { all: true };
  if (command === "md-edit") return clip(input?.file, 300) ? { file: clip(input.file, 300) } : null;
  if (!["page-edit", "page-generate", "page-convert", "seo-claude"].includes(command)) return null;
  const file = clip(input?.page, 300);
  if (!file) return null;
  return { file, title: clip(page?.title), address: clip(page?.address ?? page?.url, 300) };
}

/** A page's name from its file when nothing better was recorded: content/pages/about-us.md → "about-us". */
function slugOf(file) {
  const base = file.split("/").pop().replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  return base === "home" || base === "index" ? null : base;
}

/** A page as the history names it: "About us (/about/)", "Homepage", or "A page" for old records. */
function pageName(target) {
  if (!target?.file) return "A page";
  if (target.address === "/" || (!target.address && /\/(home|index)\.md$/.test(target.file))) return "Homepage";
  const name = target.title ?? slugOf(target.file) ?? "A page";
  return target.address && target.address !== name ? `${name} (${target.address})` : name;
}

const MD_FILES = { "scripts/site-tree.md": "Page plan", "scripts/scaffold-schedule.md": "Planned posts" };

/**
 * Which part of the site a run worked on, in plain words. `pictures` is how many of its requests
 * made a picture. Records from before `target` was recorded fall back to the part the command
 * always works on, or "A page".
 */
export function usagePart({ kind, command = null, target = null, pictures = 0 }) {
  const withPictures = (part) => (pictures > 0 ? `${part}, images` : part);
  if (kind === "assistant") return withPictures("Chat with the AI");
  if (kind === "site-update") return "Whole site";
  if (kind === "publish-combine") return "Changes waiting to be published";
  if (kind === "setup") return withPictures("Site setup");
  switch (command) {
    case "page-edit":
    case "page-generate":
    case "page-convert":
      return pageName(target);
    case "chrome-design":
      return "Header & footer";
    case "seo-claude":
      if (target?.all) return "Search text, all pages";
      return target?.file ? `Search text: ${pageName(target)}` : "Search text";
    case "md-edit":
      return MD_FILES[target?.file] ?? "Site plan";
    case "schedule":
      return "Planned posts";
    case "site-build":
      return withPictures("Site setup");
    default:
      return withPictures("Your site");
  }
}

const IMAGE_IDS = new Set(IMAGE_MODELS.map((m) => m.id));
const isPicture = (model) => typeof model === "string" && (IMAGE_IDS.has(model) || /^gpt-image-/.test(model));

/** A request's tokens in (what it read, cached or not) and out. */
const tokensIn = (r) => (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);

/**
 * One run as the owner's history shows it (`run` from usageRunsPipeline in db.js; `siteNames` maps
 * a site id to its name, null when the site was removed). Nothing in it names a model or provider.
 */
export function usageRunView({ _id, createdAt, startedAt, kind, command, target, requests }, siteNames = new Map()) {
  const pictures = requests.filter((r) => isPicture(r.model)).length;
  const siteId = requests.find((r) => r.siteId != null)?.siteId ?? null;
  return {
    id: String(_id),
    createdAt,
    startedAt,
    site: siteId == null ? null : { name: siteNames.get(siteId) ?? null },
    part: usagePart({ kind, command, target, pictures }),
    purpose: usagePurpose({ kind, command }),
    pictures,
    requests: requests.length,
    tokensIn: requests.reduce((sum, r) => sum + tokensIn(r), 0),
    tokensOut: requests.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
    // Charged when any request ran on the app's key; "own key" when every one ran on the account's.
    charged: requests.some((r) => r.charged === true),
    ownKey: requests.every((r) => r.charged === false),
    credits: requests.reduce((sum, r) => sum + (r.charged === true ? (r.credits ?? 0) : 0), 0),
  };
}

/**
 * The account's credits used, merged (`credits`) and split by purpose (`purposes`, largest first),
 * from usageByPurposePipeline's rows (one per kind and command).
 */
export function usageSummary(rows) {
  const purposes = new Map();
  for (const { _id, credits = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } of rows) {
    const purpose = usagePurpose({ kind: _id?.kind, command: _id?.command ?? null });
    const entry = purposes.get(purpose) ?? { purpose, credits: 0, tokensIn: 0, tokensOut: 0 };
    entry.credits += credits;
    entry.tokensIn += inputTokens + cacheReadTokens + cacheWriteTokens;
    entry.tokensOut += outputTokens;
    purposes.set(purpose, entry);
  }
  const list = [...purposes.values()].filter((p) => p.credits > 0 || p.tokensIn > 0 || p.tokensOut > 0).sort((a, b) => b.credits - a.credits);
  return { credits: list.reduce((sum, p) => sum + p.credits, 0), purposes: list };
}

