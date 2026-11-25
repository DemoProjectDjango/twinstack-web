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
export const KEY = /^[A-Za-z0-9_-]{16,64}$/;

// When a suggestion may be made, per visitor session.
export const LIMITS = Object.freeze({
  suggestionsPerSession: 3,
  // Between two suggestions.
  cooldownMs: 60_000,
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
  return { sid: data.s, path, width: Number.isFinite(width) && width > 0 ? Math.min(Math.round(width), 10_000) : 0, dnt: data.dnt === true, events };
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
    } else if (event.kind === "scroll") page.scroll = Math.max(page.scroll, event.depth);
    else if (event.kind === "time") page.seconds = Math.max(page.seconds, event.seconds);
    else if (event.kind === "exit") page.exit = true;
  }
  return session;
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
export function maySuggest(session, now) {
  if (!session.page) return false;
  if (session.suggestions.length >= LIMITS.suggestionsPerSession) return false;
  if (session.suggestions.some((s) => pageKey(s.path) === pageKey(session.page.path))) return false;
  const last = session.suggestions.at(-1);
  if (last && now - new Date(last.at).getTime() < LIMITS.cooldownMs) return false;
  return now - new Date(session.startedAt).getTime() >= LIMITS.quietStartMs;
}

/**
 * The trigger for a suggestion now, or null: the cheap rules that decide WHEN (the model only
 * writes WHAT). In order: resting on something that leads to a goal, clicking the same thing again
 * and again, leaving, browsing pages without reaching a goal, reading one page for a long time.
 * `{ type, goal?, thing?, about }`, where `about` says what happened in a few words for the model.
 */
export function decide(session, goals, now) {
  if (!maySuggest(session, now)) return null;
  const page = session.page;
  const visitedPaths = new Set(session.pages.map((p) => pageKey(p.path)));
  const open = goals.filter((g) => !visitedPaths.has(pageKey(g.path)));
  const things = Object.entries(page.labels).map(([id, thing]) => ({ id, ...thing, hover: page.hovers[id] ?? 0, clicks: page.clicks[id] ?? 0 }));

  for (const thing of things.sort((a, b) => b.hover - a.hover)) {
    if (thing.hover < TRIGGERS.goalHoverMs || thing.clicks > 0) continue;
    const goal = open.find((g) => matchesGoal(thing, g));
    if (goal) return { type: "goal-hover", goal, thing: thing.label, about: `paused for a while over "${thing.label || goal.label}" without clicking it` };
  }
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

/**
 * A suggestion from the model's reply, checked: `{ text, target, label }`, or null when it doesn't
 * hold up (no message, an address that isn't one of `allowed`, or the page the visitor is on).
 */
export function checkSuggestion(reply, allowed, currentPath) {
  if (!reply) return null;
  const text = redact(clean(reply.message, 220));
  const target = sitePath(reply.target);
  if (text.length < 3 || !target || !allowed.has(target) || pageKey(target) === pageKey(currentPath)) return null;
  return { text, target, label: clean(reply.label, 40) || "Show me" };
}

/** An answer from the model's reply, checked: `{ text, target, label }` (target null when none fits), or null. */
export function checkAnswer(reply, allowed) {
  if (!reply) return null;
  const text = clean(reply.answer, 600);
  if (text.length < 2) return null;
  const target = sitePath(reply.target);
  const ok = target && allowed.has(target);
  return { text, target: ok ? target : null, label: ok ? clean(reply.label, 40) || "Open page" : null };
}

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
  return { name, greeting, tone, goals, dailyCredits: daily };
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
export function indexPages(json) {
  if (!Array.isArray(json)) return [];
  const pages = [];
  for (const entry of json.slice(0, 500)) {
    const url = sitePath(entry?.url);
    if (!url) continue;
    pages.push({ url, title: clean(entry.title, 120) || url, description: clean(entry.description, 300), text: clean(entry.text, 400) });
  }
  return pages;
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
export const outcomeOf = (value) => (["accepted", "dismissed", "ignored"].includes(value) ? value : null);
