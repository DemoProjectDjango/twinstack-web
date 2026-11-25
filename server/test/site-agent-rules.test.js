import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DAILY_CREDITS,
  LIMITS,
  MAX_BATCH_BYTES,
  SettingsError,
  applyBatch,
  checkAnswer,
  checkSuggestion,
  cleanSettings,
  decide,
  indexPages,
  labelOf,
  matchesGoal,
  maySuggest,
  newSession,
  outcomeOf,
  pageKey,
  parseBatch,
  parseReply,
  redact,
  relevantPages,
  sitePath,
  windowLimiter,
} from "../src/site-agent-rules.js";

const SID = "abcdefghijklmnopqrstuv";
const T0 = new Date("2026-11-25T10:00:00Z");
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);
const batch = (events, path = "/", extra = {}) => parseBatch(JSON.stringify({ s: SID, p: path, w: 1280, e: events, ...extra }));
const GOALS = [
  { label: "Donate", path: "/donate.html", note: "" },
  { label: "Contact us", path: "/contact.html", note: "" },
];

describe("parseBatch", () => {
  it("keeps the known events, trimmed", () => {
    const b = batch([
      { k: "v", p: "/about/index.html?x=1#top" },
      { k: "h", l: "  Donate   now ", u: "/donate.html", x: "link", d: 1800 },
      { k: "c", l: "Menu", x: "button" },
      { k: "s", d: 140 },
      { k: "t", d: 12.4 },
      { k: "x" },
      { k: "weird" },
    ]);
    assert.equal(b.sid, SID);
    assert.equal(b.width, 1280);
    assert.deepEqual(
      b.events.map((e) => e.kind),
      ["view", "hover", "click", "scroll", "time", "exit"],
    );
    assert.equal(b.events[0].path, "/about/");
    assert.equal(b.events[1].label, "Donate now");
    assert.equal(b.events[3].depth, 100);
    assert.equal(b.events[4].seconds, 12);
  });

  it("drops what isn't a batch", () => {
    assert.equal(parseBatch("not json"), null);
    assert.equal(parseBatch(JSON.stringify({ s: "short", p: "/" })), null);
    assert.equal(parseBatch(JSON.stringify({ s: SID, p: "https://evil.example/" })), null);
    assert.equal(parseBatch(JSON.stringify({ s: SID, p: "//evil.example/" })), null);
    assert.equal(parseBatch("x".repeat(MAX_BATCH_BYTES + 1)), null);
  });

  it("caps the number of events", () => {
    const many = Array.from({ length: 100 }, () => ({ k: "s", d: 10 }));
    assert.equal(batch(many).events.length, 60);
  });

  it("never keeps personal data in labels or links", () => {
    const b = batch([
      { k: "c", l: "Call 020 7946 0000", u: "tel" },
      { k: "c", l: "Email jane.doe@example.com", u: "mail" },
      { k: "c", l: "Partner", u: "ext:Partner.Example.org" },
      { k: "c", l: "Bad", u: "javascript:alert(1)" },
    ]);
    assert.equal(b.events[0].label, "Call [number]");
    assert.equal(b.events[0].link, "tel");
    assert.equal(b.events[1].label, "Email [email]");
    assert.equal(b.events[2].link, "ext:partner.example.org");
    assert.equal(b.events[3].link, null);
  });

  it("passes the do-not-track flag on", () => {
    assert.equal(batch([], "/", { dnt: true }).dnt, true);
  });
});

describe("text helpers", () => {
  it("redacts emails and long numbers but keeps short ones", () => {
    assert.equal(redact("Write to a@b.co or call +44 (0)20 7946-0000, open 9 to 5 since 1990"), "Write to [email] or call [number], open 9 to 5 since 1990");
  });
  it("labels are short and single-line", () => {
    assert.equal(labelOf("a\n\n b\tc"), "a b c");
    assert.equal(labelOf("x".repeat(200)).length, 60);
  });
  it("site paths", () => {
    assert.equal(sitePath("/index.html"), "/");
    assert.equal(sitePath("/blog/index.html"), "/blog/");
    assert.equal(sitePath("/a.html?q#h"), "/a.html");
    assert.equal(sitePath("a.html"), null);
    assert.equal(sitePath("/<script>"), null);
    assert.equal(pageKey("/donate.html"), "/donate");
  });
});

describe("sessions", () => {
  it("records pages, hovers and clicks on the current page", () => {
    const s = newSession({ siteId: 1, sid: SID, now: T0, device: "Desktop" });
    applyBatch(s, batch([{ k: "h", l: "Donate", u: "/donate.html", x: "link", d: 900 }]), at(1));
    applyBatch(s, batch([{ k: "h", l: "Donate", u: "/donate.html", x: "link", d: 900 }]), at(2));
    assert.equal(s.page.hovers["/donate.html"], 1800);
    applyBatch(s, batch([], "/about.html"), at(3));
    assert.deepEqual(
      s.pages.map((p) => p.path),
      ["/", "/about.html"],
    );
    assert.deepEqual(s.page.hovers, {});
  });

  it("marks a suggestion reached when its page is opened later", () => {
    const s = newSession({ siteId: 1, sid: SID, now: T0, device: "Desktop" });
    applyBatch(s, batch([]), at(1));
    s.suggestions.push({ id: "x", path: "/", target: "/donate.html", at: at(1), outcome: "accepted" });
    applyBatch(s, batch([], "/donate"), at(5));
    assert.ok(s.suggestions[0].reachedAt);
  });

  it("keeps a bounded number of things per page", () => {
    const s = newSession({ siteId: 1, sid: SID, now: T0, device: "Desktop" });
    const events = Array.from({ length: 60 }, (_, i) => ({ k: "c", l: `Thing ${i}`, x: "button" }));
    applyBatch(s, batch(events), at(1));
    assert.equal(Object.keys(s.page.labels).length, 40);
  });
});

describe("decide", () => {
  const session = () => newSession({ siteId: 1, sid: SID, now: T0, device: "Desktop" });

  it("waits a few seconds into a visit", () => {
    const s = session();
    applyBatch(s, batch([{ k: "h", l: "Donate", u: "/donate.html", x: "link", d: 3000 }]), at(1));
    assert.equal(decide(s, GOALS, at(1)), null);
    assert.equal(decide(s, GOALS, at(10)).type, "goal-hover");
  });

  it("goal hover: resting on a goal's link (or its label) long enough, without clicking", () => {
    const s = session();
    applyBatch(s, batch([{ k: "h", l: "Support our work", u: "/donate.html", x: "link", d: 1600 }]), at(10));
    const t = decide(s, GOALS, at(10));
    assert.equal(t.type, "goal-hover");
    assert.equal(t.goal.path, "/donate.html");

    const s2 = session();
    applyBatch(s2, batch([{ k: "h", l: "Contact us today", x: "button", d: 2000 }]), at(10));
    assert.equal(decide(s2, GOALS, at(10)).goal.label, "Contact us");

    const s3 = session();
    applyBatch(s3, batch([{ k: "h", l: "Donate", u: "/donate.html", x: "link", d: 500 }]), at(10));
    assert.equal(decide(s3, GOALS, at(10)), null);
  });

  it("no goal suggestion for a goal page already seen", () => {
    const s = session();
    applyBatch(s, batch([], "/donate.html"), at(1));
    applyBatch(s, batch([{ k: "h", l: "Donate", u: "/donate.html", x: "link", d: 3000 }], "/"), at(10));
    assert.equal(decide(s, GOALS, at(10)), null);
  });

  it("repeat clicks, leaving, browsing and reading", () => {
    const s = session();
    applyBatch(s, batch([{ k: "c", l: "Prices", x: "section" }, { k: "c", l: "Prices", x: "section" }, { k: "c", l: "Prices", x: "section" }]), at(10));
    assert.equal(decide(s, GOALS, at(10)).type, "repeat-clicks");

    const leaving = session();
    applyBatch(leaving, batch([{ k: "x" }]), at(12));
    assert.equal(decide(leaving, GOALS, at(12)).type, "leaving");
    const early = session();
    applyBatch(early, batch([{ k: "x" }]), at(6));
    assert.equal(decide(early, GOALS, at(6)), null);

    const browsing = session();
    for (const [i, p] of ["/", "/about.html", "/services.html"].entries()) applyBatch(browsing, batch([], p), at(10 + i));
    assert.equal(decide(browsing, GOALS, at(20)).type, "browsing");
    assert.equal(decide(browsing, [], at(20)), null);

    const reading = session();
    applyBatch(reading, batch([{ k: "t", d: 45 }, { k: "s", d: 70 }]), at(50));
    assert.equal(decide(reading, GOALS, at(50)).type, "reading");
  });

  it("per-session limits: one per page, a cooldown, three at most", () => {
    const s = session();
    applyBatch(s, batch([{ k: "x" }]), at(20));
    s.suggestions.push({ id: "a", path: "/", at: at(20) });
    assert.equal(maySuggest(s, at(200)), false, "one per page");
    applyBatch(s, batch([{ k: "x" }], "/about.html"), at(30));
    assert.equal(maySuggest(s, at(30)), false, "cooldown");
    assert.equal(maySuggest(s, at(20 + LIMITS.cooldownMs / 1000)), true);
    s.suggestions.push({ id: "b", path: "/x", at: at(100) }, { id: "c", path: "/y", at: at(200) });
    assert.equal(maySuggest(s, at(10_000)), false, "max per session");
  });
});

describe("matchesGoal", () => {
  it("matches by link or by the goal's words in the label", () => {
    assert.ok(matchesGoal({ link: "/donate", label: "" }, GOALS[0]));
    assert.ok(matchesGoal({ link: null, label: "Donate today" }, GOALS[0]));
    assert.ok(!matchesGoal({ link: null, label: "Donated items" }, GOALS[0]));
  });
});

describe("replies", () => {
  const allowed = new Set(["/", "/donate.html", "/contact.html"]);

  it("parses JSON, with or without a fence", () => {
    assert.deepEqual(parseReply('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseReply('Sure! {"a":2} hope that helps'), { a: 2 });
    assert.equal(parseReply("no json"), null);
    assert.equal(parseReply("[1,2]"), null);
  });

  it("a suggestion must lead to a known address that isn't this page", () => {
    assert.deepEqual(checkSuggestion({ message: "Want to help? ", target: "/donate.html", label: "Donate" }, allowed, "/"), {
      text: "Want to help?",
      target: "/donate.html",
      label: "Donate",
    });
    assert.equal(checkSuggestion({ message: "Go", target: "https://evil.example/", label: "x" }, allowed, "/"), null);
    assert.equal(checkSuggestion({ message: "Here", target: "/donate.html" }, allowed, "/donate"), null);
    assert.equal(checkSuggestion({ message: "Hi there", target: "/secret.html" }, allowed, "/"), null);
    assert.equal(checkSuggestion({ message: "Hi there", target: "/contact.html" }, allowed, "/").label, "Show me");
  });

  it("an answer keeps only a known address", () => {
    assert.deepEqual(checkAnswer({ answer: "We open at 9.", target: "/contact.html", label: "Contact" }, allowed), {
      text: "We open at 9.",
      target: "/contact.html",
      label: "Contact",
    });
    assert.deepEqual(checkAnswer({ answer: "Yes.", target: "javascript:x" }, allowed), { text: "Yes.", target: null, label: null });
    assert.equal(checkAnswer({ answer: "" }, allowed), null);
  });
});

describe("cleanSettings", () => {
  const pages = new Set(["/", "/donate.html", "/contact.html"]);
  const base = { name: "Sam", greeting: "Hello!", tone: "calm", goals: [{ label: "Donate", path: "/donate.html" }], dailyCredits: 2000 };

  it("keeps valid settings", () => {
    assert.deepEqual(cleanSettings(base, pages), { ...base, goals: [{ label: "Donate", path: "/donate.html", note: "" }] });
  });

  it("refuses what it can't save", () => {
    assert.throws(() => cleanSettings({ ...base, name: " " }, pages), SettingsError);
    assert.throws(() => cleanSettings({ ...base, goals: [{ label: "X", path: "/nope.html" }] }, pages), SettingsError);
    assert.throws(() => cleanSettings({ ...base, goals: [{ label: "", path: "/donate.html" }] }, pages), SettingsError);
    assert.throws(() => cleanSettings({ ...base, dailyCredits: DAILY_CREDITS.max + 1 }, pages), SettingsError);
    assert.throws(() => cleanSettings({ ...base, dailyCredits: 1.5 }, pages), SettingsError);
    assert.throws(
      () => cleanSettings({ ...base, goals: [{ label: "A", path: "/donate.html" }, { label: "B", path: "/donate.html" }] }, pages),
      SettingsError,
    );
  });

  it("falls back to the default tone", () => {
    assert.equal(cleanSettings({ ...base, tone: "angry" }, pages).tone, "friendly");
  });
});

describe("windowLimiter", () => {
  it("allows `limit` per window per key", () => {
    let now = 0;
    const limit = windowLimiter(2, 1000, { now: () => now });
    assert.equal(limit.take("a"), true);
    assert.equal(limit.take("a"), true);
    assert.equal(limit.take("a"), false);
    assert.equal(limit.take("b"), true);
    now = 1000;
    assert.equal(limit.take("a"), true);
    limit.sweep();
    assert.equal(limit.size, 1);
  });
});

describe("site knowledge", () => {
  it("reads the search index and ranks pages for a question", () => {
    const pages = indexPages([
      { title: "Opening hours", url: "/hours.html", description: "When we're open", text: "Monday to Friday" },
      { title: "Donate", url: "/donate.html", description: "Give monthly", text: "Your gift helps" },
      { title: "Bad", url: "javascript:alert(1)" },
    ]);
    assert.equal(pages.length, 2);
    assert.equal(relevantPages(pages, "how can I give a gift?", 1)[0].url, "/donate.html");
    assert.equal(relevantPages(pages, "when are you open", 1)[0].url, "/hours.html");
    assert.deepEqual(indexPages({}), []);
  });

  it("outcomes", () => {
    assert.equal(outcomeOf("accepted"), "accepted");
    assert.equal(outcomeOf("hacked"), null);
  });
});
