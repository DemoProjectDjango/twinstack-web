// The site agent's rules, with no server state, database or network (site-agent.js uses them; the
// tests in server/test/ check them): what a published site's widget may send, how a visitor's
// session takes it in, when a suggestion is due (cheap triggers, no AI), which addresses a reply may
// send visitors to, and the owner's settings as they may be saved. Keep the event fields in step
// with the template's assets/js/agent.js.
//
// A batch the widget posts (text/plain JSON, at most MAX_BATCH_BYTES):
//   { s: session id, p: the page's path, w: window width, dnt: true when the visitor asked not to
//     be tracked (then only questions come), e: [event…] }
// Events (at most MAX_EVENTS):
//   { k: "v", p, r?: outside referrer host }          a page view
//   { k: "h", l: label, u?: link, x: kind, d: ms }    the pointer rested on a link, button or section
//   { k: "c", l: label, u?: link, x: kind }           a click on one
//   { k: "s", d: 0–100 }                              the deepest the page was scrolled, in percent
//   { k: "t", d: seconds }                            time on the page so far
//   { k: "x" }                                        the pointer left the window at the top (leaving)
// `x` is "link", "button" or "section"; `u` is the link's address on the site ("/donate.html"),
// "ext:<host>" for another site, or "tel"/"mail" (never the number or address itself).

export const MAX_BATCH_BYTES = 8 * 1024;
export const MAX_SMALL_BYTES = 2 * 1024;
export const MAX_EVENTS = 60;
export const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;
// A returning visitor's id (agent.js keeps it on their device only once they said yes).
export const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;
// How long a returning visitor is remembered after their last visit (agent.js's own copy too).
export const REMEMBER_DAYS = 30;
export const KEY = /^[A-Za-z0-9_-]{16,64}$/;

// When a suggestion may be made, per visitor session.
export const LIMITS = Object.freeze({
  suggestionsPerSession: 5,
  // Things the visitor's memory keeps across the visit (topInterests).
  interests: 30,
  // Between two suggestions.
  cooldownMs: 25_000,
  // Nothing in the first seconds of a visit.
  quietStartMs: 5_000,
  questionsPerSession: 8,
  questionGapMs: 4_000,
  // Visitors' typed questions, in characters.
  questionChars: 300,
  // Pages kept per session.
  pagesPerSession: 50,
});

// What the triggers look for.
export const TRIGGERS = Object.freeze({
  // Resting on something that leads to one of the owner's goals this long (ms, added up on the page).
  goalHoverMs: 1_500,
  // Resting on a link to another of the site's pages (not a goal) this long.
  linkHoverMs: 2_500,
  // The same thing clicked this many times on one page without going anywhere.
  repeatClicks: 3,
  // A visitor about to leave who has been on the site at least this long.
  leavingAfterMs: 10_000,
  // This many different pages seen without reaching a goal's page.
  browsingPages: 3,
  // Reading one page this long (seconds) and this far down (percent).
  readingSeconds: 40,
  readingScroll: 50,
});

/**
 * How eager the agent is (the owner's choice): how long a rest counts, the gap between
 * suggestions and how many a visit. `balanced` is TRIGGERS and LIMITS. `checkpoints` are when
 * agent.js reports a rest while the pointer is still on the thing (sent to it with every reply):
 * one about DRAFT_LEAD_MS (site-agent.js) before each rest counts, and each rest itself.
 */
export const PACES = Object.freeze({
  gentle: Object.freeze({ goalHoverMs: 2_500, linkHoverMs: 4_000, cooldownMs: 60_000, suggestionsPerSession: 3 , checkpoints: Object.freeze([1_300, 2_500, 2_800, 4_000])}),
  balanced: Object.freeze({ goalHoverMs: 1_500, linkHoverMs: 2_500, cooldownMs: 25_000, suggestionsPerSession: 5 , checkpoints: Object.freeze([400, 1_500, 2_500])}),
  eager: Object.freeze({ goalHoverMs: 1_000, linkHoverMs: 1_800, cooldownMs: 15_000, suggestionsPerSession: 6 , checkpoints: Object.freeze([400, 1_000, 1_800])}),
});
export const paceOf = (name) => PACES[name] ?? PACES.balanced;

// How the chat button looks (agent.js draws each icon; "logo" is the site's own logo mark, "image"
// a picture the owner uploaded for the agent, `iconImage`).
export const ICONS = ["chat", "sparkle", "question", "wave", "heart", "logo", "image"];
const ICON_IMAGE = /^\/assets\/img\/[\w./-]+\.(png|jpe?g|gif|webp|svg)$/i;
export const POSITIONS = ["right", "left"];
// How the button catches the eye when a visitor arrives and when the agent speaks (agent.js; never
// with reduced motion).
export const ANIMATIONS = ["none", "pulse", "bounce", "wiggle", "glow"];

// The owner's settings.
export const TONES = ["friendly", "professional", "playful", "calm"];
export const MAX_GOALS = 6;
// Credits the agent may spend per site in any 24 hours: the owner picks within these.
export const DAILY_CREDITS = Object.freeze({ min: 100, default: 2_000, max: 20_000 });
export const DEFAULT_SETTINGS = Object.freeze({
  name: "Site helper",
  greeting: "Hi! Can I help you find something?",
  tone: "friendly",
  goals: [],
  dailyCredits: DAILY_CREDITS.default,
  // Remember visitors on their device for REMEMBER_DAYS (off by default); with rememberAfterBanner,
  // only once the site's cookie banner says yes (UK/EU sites).
  remember: false,
  rememberAfterBanner: false,
  pace: "balanced",
  // How much of the site the agent reads: every page in full ("full", agent-index.json) or the
  // start of each page ("start", search-index.json; fewer tokens per answer).
  reads: "full",
  // The free hello bubble a few seconds into a visit.
  greet: true,
  // The chat button: its colour ("" = the site's brand colour), corner, icon and an optional label.
  color: "",
  position: "right",
  icon: "chat",
  iconImage: "",
  label: "",
  animation: "none",
});

/* ------------------------------------------------------------------ text */

const clean = (value, max) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Six or more digits, maybe split by spaces, dots, dashes or brackets: phone, card and account numbers.
const LONG_NUMBER = /\+?\d[\d\s().-]{4,}\d/g;

/** `text` without email addresses or long numbers (phone, card, account numbers). */
export function redact(text) {
  return String(text ?? "")
    .replace(EMAIL, "[email]")
    .replace(LONG_NUMBER, (match) => (match.replace(/\D/g, "").length >= 6 ? "[number]" : match));
}

/** A label for something on the page: plain text, short, with nothing personal in it. */
export const labelOf = (value) => redact(clean(value, 80)).slice(0, 60);

/** A path on the site as it's kept: no query or hash, and /x/index.html is /x/. Null when it isn't one. */
export function sitePath(value) {
  const p = clean(value, 300);
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  const bare = p.split(/[?#]/)[0].replace(/(^|\/)index\.html$/i, "$1") || "/";
  return /^[\w\-./~%@+:]*$/.test(bare) ? bare : null;
}

/** The page an address is, for comparing: GitHub Pages serves /x.html at /x too. */
export const pageKey = (p) => (p ? p.replace(/\.html$/i, "") || "/" : p);

function linkOf(value) {
  if (value === "tel" || value === "mail") return value;
  if (typeof value === "string" && value.startsWith("ext:")) {
    const host = value.slice(4).toLowerCase().slice(0, 253);
    return /^[a-z0-9.-]+$/.test(host) ? `ext:${host}` : null;
  }
  return sitePath(value);
}

const KINDS = ["link", "button", "section"];

/* ------------------------------------------------------------------ batches */

/**
 * The batch a widget posted (its raw text), checked and trimmed, or null to drop it:
 * `{ sid, path, width, dnt, events }`, events as `{ kind: "view"|"hover"|"click"|"scroll"|"time"|"exit", … }`.
 */
export function parseBatch(body) {
  if (typeof body !== "string" || body.length > MAX_BATCH_BYTES) return null;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !SESSION_ID.test(data.s ?? "")) return null;
  const path = sitePath(data.p);
  if (!path) return null;
  const events = [];
  for (const raw of Array.isArray(data.e) ? data.e.slice(0, MAX_EVENTS) : []) {
    const event = eventOf(raw);
    if (event) events.push(event);
  }
  const width = Number(data.w);
  const vid = typeof data.v === "string" && VISITOR_ID.test(data.v) && data.v !== data.s ? data.v : null;
  return { sid: data.s, vid, path, width: Number.isFinite(width) && width > 0 ? Math.min(Math.round(width), 10_000) : 0, dnt: data.dnt === true, quiet: data.q === 1, events };
}

function eventOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const number = (value, max) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : null;
  };
  switch (raw.k) {
    case "v": {
      const path = sitePath(raw.p);
      return path && { kind: "view", path };
    }
    case "h":
    case "c": {
      const label = labelOf(raw.l);
      const link = raw.u == null ? null : linkOf(raw.u);
      if (!label && !link) return null;
      const target = { label, link, type: KINDS.includes(raw.x) ? raw.x : "link" };
      if (raw.k === "c") return { kind: "click", ...target };
      const ms = number(raw.d, 120_000);
      return ms ? { kind: "hover", ...target, ms } : null;
    }
    case "s": {
      const depth = number(raw.d, 100);
      return depth === null ? null : { kind: "scroll", depth };
    }
    case "t": {
      const seconds = number(raw.d, 24 * 60 * 60);
      return seconds === null ? null : { kind: "time", seconds };
    }
    case "x":
      return { kind: "exit" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ sessions */

/** What a thing on the page is called in a session: its link when it has one, else its label. */
const idOf = (target) => (target.link && !target.link.startsWith("ext:") ? `${target.link}` : `${target.type}:${target.label.toLowerCase()}`);

/** A new visitor session (the per-visitor agent's state), as stored. Times are Dates. */
export function newSession({ siteId, sid, now, device }) {
  return {
    siteId,
    sid,
    startedAt: now,
    lastSeenAt: now,
    device,
    pages: [],
    page: null,
    suggestions: [],
    questions: [],
    interests: {},
  };
}

function freshPage(path, now) {
  return { path, since: now, scroll: 0, seconds: 0, exit: false, hovers: {}, clicks: {}, labels: {} };
}

/**
 * Folds a batch into the session (changed in place): pages seen, and what happened on the current
 * page (hover time and clicks by thing, scroll depth, time, leaving). Also marks a suggestion
 * `reached` when its address is opened later. Returns the session.
 */
export function applyBatch(session, batch, now) {
  session.lastSeenAt = now;
  const view = (path) => {
    if (session.page?.path === path) return;
    session.page = freshPage(path, now);
    const last = session.pages.at(-1);
    if (last?.path !== path) {
      session.pages.push({ path, at: now });
      if (session.pages.length > LIMITS.pagesPerSession) session.pages.splice(0, session.pages.length - LIMITS.pagesPerSession);
    }
    for (const s of session.suggestions) if (pageKey(s.target) === pageKey(path) && !s.reachedAt) s.reachedAt = now;
  };
  view(batch.path);
  for (const event of batch.events) {
    if (event.kind === "view") {
      view(event.path);
      continue;
    }
    const page = session.page;
    if (event.kind === "hover" || event.kind === "click") {
      const id = idOf(event);
      // A fixed number of things per page, so one session's state stays small.
      if (!(id in page.labels) && Object.keys(page.labels).length >= 40) continue;
      page.labels[id] = { label: event.label, link: event.link, type: event.type };
      if (event.kind === "hover") page.hovers[id] = Math.min((page.hovers[id] ?? 0) + event.ms, 600_000);
      else page.clicks[id] = (page.clicks[id] ?? 0) + 1;
      noteInterest(session, id, event, path0(session));
    } else if (event.kind === "scroll") page.scroll = Math.max(page.scroll, event.depth);
    else if (event.kind === "time") page.seconds = Math.max(page.seconds, event.seconds);
    else if (event.kind === "exit") page.exit = true;
  }
  return session;
}

const path0 = (session) => session.page?.path ?? null;

/**
 * The visitor's own memory across the visit (this visitor's "sub-agent" state): what they rested on
 * or clicked on any page, by thing, with the time spent and clicks. Kept to LIMITS.interests things
 * (the weakest go first), so a session stays small.
 */
function noteInterest(session, id, event, path) {
  const interests = (session.interests ??= {});
  const was = interests[id] ?? { label: event.label ?? null, link: event.link ?? null, hover: 0, clicks: 0, path };
  if (event.kind === "hover") was.hover = Math.min(was.hover + (event.ms ?? 0), 600_000);
  else was.clicks += 1;
  interests[id] = was;
  const ids = Object.keys(interests);
  if (ids.length > LIMITS.interests) {
    ids.sort((a, b) => interestScore(interests[a]) - interestScore(interests[b]));
    for (const drop of ids.slice(0, ids.length - LIMITS.interests)) delete interests[drop];
  }
}

const interestScore = (thing) => thing.hover / 1000 + thing.clicks * 3;

/** The visitor's strongest interests this visit, strongest first, for the model. */
export function topInterests(session, limit = 8) {
  return Object.values(session.interests ?? {})
    .filter((t) => t.label || t.link)
    .sort((a, b) => interestScore(b) - interestScore(a))
    .slice(0, limit);
}

/** Whether a thing on the page (`{ label, link }`) leads to the goal (`{ label, path }`). */
export function matchesGoal(target, goal) {
  if (target.link && pageKey(target.link) === pageKey(goal.path)) return true;
  const label = (target.label ?? "").toLowerCase();
  const want = goal.label.toLowerCase();
  if (!label || !want) return false;
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(label);
}

/**
 * Whether a suggestion may be made now (the per-session limits): no more than
 * LIMITS.suggestionsPerSession, one per page, LIMITS.cooldownMs apart, none in the first seconds.
 */
export function maySuggest(session, now, { resting = false, pace = PACES.balanced } = {}) {
  if (!session.page) return false;
  if (session.suggestions.length >= pace.suggestionsPerSession) return false;
  // One per page view (opening the page again later may bring another); a rest, which the visitor
  // chose, may bring a second one, still after the cooldown.
  const since = new Date(session.page.since ?? 0).getTime();
  const here = session.suggestions.filter((s) => pageKey(s.path) === pageKey(session.page.path) && new Date(s.at).getTime() >= since).length;
  if (here >= (resting ? RESTING_PER_PAGE : 1)) return false;
  const last = session.suggestions.at(-1);
  if (last && now - new Date(last.at).getTime() < pace.cooldownMs) return false;
  // Resting on something is a deliberate act, so the quiet start doesn't hold it back.
  return resting || now - new Date(session.startedAt).getTime() >= LIMITS.quietStartMs;
}

/** Suggestions one page view may bring when the visitor rests on things (other triggers: 1). */
export const RESTING_PER_PAGE = 2;

/** A link on the page to another of the site's own pages (not a phone, email or outside link). */
const sitePageLink = (thing, current) => typeof thing.link === "string" && thing.link.startsWith("/") && pageKey(thing.link) !== pageKey(current);

/**
 * The trigger for a suggestion now, or null: the cheap rules that decide WHEN (the model only
 * writes WHAT). In order: resting on something that leads to a goal, resting on a link to another
 * of the site's pages, clicking the same thing again and again, leaving, browsing pages without
 * reaching a goal, reading one page for a long time.
 * `{ type, goal?, thing?, thingId?, about }`, where `about` says what happened in a few words for the model.
 *
 * `lead` (ms) counts every rest as that much longer, and then only the resting triggers are looked
 * at: what would trigger if the pointer stays put, so the suggestion can be written ahead of time.
 */
export function decide(session, goals, now, { lead = 0, pace = PACES.balanced } = {}) {
  if (!session.page) return null;
  const page = session.page;
  const visitedPaths = new Set(session.pages.map((p) => pageKey(p.path)));
  const open = goals.filter((g) => !visitedPaths.has(pageKey(g.path)));
  // Resting works for every goal not suggested yet this visit (a goal page seen isn't a goal done),
  // goals not seen yet first. A place already offered is never offered again in the visit.
  const offered = new Set(session.suggestions.map((s) => pageKey(s.target)));
  const restGoals = [...open, ...goals.filter((g) => !open.includes(g))].filter((g) => !offered.has(pageKey(g.path)));
  const things = Object.entries(page.labels).map(([id, thing]) => ({ id, ...thing, hover: (page.hovers[id] ?? 0) + (page.hovers[id] ? lead : 0), clicks: page.clicks[id] ?? 0 }));

  if (maySuggest(session, now, { resting: true, pace })) {
    const resting = things.filter((t) => t.clicks === 0).sort((a, b) => b.hover - a.hover);
    for (const thing of resting) {
      if (thing.hover < pace.goalHoverMs) break;
      const goal = restGoals.find((g) => matchesGoal(thing, g));
      if (goal) return { type: "goal-hover", goal, thing: thing.label, thingId: thing.id, about: `paused for a while over "${thing.label || goal.label}" without clicking it` };
    }
    for (const thing of resting) {
      if (thing.hover < pace.linkHoverMs) break;
      if (sitePageLink(thing, page.path) && !offered.has(pageKey(thing.link)) && !goals.some((g) => matchesGoal(thing, g))) {
        return { type: "link-hover", thing: thing.label, thingId: thing.id, about: `paused over "${thing.label || thing.link}" (a link to ${thing.link}) without clicking it` };
      }
    }
    // A button that isn't a link to a page ("Add to basket", a menu toggle, a tab): the visitor is
    // weighing it up, so the place on the site that helps with it is offered.
    for (const thing of resting) {
      if (thing.hover < pace.linkHoverMs) break;
      if (thing.type === "button" && thing.label && !thing.link && !session.suggestions.some((s) => s.trigger === "button-hover" && s.thing === thing.label)) {
        return { type: "button-hover", thing: thing.label, thingId: thing.id, about: `paused over the "${thing.label}" button without pressing it` };
      }
    }
  }
  if (lead || !maySuggest(session, now, { pace })) return null;
  const repeated = things.find((t) => t.clicks >= TRIGGERS.repeatClicks);
  if (repeated) return { type: "repeat-clicks", thing: repeated.label, about: `clicked "${repeated.label || "the same part of the page"}" several times, maybe looking for something that isn't there` };
  if (page.exit && now - new Date(session.startedAt).getTime() >= TRIGGERS.leavingAfterMs) {
    return { type: "leaving", about: "looks about to leave the site" };
  }
  if (visitedPaths.size >= TRIGGERS.browsingPages && goals.length && open.length === goals.length) {
    return { type: "browsing", about: `has looked at ${visitedPaths.size} pages without reaching any of the owner's goals` };
  }
  if (page.seconds >= TRIGGERS.readingSeconds && page.scroll >= TRIGGERS.readingScroll) {
    return { type: "reading", about: `has been reading this page for ${Math.round(page.seconds)} seconds` };
  }
  return null;
}

/* ------------------------------------------------------------------ replies */

/** The model's reply's JSON object, or null. */
export function parseReply(text) {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ guards */

// What the agent may never say, whatever a visitor asks or the model writes: which AI or company is
// behind it, its instructions, code, and links, emails or long numbers the site itself doesn't have.
// Names of AI models and companies, and talk about its instructions. A word the site itself uses
// (a "Gemini" print, a llama farm) is fine: outOfBounds checks the site's text first.
const OUTSIDE_WORDS = /\b(claude|anthropic|open ?ai|chat ?gpt|gpt-?\d[\w.-]*|deepseek|gemini|llama|mistral|copilot|language model|llm|as an ai|ai model|ai assistant|system prompt|my instructions)\b/gi;
// Code: fences, markup tags, and program text (case-sensitive where everyday words could match:
// "Select a gift card from £10" isn't SQL, "we import books" isn't a program).
const CODE = [/```/, /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i, /\bfunction\s*\w*\s*\([^)]*\)\s*\{/, /\bconsole\.\w+\(/, /\bdef\s+\w+\([^)]*\)\s*:/, /\bimport\s+[\w{}*, ]+\s+from\s+["']/, /\bSELECT\s+[\w*, ]+\s+FROM\b/, /=>\s*\{/];
const WEB_ADDRESS = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|co|uk|ai|app|dev|info|biz|me|xyz)\b(\/\S*)?/gi;

/**
 * Why `text` (something the agent would show a visitor) goes outside the website, or null when it
 * doesn't. `siteText` is all the site's own page text: an email, phone number or web address it
 * has may be repeated, any other may not.
 */
export function outOfBounds(text, siteText = "") {
  const own = String(siteText).toLowerCase();
  const ownDigits = own.replace(/\D/g, "");
  const said = String(text ?? "");
  for (const word of said.match(OUTSIDE_WORDS) ?? []) if (!own.includes(word.toLowerCase())) return "identity";
  if (CODE.some((rule) => rule.test(said))) return "code";
  for (const email of said.match(EMAIL) ?? []) if (!own.includes(email.toLowerCase())) return "email";
  for (const number of said.match(LONG_NUMBER) ?? []) {
    const digits = number.replace(/\D/g, "");
    if (digits.length >= 6 && !ownDigits.includes(digits)) return "number";
  }
  for (const address of said.replace(EMAIL, " ").match(WEB_ADDRESS) ?? []) {
    const host = address.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
    if (!own.includes(host)) return "link";
  }
  return null;
}

// A visitor trying to get the agent out of its job: its instructions, what it is, playing a part.
const TRICKS = [
  /\bignore\b.{0,40}\b(instructions?|rules?|prompt|above|previous)\b/i,
  /\b(system|hidden|initial|original|secret)\s+(prompt|instructions?)\b/i,
  /\b(repeat|print|show|reveal|tell me|what are)\b.{0,30}\b(your|the) (instructions|prompt|rules)\b/i,
  /\b(which|what)\s+(ai|llm|language model|chatbot|bot|model|engine)\b.{0,25}\b(are you|is this|is that|powers|behind|do you use|you use|runs you)\b/i,
  /\b(are you|you're|you are)\s+(chat ?gpt|gpt|claude|gemini|deepseek|an? (ai|bot|robot|llm|language model))\b/i,
  /\b(who|what company)\s+(made|built|created|trained|powers|runs)\s+you\b/i,
  /\b(pretend (you|to be|that you)|let'?s role-?play|role-?play (as|with me)|you are now|from now on,? you|jailbreak|developer mode|do anything now)\b/i,
  /\bact as (an?|my) (?!\w+ for (the|our|your) (shop|store|club|business))/i,
]

/** Whether a visitor's question tries to take the agent off its job (answered with fixed words, no model). */
export const isTrick = (question) => TRICKS.some((rule) => rule.test(String(question ?? "")));

/** The fixed words for anything outside the website. */
export const OFF_TOPIC_ANSWER = "I can only help with questions about this website and what it offers. Is there something here I can help you find?";

/**
 * A suggestion from the model's reply, checked: `{ text, target, label }`, or null when it doesn't
 * hold up (no message, an address that isn't one of `allowed`, the page the visitor is on, or words
 * outside the website).
 */
export function checkSuggestion(reply, allowed, currentPath, siteText = "") {
  if (!reply) return null;
  const text = clean(reply.message, 220);
  const label = clean(reply.label, 40) || "Show me";
  const target = sitePath(reply.target);
  if (text.length < 3 || !target || !allowed.has(target) || pageKey(target) === pageKey(currentPath)) return null;
  if (outOfBounds(text, siteText) || outOfBounds(label, siteText)) return null;
  return { text, target, label };
}

/**
 * An answer from the model's reply, checked: `{ text, target, label }` (target null when none
 * fits), `{ offTopic: true }` when the question wasn't about the website or the answer goes outside
 * it, or null when the reply is unusable.
 */
export function checkAnswer(reply, allowed, siteText = "") {
  if (!reply) return null;
  if (reply.about_site === false) return { offTopic: true };
  const text = clean(reply.answer, 600);
  if (text.length < 2) return null;
  const target = sitePath(reply.target);
  const ok = target && allowed.has(target);
  const label = ok ? clean(reply.label, 40) || "Open page" : null;
  if (outOfBounds(text, siteText) || (label && outOfBounds(label, siteText))) return { offTopic: true };
  // The model's word on whether the site's pages held the answer (for the owner's insights).
  return { text, target: ok ? target : null, label, ...(reply.found === false && { unanswered: true }) };
}

/* ------------------------------------------------------------------ returning visitors */

/**
 * A returning visitor, as stored (agentVisitors): what earlier visits showed, folded in when the
 * next visit starts (foldVisit), so one visit never waits on writing two documents.
 */
export function newVisitor({ siteId, vid, now }) {
  return { siteId, vid, firstSeenAt: now, lastSeenAt: now, visits: 0, lastSid: null, interests: {}, pages: [], suggestions: [], questions: [] };
}

const VISITOR_LIMITS = { interests: 30, pages: 50, suggestions: 12, questions: 6 };

/** Folds a finished (or earlier) visit's session into the visitor (changed in place). */
export function foldVisit(visitor, session) {
  const interests = (visitor.interests ??= {});
  for (const [id, thing] of Object.entries(session.interests ?? {})) {
    const was = interests[id] ?? { label: thing.label ?? null, link: thing.link ?? null, hover: 0, clicks: 0 };
    was.hover = Math.min(was.hover + (thing.hover ?? 0), 3_600_000);
    was.clicks = Math.min(was.clicks + (thing.clicks ?? 0), 1_000);
    if (thing.label) was.label = thing.label;
    interests[id] = was;
  }
  const ids = Object.keys(interests);
  if (ids.length > VISITOR_LIMITS.interests) {
    ids.sort((a, b) => interestScore(interests[a]) - interestScore(interests[b]));
    for (const drop of ids.slice(0, ids.length - VISITOR_LIMITS.interests)) delete interests[drop];
  }
  const pages = (visitor.pages ?? []).filter((p) => !(session.pages ?? []).some((q) => q.path === p));
  visitor.pages = [...pages, ...new Set((session.pages ?? []).map((p) => p.path))].slice(-VISITOR_LIMITS.pages);
  const suggestions = (session.suggestions ?? []).map((x) => ({ target: x.target, outcome: x.outcome ?? null, reached: Boolean(x.reachedAt), at: x.at }));
  visitor.suggestions = [...(visitor.suggestions ?? []), ...suggestions].slice(-VISITOR_LIMITS.suggestions);
  const questions = (session.questions ?? []).filter((q) => q.answer).map((q) => ({ question: q.question, at: q.at }));
  visitor.questions = [...(visitor.questions ?? []), ...questions].slice(-VISITOR_LIMITS.questions);
  return visitor;
}

/** What a visit knows about the visitor's earlier visits (kept on the session as `memory`). */
export function visitorMemory(visitor, previousVisitAt) {
  const interests = Object.values(visitor.interests ?? {})
    .filter((t) => t.label || t.link)
    .sort((a, b) => interestScore(b) - interestScore(a))
    .slice(0, 8);
  return {
    visit: visitor.visits,
    previousVisitAt,
    interests,
    pages: (visitor.pages ?? []).slice(-15),
    suggestions: (visitor.suggestions ?? []).slice(-6),
    questions: (visitor.questions ?? []).slice(-3).map((q) => q.question),
  };
}

/** Addresses the visitor turned down on an earlier visit: not offered again while they're remembered. */
export const declinedBefore = (session) => new Set((session.memory?.suggestions ?? []).filter((s) => s.outcome === "dismissed").map((s) => s.target));

/* ------------------------------------------------------------------ settings */

/** Thrown with a message to show the owner when settings can't be saved. */
export class SettingsError extends Error {}

/**
 * The owner's settings as they may be saved, from what the editor sent. `pages` are the site's
 * addresses (goals must lead to one of them). Throws SettingsError.
 */
export function cleanSettings(input, pages) {
  const name = clean(input?.name, 40);
  if (!name) throw new SettingsError("Give your agent a name.");
  const greeting = clean(input?.greeting, 200);
  if (!greeting) throw new SettingsError("Write a greeting for visitors.");
  const tone = TONES.includes(input?.tone) ? input.tone : DEFAULT_SETTINGS.tone;
  const goals = [];
  for (const raw of Array.isArray(input?.goals) ? input.goals : []) {
    const label = clean(raw?.label, 40);
    const path = sitePath(raw?.path);
    if (!label && !path) continue;
    if (!label) throw new SettingsError("Each goal needs a name, like Donate or Contact us.");
    if (!path || !pages.has(path)) throw new SettingsError(`Choose one of your site's pages for "${label}".`);
    if (goals.some((g) => g.path === path)) throw new SettingsError(`Two goals lead to the same page (${path}).`);
    goals.push({ label, path, note: clean(raw?.note, 160) });
  }
  if (goals.length > MAX_GOALS) throw new SettingsError(`Keep it to ${MAX_GOALS} goals at most.`);
  const daily = Number(input?.dailyCredits);
  if (!Number.isInteger(daily) || daily < DAILY_CREDITS.min || daily > DAILY_CREDITS.max) {
    throw new SettingsError(`The daily limit must be between ${DAILY_CREDITS.min} and ${DAILY_CREDITS.max} credits.`);
  }
  const pace = Object.hasOwn(PACES, input?.pace) ? input.pace : DEFAULT_SETTINGS.pace;
  const color = typeof input?.color === "string" ? input.color.trim().toLowerCase() : "";
  if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new SettingsError("Choose the button colour from the picker, or use your site's colour.");
  const look = {
    color,
    position: POSITIONS.includes(input?.position) ? input.position : DEFAULT_SETTINGS.position,
    icon: ICONS.includes(input?.icon) ? input.icon : DEFAULT_SETTINGS.icon,
    iconImage: typeof input?.iconImage === "string" && ICON_IMAGE.test(input.iconImage) && !input.iconImage.includes("..") ? input.iconImage : "",
    label: clean(input?.label, 24),
    animation: ANIMATIONS.includes(input?.animation) ? input.animation : DEFAULT_SETTINGS.animation,
  };
  if (look.icon === "image" && !look.iconImage) throw new SettingsError("Upload a picture for the chat button, or choose another icon.");
  return { name, greeting, tone, goals, dailyCredits: daily, remember: input?.remember === true, rememberAfterBanner: input?.rememberAfterBanner === true, reads: input?.reads === "start" ? "start" : "full", pace, greet: input?.greet !== false, ...look };
}

/* ------------------------------------------------------------------ limits */

/**
 * A fixed-window counter per key (in memory: the API is one process). `take(key)` is true while
 * the key has fewer than `limit` in the current window, and counts one.
 */
export function windowLimiter(limit, windowMs, { now = () => Date.now() } = {}) {
  const counts = new Map();
  return {
    take(key) {
      const t = now();
      const entry = counts.get(key);
      if (!entry || entry.resetAt <= t) {
        counts.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count += 1;
      return true;
    },
    sweep() {
      const t = now();
      for (const [key, entry] of counts) if (entry.resetAt <= t) counts.delete(key);
    },
    get size() {
      return counts.size;
    },
  };
}

/** Pages from the published site's search index (search-index.json), checked: `{ url, title, description, text }`. */
export function indexPages(json, { textMax = 400 } = {}) {
  if (!Array.isArray(json)) return [];
  const pages = [];
  for (const entry of json.slice(0, 500)) {
    const url = sitePath(entry?.url);
    if (!url) continue;
    pages.push({ url, title: clean(entry.title, 120) || url, description: clean(entry.description, 300), text: clean(entry.text, textMax) });
  }
  return pages;
}

// Each page's whole text, from the site's agent-index.json (the template's lib/agent-index.js).
export const FULL_TEXT_MAX = 12_000;

/**
 * The parts of a page's `text` that matter for `query`, in page order, at most `max` characters:
 * the text split into passages of a few sentences, the ones sharing the most words with the query
 * kept (the page's opening always, for context). The whole text when it's short enough.
 */
export function passagesFor(text, query, max = 1_500) {
  const all = String(text ?? "");
  if (all.length <= max) return all;
  const sentences = all.match(/[^.!?\n]+[.!?]*\s*/g) ?? [all];
  const passages = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > 320) {
      passages.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) passages.push(current.trim());
  const words = new Set(String(query ?? "").toLowerCase().match(WORD) ?? []);
  const scored = passages.map((passage, i) => {
    const lower = passage.toLowerCase();
    let score = i === 0 ? 0.5 : 0;
    for (const word of words) if (lower.includes(word)) score += 1;
    return { passage, i, score };
  });
  const chosen = [];
  let used = 0;
  for (const p of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (used + p.passage.length + 3 > max) continue;
    chosen.push(p);
    used += p.passage.length + 3;
  }
  return chosen
    .sort((a, b) => a.i - b.i)
    .map((p, n, list) => (n > 0 && list[n - 1].i !== p.i - 1 ? `… ${p.passage}` : p.passage))
    .join(" ");
}

const WORD = /[a-z0-9]{3,}/g;

/** The `limit` pages that best match `text` (shared words in title, description and text), in order. */
export function relevantPages(pages, text, limit = 8) {
  const words = new Set(String(text ?? "").toLowerCase().match(WORD) ?? []);
  const scored = pages.map((page, i) => {
    const title = page.title.toLowerCase();
    const body = `${page.description} ${page.text}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (title.includes(word)) score += 3;
      if (body.includes(word)) score += 1;
    }
    return { page, score, i };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.page);
}

/** The outcome a widget reports for a suggestion, or null. */
/**
 * The visit's last suggestion when it never reached the screen (the visitor had moved on before it
 * was written) and still makes sense now: unanswered, under REDELIVER_MS old, not for this page,
 * not reached, offered again at most REDELIVER_TIMES. Changed in place; null when there's none.
 */
export function pendingSuggestion(session, now) {
  const last = session.suggestions?.at(-1);
  if (!last || last.shownAt || last.outcome || last.reachedAt) return null;
  if (now - new Date(last.at).getTime() > REDELIVER_MS || (last.redelivered ?? 0) >= REDELIVER_TIMES) return null;
  if (!session.page || pageKey(last.target) === pageKey(session.page.path)) return null;
  last.redelivered = (last.redelivered ?? 0) + 1;
  return last;
}
const REDELIVER_MS = 10 * 60_000;
const REDELIVER_TIMES = 2;

export const outcomeOf = (value) => (["accepted", "dismissed", "ignored"].includes(value) ? value : null);
