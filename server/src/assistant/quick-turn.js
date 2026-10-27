import { randomUUID } from "node:crypto";
import path from "node:path";
import { STARTER_TEXT, isDesigned } from "../next-steps.js";
import { getOverview, readText } from "../site-files.js";
import { workspaceDir } from "../workspace.js";
import { clausesOf, scoreClause, taskSize } from "../task-size.js";
import { runTool, toolInfo } from "./tools.js";

// A small change to one page ("remove the Meet the bakers section from the About page") needs no
// planning: the page editor gets the owner's own words. So when the rules in task-size.js call a
// message small and it names exactly one page (or the open page), the turn becomes an edit_page
// proposal straight away, with no model request at all, and the page editor's own model writes it.
// Anything less clear-cut (a question, another part of the site, site details, two possible pages,
// a page that's still the starter skeleton and needs designing first) returns null and the turn
// goes to Claude as usual. So does a reply to Claude's question (the route never asks here).

const TOOL = "edit_page";

// Questions want an answer, not a change.
const QUESTION = /^(?:what|why|how|where|when|which|who|whose|is|are|was|were|does|do|did|should|shall|would it|will it|have|has)\b/;

// Other parts of the site, which have tools of their own.
const ELSEWHERE =
  /\b(?:header|footer|menus?|navigation|nav bar|navbar|logo|favicon|publish\w*|go live|live site|search results?|seo|google|meta (?:title|description)|site ?plan|schedul\w*|stylesheets?|css|every page|all (?:the |my |our )?pages|other pages|whole (?:site|website)|site-?wide|each page|new page|another page|create (?:a |an )?page|add (?:a |an )?page|redirects?|blog posts?|undo|revert|restore)\b/;

// Facts kept in the site details, which pages show from there: changing them on one page would
// leave the rest of the site out of step, so Claude decides (update_site_details).
const SITE_DETAILS =
  /\b(?:e-?mail|phone|telephone|mobile number|whats ?app|instagram|facebook|linkedin|youtube|tiktok|twitter|social (?:media|links?|pages?)|tagline|slogan|testimonials?|reviews?|faq|frequently asked|opening hours|business hours|address|booking link)\b/;

// Changes that only take something out, move it or restyle one thing: safe on a page even when
// the thing is a site detail shown there ("remove the opening hours section").
const PAGE_ONLY_KINDS = new Set(["remove", "move", "tweak", "reminder", "constraint", "statement"]);

const HOMEPAGE = /\b(?:home ?page|front page|main page|landing page)\b/;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names a page may be called by in a message: its title, its slug, the end of its address. */
function namesOf(page) {
  const names = new Set();
  const add = (value) => {
    const name = String(value ?? "").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (name.length >= 3 && /[a-z]/.test(name)) names.add(name);
  };
  add(page.title);
  add(page.slug);
  add(page.url?.replace(/\.html$/, "").split("/").filter(Boolean).pop());
  return [...names];
}

/**
 * The page a message is about: the one it names ("the about page", "from the homepage"), or the
 * open page when it names none. Null when it can't tell for sure.
 */
export function pageOf(text, pages, openPage) {
  const message = text.toLowerCase();
  const strong = new Set();
  const weak = new Set();
  for (const page of pages) {
    if (page.url === "/" && HOMEPAGE.test(message)) strong.add(page.file);
    for (const name of namesOf(page)) {
      const at = new RegExp(`\\b${escape(name)}\\b(\\s+page\\b)?`).exec(message);
      if (!at) continue;
      (at[1] ? strong : weak).add(page.file);
    }
  }
  // Another page named as well, even loosely ("the Privacy Policy page" for a page titled Privacy):
  // the message may be about two pages, so Claude decides.
  if (strong.size === 1) return [...weak].every((file) => strong.has(file)) ? [...strong][0] : null;
  if (strong.size > 1) return null;
  if (!weak.size) return openPage ?? null;
  // A name that's also ordinary words ("our bakers") on the open page: it's the open page's part.
  if (openPage) return weak.size === 1 && weak.has(openPage) ? openPage : null;
  return weak.size === 1 ? [...weak][0] : null;
}

/** Whether a message is a small change to one page that needs no planning. */
export function isQuickEdit(text) {
  const message = text.toLowerCase().trim();
  if (!message || message.length > 600) return false;
  if (QUESTION.test(message) || ELSEWHERE.test(message)) return false;
  if (taskSize({ instruction: text }).size !== "small") return false;
  const clauses = clausesOf(text).map(scoreClause);
  // Deleting the page itself is delete_page's ("remove the about page").
  const removesPage = clauses.some((c) => c.kind === "remove" && /\bpages?\b/.test(c.clause) && !/\b(?:from|on|in|of) (?:the |our |my |this )?[\w' -]{0,40}\b(?:page|homepage)\b/.test(c.clause));
  if (removesPage) return false;
  if (SITE_DETAILS.test(message) && !clauses.every((c) => PAGE_ONLY_KINDS.has(c.kind))) return false;
  return true;
}

/** The card's line: the owner's own request, as a sentence. */
function summaryOf(text) {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 300);
  const sentence = line.charAt(0).toUpperCase() + line.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * The turn for a small one-page change, or null to let Claude take it. Fills `live` like runTurn
 * and resolves to runTurn's result shape. Makes no model request.
 */
export async function runQuickTurn({ key, text, openPage, autoApply = true, live, onUpdate = () => {} }) {
  if (!isQuickEdit(text)) return null;
  const overview = await getOverview(key);
  const pages = overview.collections.flatMap((c) => c.pages);
  const file = pageOf(text, pages, openPage);
  if (!file) return null;
  const page = pages.find((p) => p.file === file);
  // A page still holding the starter skeleton needs a whole design, not one change (next-steps.js's rule).
  const body = ((await readText(path.join(workspaceDir(key), file))) ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  if (!body || STARTER_TEXT.test(body) || (page?.url === "/" && !isDesigned(body))) return null;

  const summary = summaryOf(text);
  const instruction = `${text.trim()}\n\nChange only what this asks for, and keep everything else on the page exactly as it is. Whatever you change must look right and work on phones, tablets and computers.`;
  const outcome = await runTool(TOOL, { file, instruction, task_size: "small", summary }, key);
  if (outcome.error) return null;

  const info = toolInfo(TOOL);
  const action = {
    id: `quick_${randomUUID()}`,
    tool: TOOL,
    title: info.title,
    runs: info.runs,
    ...outcome.action,
    status: "proposed",
    result: null,
    reported: false,
    createdAt: new Date().toISOString(),
  };
  const where = page?.title ? `the ${page.title} page` : file;
  // Said the way it will happen: made now, or waiting for the owner's Apply.
  const reply = autoApply
    ? `Making that change to ${where} now. Nothing else on the page changes.`
    : `Here's that change to ${where}: press “Write it” to make it. Nothing else on the page changes.`;
  live.parts.push({ type: "text", text: reply }, { type: "action", id: action.id });
  live.actions.push(action);
  onUpdate();
  // The history Claude reads later: what was said and proposed, as plain text.
  const appended = [{ role: "assistant", content: [{ type: "text", text: `${reply}\n\n- Proposed (${action.title}) for ${file}: ${summary}` }] }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return { appended, actions: [action], usage, model: null, stopReason: "end_turn" };
}
