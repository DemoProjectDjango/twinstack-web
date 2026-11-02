import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeAccessError, beginSpend, claudeKeyFor } from "./credits.js";
import { anthropicClient } from "./assistant/turn.js";
import { saveBrand } from "./brand.js";
import { SETUP_FIRST_WEEK_MS, listSiteSetups, saveSiteSetup } from "./db.js";
import { readDataFile, writeDataFile } from "./site-files.js";
import { getStaticInfo, saveStaticInfo } from "./static-info.js";
import { WorkspaceError } from "./workspace.js";

// A new site's setup, asked in Create a new site before the site exists (the client's SetupFlow):
// - The site types (site-types/*.json) are our skills: guidance for a kind of business (the pages a
//   good site has, rules, sample content and the topics worth asking about), not a script.
// - After the owner's name, what they do and their brief, the analysis (planSetup) has Claude pick the
//   skill, read any web address the owner gave (or search for similar businesses), plan the pages
//   (each to create, update or keep, and whether to design the header and footer) and write the
//   questions for this business: at most MAX_QUESTIONS to ask now, a few more for later. The server
//   checks every question (field types, where answers are saved) and page. Without Claude, the skill's
//   own topics and pages make the plan (keywordPlan).
// - The answers are saved once the site exists (saveSetup): Business info (name, contact, social),
//   the brand, a "## Site profile" section of knowledge/notes.md that Claude reads before every
//   request, and the siteSetups record the admin's numbers and the monthly skill review read. The
//   same functions write the build request sent to Ask Claude, and the review's preview of it.

export const MAX_QUESTIONS = 5;
export const MIN_BRIEF_WORDS = 10;
// Sonnet: picking the skill, a look at the web and a plan is a light task, at half Opus's price.
const PLAN_MODEL = "claude-sonnet-5-5";
const PLAN_BETAS = ["server-side-fallback-2026-07-01"];
const MAX_SEARCHES = 3;
const MAX_FETCHES = 2;
const PLAN_TIMEOUT_MS = 150_000;
const FALLBACK_TYPE = "generic";
const TEMPLATE_SITE_NAME = "My Website";
const PROFILE_HEADING = "## Site profile";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const MAX_LATER = 3;
const MAX_FIELDS = 6;
const MAX_PAGES = 10;
const MAX_KNOWN = 8;
const FIELD_TYPES = ["choice", "multi", "yesno", "text", "tel", "email", "url", "textarea", "hours", "items", "logo", "photos"];
// Where an answer may be saved: the site details' fields by name, the logo, the photos, or the profile.
const SAVE_TO = [
  "profile",
  "contact.phone",
  "contact.email",
  "contact.address",
  "contact.hours",
  "contact.bookingUrl",
  "contact.bookingLabel",
  "contact.whatsapp",
  "social.instagram",
  "social.facebook",
  "social.linkedin",
  "social.x",
  "social.youtube",
  "brand.logo",
  "photos",
];
const PAGE_ACTIONS = ["update", "create", "keep"];

const TYPES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "site-types");
const SITE_TYPES = new Map(
  readdirSync(TYPES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(TYPES_DIR, f), "utf8")))
    .map((type) => [type.id, type]),
);
if (!SITE_TYPES.has(FALLBACK_TYPE)) throw new Error(`site-types/${FALLBACK_TYPE}.json is missing.`);

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;
const idOf = (value, fallback) => clean(value, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
const typeOf = (id) => {
  const type = SITE_TYPES.get(id);
  if (!type) throw new WorkspaceError("Unknown site type.", 400);
  return type;
};
const fieldsOfQuestions = (questions) => questions.flatMap((q) => q.fields);

/** The skills as the client needs them: their names and keywords, to read what the owner types. */
export function skillsCatalog() {
  return [...SITE_TYPES.values()].map(({ id, version, label, keywords, questions }) => ({
    id,
    version,
    label,
    keywords,
    // Only the hints, for "The AI understands" line: the questions themselves come from the analysis.
    hints: questions.flatMap((q) => q.fields.filter((f) => f.hints).map((f) => ({ label: f.label, multi: f.type === "multi", hints: f.hints }))),
  }));
}

/* ------------------------------------------------------------ checking what Claude wrote */

/** A question's field, checked: a known type, a place to save it that fits, sensible choices. Null when unusable. */
function checkField(raw, used) {
  if (!raw || typeof raw !== "object" || !FIELD_TYPES.includes(raw.type)) return null;
  const label = clean(raw.label, 90);
  if (!label) return null;
  let id = idOf(raw.id ?? label, "field");
  while (used.has(id)) id = `${id}-2`;
  used.add(id);
  let saveTo = SAVE_TO.includes(raw.saveTo) ? raw.saveTo : "profile";
  // The type decides where some answers can go.
  if (raw.type === "logo") saveTo = "brand.logo";
  else if (raw.type === "photos") saveTo = "photos";
  else if (saveTo === "brand.logo" || saveTo === "photos") saveTo = "profile";
  if (saveTo === "contact.hours" && raw.type !== "hours") saveTo = "profile";
  const field = { id, type: raw.type, label, saveTo };
  if (raw.type === "choice" || raw.type === "multi") {
    const choices = [...new Set((Array.isArray(raw.choices) ? raw.choices : []).map((c) => clean(c, 60)).filter(Boolean))].slice(0, 6);
    if (choices.length < 2) {
      if (raw.type === "multi") return null;
      Object.assign(field, { type: "text" });
    } else field.choices = choices;
    if (raw.type === "choice" && raw.other !== false) field.other = true;
  }
  if (raw.type === "items") {
    field.max = Math.min(Math.max(Number(raw.max) || 6, 1), 8);
    if (raw.noPrice === true) field.noPrice = true;
    if (clean(raw.itemLabel, 30)) field.itemLabel = clean(raw.itemLabel, 30);
    if (clean(raw.descLabel, 40)) field.descLabel = clean(raw.descLabel, 40);
  }
  if (clean(raw.hint, 200)) field.hint = clean(raw.hint, 200);
  if (clean(raw.placeholder, 80)) field.placeholder = clean(raw.placeholder, 80);
  return field;
}

/**
 * The questions, checked: at most maxAsk to ask (the first ones Claude marked ask, in its order)
 * and maxLater for later, each with 1 to MAX_FIELDS usable fields, ids unique throughout.
 */
export function checkQuestions(raw, { maxAsk = MAX_QUESTIONS, maxLater = MAX_LATER } = {}) {
  const used = new Set();
  const groups = new Set();
  const out = [];
  let asked = 0;
  let later = 0;
  for (const q of Array.isArray(raw) ? raw : []) {
    if (!q || typeof q !== "object") continue;
    const title = clean(q.title, 120);
    if (!title) continue;
    const fields = (Array.isArray(q.fields) ? q.fields : []).map((f) => checkField(f, used)).filter(Boolean).slice(0, MAX_FIELDS);
    if (!fields.length) continue;
    let status = q.status === "later" ? "later" : "ask";
    if (status === "ask" && asked >= maxAsk) status = "later";
    if (status === "later" && later >= maxLater) continue;
    if (status === "ask") asked++;
    else later++;
    let id = idOf(q.id ?? title, "question");
    while (groups.has(id)) id = `${id}-2`;
    groups.add(id);
    out.push({ id, title, lead: clean(q.lead, 240), why: clean(q.why, 200), status, fields });
  }
  // Asked ones first, as they're answered in that order.
  return [...out.filter((q) => q.status === "ask"), ...out.filter((q) => q.status === "later")];
}

/** A page's address on this site: "/" or "/<name>.html" (the pages collection's pattern). */
function pageAddress(raw) {
  const value = clean(raw, 80).toLowerCase();
  if (value === "/" || value === "/index.html") return "/";
  const name = value.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.html?$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return name ? `/${name}.html` : null;
}

/**
 * The page plan, checked: a homepage first, known actions, one entry per address, at most MAX_PAGES.
 * With the site's pages (`existing`), an action that doesn't fit them is corrected; without (a plan
 * coming back from the browser, already checked), the actions stand.
 */
export function checkPages(raw, existing = null) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p !== "object") continue;
    const address = pageAddress(p.address);
    const title = clean(p.title, 80);
    if (!address || !title || seen.has(address)) continue;
    seen.add(address);
    const exists = existing ? existing.some((e) => pageAddress(e.url) === address) : address === "/";
    let action = PAGE_ACTIONS.includes(p.action) ? p.action : exists ? "update" : "create";
    // A page that's there can't be created again, and one that isn't can't be kept or updated.
    if (existing && exists && action === "create") action = "update";
    if (existing && !exists && action !== "create") action = address === "/" ? "update" : "create";
    out.push({ title, address, action, purpose: clean(p.purpose, 240) });
    if (out.length >= MAX_PAGES) break;
  }
  if (!out.some((p) => p.address === "/")) out.unshift({ title: "Home", address: "/", action: "update", purpose: "What the business does, why to choose it and what to do next." });
  return [...out.filter((p) => p.address === "/"), ...out.filter((p) => p.address !== "/")];
}

function checkKnown(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((k) => ({ label: clean(k?.label, 60), value: clean(k?.value, 200) }))
    .filter((k) => k.label && k.value)
    .slice(0, MAX_KNOWN);
}

function checkFindings(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((f) => ({ text: clean(f?.text, 240), changes: clean(f?.changes, 80) }))
    .filter((f) => f.text)
    .slice(0, 5);
}

/** A field's value, cleaned for its type, or undefined when it isn't usable. */
function cleanValue(field, value) {
  switch (field.type) {
    case "choice": {
      const v = clean(value, 120);
      if (!v) return undefined;
      return field.choices?.includes(v) || field.other ? v : undefined;
    }
    case "multi":
      return Array.isArray(value) ? [...new Set(value.filter((v) => field.choices?.includes(v)))] : undefined;
    case "yesno":
      return value === "Yes" || value === "No" ? value : undefined;
    case "text":
    case "tel":
    case "email":
      return clean(value, 200) || undefined;
    case "url": {
      const v = clean(value, 300);
      return /^https?:\/\/\S+$/i.test(v) ? v : undefined;
    }
    case "textarea":
      return clean(value, 1500) || undefined;
    case "hours":
      return Array.isArray(value) && value.length === 7
        ? value.map((h, i) => ({ day: DAYS[i], open: TIME.test(h?.open) ? h.open : "09:00", close: TIME.test(h?.close) ? h.close : "17:00", closed: Boolean(h?.closed) }))
        : undefined;
    case "items": {
      if (!Array.isArray(value)) return undefined;
      const items = value
        .map((i) => ({ name: clean(i?.name, 80), desc: clean(i?.desc, 160), price: field.noPrice ? "" : clean(i?.price, 30), sample: Boolean(i?.sample) }))
        .filter((i) => i.name)
        .slice(0, field.max ?? 6);
      return items.length ? items : undefined;
    }
    case "logo":
      return typeof value === "string" && /^\/assets\/img\/[\w./-]+$/.test(value) && !value.split("/").includes("..") ? value : undefined;
    case "photos":
      return Array.isArray(value) ? value.filter((p) => typeof p === "string" && /^\/assets\/img\/[\w./-]+$/.test(p) && !p.split("/").includes("..")).slice(0, 6) : undefined;
    default:
      return undefined;
  }
}

/** Answers the owner's words already give, for the fields that may be filled in that way. */
function cleanPrefill(raw, questions) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const field of fieldsOfQuestions(questions)) {
    // Contact details, links, hours and pictures only ever come from the owner's own typing; the
    // booking button's words (a choice) may be filled in.
    if (!["choice", "multi", "yesno", "text", "textarea", "items"].includes(field.type)) continue;
    if (field.saveTo.startsWith("contact.") && field.type !== "choice") continue;
    const v = cleanValue(field, raw[field.id]);
    if (v !== undefined && !(Array.isArray(v) && !v.length)) out[field.id] = v;
  }
  return out;
}

/* ------------------------------------------------------------ the analysis */

function ownerText({ name, what, brief }) {
  return [name, what, brief].map((t) => clean(t, 1500)).filter(Boolean).join("\n");
}

/** The skill whose keywords the text has most, with the words that matched. */
function keywordType(text) {
  const found = new Set(text.toLowerCase().match(/[\p{L}']+/gu) ?? []);
  let best = { type: SITE_TYPES.get(FALLBACK_TYPE), hits: [] };
  for (const type of SITE_TYPES.values()) {
    const hits = type.keywords.filter((k) => found.has(k));
    if (hits.length > best.hits.length) best = { type, hits };
  }
  return best;
}

/** Answers the text gives away, from the skill fields' hints. */
function hintedAnswers(type, text) {
  const lower = ` ${text.toLowerCase()} `;
  const answers = {};
  for (const field of type.questions.flatMap((q) => q.fields)) {
    if (!field.hints) continue;
    const matched = Object.entries(field.hints)
      .filter(([, list]) => list.some((w) => lower.includes(w.toLowerCase())))
      .map(([choice]) => choice);
    if (matched.length) answers[field.id] = field.type === "multi" ? matched : matched[0];
  }
  return answers;
}

/** The plan without Claude: the skill's topics as the questions, its pages as the plan. */
function keywordPlan(type, text, existing) {
  const lower = text.toLowerCase();
  const needed = type.questions.filter((q) => q.always || (q.when ?? []).some((w) => lower.includes(w)));
  const questions = checkQuestions(needed.map((q, i) => ({ ...q, status: i < MAX_QUESTIONS ? "ask" : "later" })));
  const prefill = cleanPrefill(hintedAnswers(type, text), questions);
  const pages = checkPages(type.pages.map((p) => ({ ...p, action: p.address === "/" ? "update" : "create" })), existing);
  const known = questions
    .flatMap((q) => q.fields)
    .filter((f) => prefill[f.id] !== undefined)
    .map((f) => ({ label: f.label.replace(/ \(.*\)$/, "").replace(/\?$/, ""), value: Array.isArray(prefill[f.id]) ? prefill[f.id].join(", ") : String(prefill[f.id]) }));
  return { questions, prefill, pages, known: checkKnown(known), chrome: "design" };
}

const PLAN_SYSTEM = `You plan a new website for a small business owner who isn't technical, and write the few questions we still need to ask them. You get what the owner wrote, the site's current pages, and our skills: guidance for kinds of business (the pages a good site has, rules, and topics worth asking about). Skills are guidance, not a script: plan and ask for this business.

1. Pick the skill closest to the business, or "generic".
2. Look before you plan. When the owner gives a web address, fetch it (at most ${MAX_FETCHES} fetches) and use what's there: its pages, sections, wording and facts. When they want that site copied or rebuilt, plan its pages and ask only what you can't take from it. Otherwise search the web once or twice (at most ${MAX_SEARCHES} searches) for what websites of similar businesses show and what their customers look for, using the skill's research note and any place, product or specialty the owner names. Skip both only when the owner told us almost nothing.
3. Plan the pages (at most ${MAX_PAGES}): every page this site should have, from the skill's pages adapted to this business and what you found. action: "update" for a current page to rewrite (always the starter homepage), "keep" for a current page to leave as it is, "create" for a new page. Addresses: "/" for the homepage, otherwise "/<name>.html" in lowercase with dashes. Say each page's purpose in one sentence.
4. Header and footer: "design" (new ones that match the homepage), or "keep" when the owner wants them left.
5. Questions: at most ${MAX_QUESTIONS} groups with status "ask", most important first, and up to ${MAX_LATER} with status "later" (Claude asks those in the editor). Each group is a short title (a plain question), a one-sentence lead, a short why for the owner, and 1 to ${MAX_FIELDS} fields. Ask only what changes the website and only the owner can tell; never what they already told you or what you found. Specific to this business: not "What do you offer?" for a bakery but "Which cakes and breads should the homepage show?".
   Field types: choice (one of 2-6 short choices in the owner's voice; other: true lets them type their own), multi (any of 2-6 choices), yesno, text, tel, email, url, textarea, hours (opening hours by day), items (a list of name, short description and price: products, services, dishes, team; noPrice: true when prices don't fit; itemLabel names one, like "Dish"), logo, photos.
   saveTo: "profile" (preferences and facts for the writer), or the site detail it is: contact.phone, contact.email, contact.address, contact.hours (an hours field), contact.bookingUrl, contact.bookingLabel (the main button's words), contact.whatsapp, social.instagram, social.facebook, social.linkedin, social.x, social.youtube. A logo field saves to brand.logo and a photos field to photos.
6. known: what you already know from their words or the site you fetched, as short label and value pairs (at most ${MAX_KNOWN}).
7. prefill: field id to value for fields their words already answer. Never invent contact details, prices, names, dates or reviews.

Reply with one JSON object and nothing else:
{"type": "<skill id>", "confidence": "sure" | "likely" | "not sure", "evidence": ["<up to 6 of the owner's words that decided it>"], "findings": [{"text": "<one sentence about what you found>", "changes": "<what it changes in the plan, in a few words>"}], "known": [{"label": "...", "value": "..."}], "pages": [{"title": "...", "address": "/...", "action": "update" | "create" | "keep", "purpose": "..."}], "chrome": "design" | "keep", "questions": [{"id": "...", "title": "...", "lead": "...", "why": "...", "status": "ask" | "later", "fields": [{"id": "...", "type": "...", "label": "...", "choices": ["..."], "other": true, "saveTo": "...", "hint": "..."}]}], "prefill": {"<field id>": <value>}}
At most 5 findings, each from what you read or found; [] when you didn't look.`;

function describeSkills() {
  return JSON.stringify(
    [...SITE_TYPES.values()].map((t) => ({
      id: t.id,
      label: t.label,
      recognise: t.recognise,
      research: t.research,
      pages: t.pages.map((p) => `${p.title} (${p.address}): ${p.purpose}`),
      rules: t.rules,
      topics: t.questions.map((q) => `${q.title}: ${q.fields.map((f) => f.label.replace(/ \(.*\)$/, "")).join(", ")}${q.when ? " (only when the owner mentions it)" : ""}`),
    })),
  );
}

/** The JSON object in Claude's last words (after any searches or fetches). */
function parseReply(message) {
  const blocks = message.content;
  const lastTool = blocks.findLastIndex((b) => /_tool_result$/.test(b.type) || b.type === "server_tool_use");
  const text = blocks
    .slice(lastTool + 1)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Asks Claude; null when it isn't available (no credits) or its reply is unusable. */
async function planWithClaude({ userId, siteId, text, existing }) {
  let claude;
  try {
    claude = await claudeKeyFor(userId);
  } catch (err) {
    if (err instanceof ClaudeAccessError) return null;
    throw err;
  }
  const client = anthropicClient(claude.apiKey);
  const runId = randomUUID();
  const current = existing.map((p) => `${p.url} ${p.title}${p.starter ? " (the starter page, not written yet)" : ""}`).join("\n");
  const messages = [{ role: "user", content: `OUR SKILLS:\n${describeSkills()}\n\nTHE SITE'S CURRENT PAGES:\n${current || "/ Home (the starter page, not written yet)"}\n\nTHE OWNER WROTE:\n${text}` }];
  let message = null;
  let searched = 0;
  let fetched = 0;
  // A server-tool turn can pause (pause_turn); it's sent back as it is to continue.
  for (let round = 0; round < 3; round++) {
    const spend = await beginSpend({ userId, siteId, runId, kind: "setup", charged: claude.charged });
    if (!spend) return null;
    const params = {
      model: PLAN_MODEL,
      max_tokens: 12000,
      system: PLAN_SYSTEM,
      messages,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_FETCHES },
      ],
      output_config: { effort: "low" },
      fallbacks: "default",
      betas: PLAN_BETAS,
    };
    params.max_tokens = spend.maxTokens(params.max_tokens, params);
    try {
      if (!params.max_tokens) return null;
      message = await client.beta.messages.create(params, { timeout: PLAN_TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError)) throw err;
      console.error("Couldn't plan the site setup with Claude, so the skill does it:", err.message);
      return null;
    } finally {
      await spend.finish(message ? { model: message.model, usage: message.usage } : {});
    }
    searched += message.usage?.server_tool_use?.web_search_requests ?? 0;
    fetched += message.usage?.server_tool_use?.web_fetch_requests ?? 0;
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }
  if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") return null;
  const reply = parseReply(message);
  return reply && SITE_TYPES.has(reply.type) ? { ...reply, searched, fetched } : null;
}

/**
 * The analysis after the owner's name, what they do and their brief (any may be empty: skipped).
 * `existing` is the site's current pages ({ url, title, starter }), the starter homepage for a new
 * site. Resolves to the skill, the words that decided it, what Claude read or found, what it knows
 * already, the page plan, whether to design the header and footer, the questions and prefilled answers.
 */
export async function planSetup({ userId, siteId = null, name, what, brief, existing = [{ url: "/", title: "Home", starter: true }] }) {
  const owner = { name: clean(name, 100), what: clean(what, 600), brief: clean(brief, 1500) };
  // A brief may be a web address to work from ("Rebuild https://…") rather than ten words.
  if (owner.brief && words(owner.brief) < MIN_BRIEF_WORDS && !/https?:\/\/\S+|www\.\S+\.\S+/i.test(owner.brief)) {
    throw new WorkspaceError(`Write at least ${MIN_BRIEF_WORDS} words about your website, or a web address, or skip it.`, 400);
  }
  const text = ownerText(owner);
  const keywords = keywordType(text);
  const claude = owner.what || owner.brief ? await planWithClaude({ userId, siteId, text, existing }).catch((err) => (console.error("The setup analysis failed:", err), null)) : null;

  const type = claude ? SITE_TYPES.get(claude.type) : keywords.type;
  const fallback = keywordPlan(type, text, existing);
  const questions = claude ? checkQuestions(claude.questions) : fallback.questions;
  // Claude's plan, or the skill's where Claude gave none that's usable.
  const usable = claude && questions.length ? questions : fallback.questions;
  const pages = claude && Array.isArray(claude.pages) && claude.pages.length ? checkPages(claude.pages, existing) : fallback.pages;
  return {
    type: type.id,
    label: type.label,
    version: type.version,
    by: claude ? "claude" : "keywords",
    confidence: claude ? (["sure", "likely", "not sure"].includes(claude.confidence) ? claude.confidence : "likely") : keywords.hits.length >= 3 ? "sure" : keywords.hits.length ? "likely" : "not sure",
    evidence: claude ? (Array.isArray(claude.evidence) ? claude.evidence.map((e) => clean(e, 60)).filter(Boolean).slice(0, 6) : []) : keywords.hits.slice(0, 6),
    searched: claude?.searched ?? 0,
    fetched: claude?.fetched ?? 0,
    findings: claude ? checkFindings(claude.findings) : [],
    known: claude ? checkKnown(claude.known) : fallback.known,
    pages,
    chrome: claude?.chrome === "keep" ? "keep" : "design",
    questions: usable,
    prefill: claude && usable === questions ? cleanPrefill(claude.prefill, usable) : fallback.prefill,
  };
}

/* ------------------------------------------------------------ what's saved */

/** Opening hours as one line: "Mon closed, Tue–Sun 12:00–23:00". */
export function hoursText(hours) {
  const groups = [];
  for (const h of hours) {
    const key = h.closed ? "closed" : `${h.open}–${h.close}`;
    const last = groups.at(-1);
    if (last && last.key === key) last.days.push(h.day);
    else groups.push({ key, days: [h.day] });
  }
  return groups.map((g) => `${g.days.length > 1 ? `${g.days[0]}–${g.days.at(-1)}` : g.days[0]} ${g.key}`).join(", ");
}

function asText(field, value) {
  if (field.type === "hours") return hoursText(value);
  if (field.type === "items") return value.map((i) => `${i.name}${i.desc ? ` (${i.desc})` : ""}${i.price ? `, ${i.price}` : ""}${i.sample ? " [sample]" : ""}`).join("; ");
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

const shortLabel = (label) => label.replace(/ \((optional|pick any)\)$/, "").replace(/\?$/, "");

/**
 * Everything a setup's body says, checked: the skill, the owner's words, the questions (checked
 * again: they came from the browser) and their answers, the skipped ones, the page plan, what the
 * analysis knew and found.
 */
function readBody(body) {
  const type = typeOf(body?.type);
  // The statuses the owner ended with: "ask" for those answered now, "later" for the rest.
  const questions = checkQuestions(
    (Array.isArray(body?.questions) ? body.questions : []).map((q) => ({ ...q, status: q?.status === "later" ? "later" : "ask" })),
    // The owner may have answered later ones too (Answer it now): every question they saw counts.
    { maxAsk: 8, maxLater: 8 },
  );
  const answers = {};
  for (const field of fieldsOfQuestions(questions)) {
    const v = cleanValue(field, body?.answers?.[field.id]);
    if (v !== undefined && !(Array.isArray(v) && !v.length)) answers[field.id] = v;
  }
  const ids = new Set(questions.map((q) => q.id));
  return {
    type,
    by: body?.by === "claude" ? "claude" : "keywords",
    name: clean(body?.name, 100),
    what: clean(body?.what, 600),
    brief: clean(body?.brief, 1500),
    questions,
    answers,
    skipped: (Array.isArray(body?.skipped) ? body.skipped : []).filter((id) => ids.has(id)),
    pages: checkPages(body?.pages),
    chrome: body?.chrome === "keep" ? "keep" : "design",
    known: checkKnown(body?.known),
    findings: checkFindings(body?.findings),
  };
}

/** The questions left for Claude to ask in the editor: skipped, and those planned for later. */
function laterQuestions(setup) {
  return setup.questions.filter((q) => q.status === "later" || setup.skipped.includes(q.id));
}

/** The site details the answers change: contact and social fields by name. */
function configChanges(setup) {
  const contact = {};
  const social = {};
  for (const field of fieldsOfQuestions(setup.questions)) {
    const value = setup.answers[field.id];
    if (value === undefined) continue;
    const [where, key] = field.saveTo.split(".");
    if (where === "contact") contact[key] = field.type === "hours" ? hoursText(value) : String(value);
    if (where === "social") social[key] = String(value);
  }
  return { contact, social };
}

const ACTION_WORDS = { update: "rewrite", create: "create", keep: "keep as it is" };

function profileText(setup) {
  const lines = [PROFILE_HEADING, "", "<!-- Written by the setup questions. Change anything here and Claude follows it from then on. -->", `- Kind of website: ${setup.type.label}`];
  for (const k of setup.known) lines.push(`- ${k.label}: ${k.value}`);
  for (const field of fieldsOfQuestions(setup.questions)) {
    const value = setup.answers[field.id];
    if (value === undefined || field.saveTo !== "profile") continue;
    lines.push(`- ${shortLabel(field.label)}: ${asText(field, value)}`);
  }
  lines.push(`- Pages: ${setup.pages.map((p) => `${p.title} (${p.address})`).join(", ")}`);
  const later = laterQuestions(setup);
  if (later.length) lines.push(`- Still to ask me: ${later.map((q) => q.title).join("; ")}`);
  if (setup.findings.length) lines.push(`- Found when planning: ${setup.findings.map((f) => f.text).join(" ")}`);
  return lines.join("\n");
}

/**
 * The request sent to Ask Claude once the answers are saved. `hasHome` and `chrome` say what the
 * site can do (a homepage to design rather than make; header and footer design), `fresh` that it
 * has only its starter homepage.
 */
function buildRequest(setup, { hasHome = false, chrome = true, fresh = true, photos = [] } = {}) {
  const { type } = setup;
  const name = setup.name || TEMPLATE_SITE_NAME;
  const later = laterQuestions(setup);
  const home = setup.pages.find((p) => p.address === "/");
  const create = setup.pages.filter((p) => p.address !== "/" && p.action === "create");
  const update = setup.pages.filter((p) => p.address !== "/" && p.action === "update");
  const slug = (address) => address.replace(/^\//, "").replace(/\.html$/, "");
  // The steps that apply, numbered in order.
  const steps = [
    home?.action !== "keep" && `${hasHome ? "Design my homepage with edit_page" : "Create my homepage (create_page, type homepage) and design it"}, so a first-time visitor understands straight away what we do, why to choose us and what to do next.`,
    setup.chrome === "design" && chrome && "Design the header and footer to match it (design_header_and_footer).",
    create.length && `Make each new page with create_page, one per page, each with a complete brief (its purpose, my facts, the homepage's look), so it's written as it's made: ${create.map((p) => `${p.title} (slug ${slug(p.address)})`).join(", ")}. If a page's file already exists, write it with edit_page instead. Don't change the site plan or use create_missing_pages.`,
    update.length && `Rewrite these pages with edit_page: ${update.map((p) => p.title).join(", ")}.`,
    "Put the pages in the menu.",
  ]
    .filter(Boolean)
    .map((step, i) => `${i + 1}. ${step}`);
  const lines = [
    `Set up my new site for ${name}.`,
    setup.what && `What we do: ${setup.what}`,
    setup.brief && `My brief for the website: ${setup.brief}`,
    `Kind of website: ${type.label}.`,
    "The plan we agreed (follow it, page by page):",
    ...setup.pages.map((p) => `- ${p.title} (${p.address}), ${ACTION_WORDS[p.action]}: ${p.purpose}`),
    `- Header and footer: ${setup.chrome === "design" && chrome ? "design new ones that match the homepage" : "keep the current ones"}.`,
    "Do it in this order:",
    ...steps,
    photos.length && `Use these photos of ours: ${photos.join(", ")}.`,
    fresh && "The site is brand new: the homepage is the starter page and there are no other pages yet, so there's no need to look around before starting.",
    "Keep the design clean and focused: my real words and facts, clear sections, readable type and plenty of space. No filler text and no heavy decorative patterns; where there are no photos, let typography, colour and simple icons carry it.",
    "Rules:",
    ...type.rules.map((r) => `- ${r}`),
    type.demo?.note && `Sample content: ${type.demo.note} Anything marked [sample] in my site profile is an example too.`,
    setup.findings.length && `What you found when planning: ${setup.findings.map((f) => f.text).join(" ")}`,
    "My setup answers are in the site profile of my notes, and my contact details are in the site details.",
    later.length ? `Ask me later, one at a time, about: ${later.map((q) => q.title.replace(/\?$/, "").toLowerCase()).join("; ")}. Don't ask anything else I've already answered.` : "Only ask me about something essential that's still missing.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** What the review step shows: the site details, the site profile and the build request. */
export function previewSetup(body) {
  const setup = readBody(body);
  const { contact, social } = configChanges(setup);
  return {
    config: { name: setup.name || TEMPLATE_SITE_NAME, description: setup.what, contact, social },
    profile: profileText(setup),
    request: buildRequest(setup, { hasHome: true, photos: setup.answers.photos ?? [] }),
  };
}

/** Replaces the notes' site profile section (from its heading to the next "## " heading), or adds it. */
function withProfile(notes, profile) {
  const start = notes.indexOf(PROFILE_HEADING);
  if (start < 0) return `${notes.trimEnd()}\n\n${profile}\n`;
  const rest = notes.slice(start + PROFILE_HEADING.length);
  const next = rest.search(/\n## /);
  const after = next < 0 ? "" : rest.slice(next);
  return `${notes.slice(0, start)}${profile}\n${after}`.replace(/\n{3,}/g, "\n\n");
}

/**
 * Saves a setup into the site: Business info (name, what it does, contact details, social links),
 * the header's name and logo, the notes' site profile and the setup record. Returns the build
 * request for Ask Claude. `options` says what the site already has (buildRequest).
 */
export async function saveSetup({ key, siteId, body, options = {} }) {
  const setup = readBody(body);
  const { contact, social } = configChanges(setup);

  const { sections } = await getStaticInfo(key);
  const site = sections.find((s) => s.id === "site");
  if (site?.data && typeof site.data === "object") {
    const data = { ...site.data };
    const oldName = typeof data.name === "string" ? data.name : "";
    if (setup.name) {
      data.name = setup.name;
      if ("shortName" in data && (!data.shortName || data.shortName === oldName || data.shortName === TEMPLATE_SITE_NAME)) data.shortName = setup.name;
    }
    // What makes the setup count as answered (the client's FirstRunSetup), so always written.
    data.description = setup.what || data.description || "";
    if (data.contact && typeof data.contact === "object") data.contact = { ...data.contact, ...Object.fromEntries(Object.entries(contact).filter(([k]) => k in data.contact)) };
    if (data.social && typeof data.social === "object") data.social = { ...data.social, ...Object.fromEntries(Object.entries(social).filter(([k]) => k in data.social)) };
    await saveStaticInfo(key, "site", data);
  }

  const brand = {};
  if (setup.name) brand.logoText = setup.name;
  const logoField = fieldsOfQuestions(setup.questions).find((f) => f.type === "logo");
  if (logoField && setup.answers[logoField.id]) brand.logo = setup.answers[logoField.id];
  if (Object.keys(brand).length) await saveBrand(key, brand).catch((err) => console.error(`Couldn't save the setup's logo in ${key}:`, err.message));

  const { content } = await readDataFile(key, "knowledge-notes");
  await writeDataFile(key, "knowledge-notes", withProfile(content || "# Notes for Claude\n", profileText(setup)));

  if (typeof siteId === "number") {
    await saveSiteSetup(siteId, {
      type: setup.type.id,
      version: setup.type.version,
      by: setup.by,
      brief: setup.brief,
      questions: setup.questions.map((q) => ({ title: q.title, status: q.status, skipped: setup.skipped.includes(q.id) })),
      pages: setup.pages.map(({ address, action }) => ({ address, action })),
      skipped: setup.skipped,
      findings: setup.findings.length,
      // Typed rather than picked: what the monthly review learns new answer buttons from.
      answers: fieldsOfQuestions(setup.questions)
        .filter((f) => setup.answers[f.id] !== undefined && ["choice", "multi", "yesno"].includes(f.type))
        .map((f) => {
          const value = setup.answers[f.id];
          return { label: f.label, answer: Array.isArray(value) ? value.join(", ") : value, custom: f.type === "choice" && !f.choices?.includes(value), profile: f.saveTo === "profile" };
        }),
    }).catch((err) => console.error(`Couldn't record the setup of site ${siteId}:`, err.message));
  }
  const photosField = fieldsOfQuestions(setup.questions).find((f) => f.type === "photos");
  return { request: buildRequest(setup, { ...options, photos: (photosField && setup.answers[photosField.id]) || [] }) };
}

/* ------------------------------------------------------------ the admin's numbers */

const MAX_TYPED = 5;
const MAX_LISTED = 15;
const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The admin's Site setup screen: for each site type, how many sites were set up in the last `days`,
 * the questions the AI asked most (asked now, skipped, left for later), how the choices were answered
 * (picked or typed, with a few typed answers), the pages it planned most, and what happened in each
 * site's first week. First-week averages count only sites whose first week is over.
 */
export async function setupStats({ days = 90 } = {}) {
  const now = Date.now();
  const docs = await listSiteSetups(new Date(now - days * 24 * 60 * 60 * 1000));
  const types = [...SITE_TYPES.values()].map((type) => {
    const setups = docs.filter((d) => d.type === type.id);
    const weekOver = setups.filter((d) => now - d.savedAt.getTime() >= SETUP_FIRST_WEEK_MS);
    const signal = (name) => average(weekOver.map((d) => d.signals?.[name] ?? 0));
    const published = setups.filter((d) => d.publishedAt);

    const questions = new Map();
    for (const d of setups) {
      for (const q of d.questions ?? []) {
        const k = q.title.toLowerCase();
        const row = questions.get(k) ?? { title: q.title, asked: 0, skipped: 0, later: 0 };
        if (q.status === "ask") row.asked++;
        else row.later++;
        if (q.skipped) row.skipped++;
        questions.set(k, row);
      }
    }
    const answers = new Map();
    for (const d of setups) {
      for (const a of d.answers ?? []) {
        if (!a.label) continue;
        const k = a.label.toLowerCase();
        const row = answers.get(k) ?? { label: a.label, answered: 0, typed: 0, picked: {}, examples: [] };
        row.answered++;
        if (a.custom) {
          row.typed++;
          if (a.profile && a.answer && row.examples.length < MAX_TYPED) row.examples.push(a.answer);
        } else for (const choice of String(a.answer).split(", ")) row.picked[choice] = (row.picked[choice] ?? 0) + 1;
        answers.set(k, row);
      }
    }
    const pages = new Map();
    for (const d of setups) for (const p of d.pages ?? []) pages.set(p.address, (pages.get(p.address) ?? 0) + 1);

    return {
      id: type.id,
      label: type.label,
      version: type.version,
      sites: setups.length,
      pickedByClaude: setups.filter((d) => d.by === "claude").length,
      versions: Object.fromEntries([...new Set(setups.map((d) => d.version))].map((v) => [v, setups.filter((d) => d.version === v).length])),
      firstWeek: {
        sites: weekOver.length,
        messages: signal("messages"),
        commands: signal("commands"),
        discards: signal("discards"),
        publishedInWeek: weekOver.filter((d) => d.publishedAt && d.publishedAt.getTime() - d.savedAt.getTime() < SETUP_FIRST_WEEK_MS).length,
      },
      published: published.length,
      medianHoursToPublish: median(published.map((d) => (d.publishedAt.getTime() - d.savedAt.getTime()) / 3_600_000)),
      questions: [...questions.values()].sort((a, b) => b.asked + b.later - (a.asked + a.later)).slice(0, MAX_LISTED),
      answers: [...answers.values()].sort((a, b) => b.answered - a.answered).slice(0, MAX_LISTED),
      pages: [...pages.entries()].map(([address, count]) => ({ address, count })).sort((a, b) => b.count - a.count).slice(0, MAX_LISTED),
    };
  });
  return { days, total: docs.length, types };
}
