"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { confirmModal } from "@/lib/confirm";
import { FEATURE_VIDEOS } from "@/lib/feature-videos";
import { FeatureDemo, STEP_DEMOS } from "./FeatureDemo";
import { useSite, type SiteSection } from "./site-context";

// "Learn the features": a screen of its own in the menu (`LearnPanel`, section "learn") listing
// every feature by chapter, one chapter per screen, each with a looping demo (FeatureDemo.tsx), an
// optional video (lib/feature-videos.ts) and "Try it". A chapter can be walked through in one go
// (a guided run: each step's helper in turn, moving on by itself), and finishing one earns its
// badge, with confetti. Most steps ask the owner to really do the thing on their
// own site: "Try it" opens that screen and `FeatureGuide` rings what to press, with a small helper
// saying what to do. Steps tick themselves off from an action the editor reports with
// `noteFeature`, or a screen opened while it's the step being tried (`noteScreen`, from
// SiteManager's showSection); the rest are "read" steps with "Got it". Nothing here changes the
// site by itself, and no step asks the owner to publish or spend credits beyond one message to the
// AI. What's been tried is kept per site, in this browser.

export type FeatureAction =
  | "edit-text"
  | "preview-page"
  | "ask-section"
  | "try-links"
  | "phone"
  | "full-size"
  | "todo"
  | "ai"
  | "ai-attach"
  | "chat-panel"
  | "page-add"
  | "page-open"
  | "page-on-site"
  | "find"
  | "details-tab"
  | "versions";

const TRIED_EVENT = "twinstack:feature-tried";
const SCREEN_EVENT = "twinstack:feature-screen";
const CHANGED_EVENT = "twinstack:features-changed";
const TRYING_EVENT = "twinstack:feature-trying";
const CELEBRATE_EVENT = "twinstack:feature-chapter-done";

/** Tells the guide the owner just did one of the hands-on steps (no-op when nobody's listening). */
export function noteFeature(action: FeatureAction) {
  window.dispatchEvent(new CustomEvent(TRIED_EVENT, { detail: action }));
}

/** Tells the guide a screen was opened (SiteManager's showSection). */
export function noteScreen(section: SiteSection) {
  window.dispatchEvent(new CustomEvent(SCREEN_EVENT, { detail: section }));
}

// One chapter per screen of the menu (named as there), plus the AI, which is on every screen.
type Chapter = "edit" | "ai" | "pages" | "design" | "details" | "domain" | "analytics" | "tools" | "publish";

const CHAPTERS: { id: Chapter; title: string }[] = [
  { id: "edit", title: "Edit site" },
  { id: "ai", title: "Chat with the AI" },
  { id: "pages", title: "Pages" },
  { id: "design", title: "Look & logo" },
  { id: "details", title: "Business info" },
  { id: "domain", title: "Your domain" },
  { id: "analytics", title: "Visitors" },
  { id: "tools", title: "More tools" },
  { id: "publish", title: "Publish" },
];

type Step = {
  id: string;
  chapter: Chapter;
  title: string;
  text: string;
  /** What to do, in a few words. Read steps have none: they end with "Got it". */
  todo?: string;
  /** The screen "Show me where" opens first. None: the owner presses the target themselves. */
  section?: SiteSection;
  /** The `data-tour` element(s) "Show me where" rings: the first one on screen. */
  target?: string[];
  /** Done when the owner does this, opens this screen, or presses "Got it". */
  done: { action: FeatureAction } | { visit: SiteSection } | "read";
  /** Only for owners who have this `data-tour` element (Visitors is the creator's alone). */
  requires?: string;
};

const MENU = (item: string) => [`nav-${item}`, "menu"];

const STEPS: Step[] = [
  // Edit your site
  {
    id: "edit-text",
    chapter: "edit",
    title: "Change some words",
    text: "Edit site shows your site as visitors see it, and you can type right on it. It isn't live until you publish.",
    todo: "Click any words on your site, change them, then press Enter. (Esc puts them back.)",
    section: "home",
    target: ["preview"],
    done: { action: "edit-text" },
  },
  {
    id: "preview-page",
    chapter: "edit",
    title: "Look at another page",
    text: "The preview starts on your homepage. Any page can be shown and edited the same way: the Page button above your site searches every page by its name or address.",
    todo: "Press the Page button above your site, type part of a page's name, and pick it.",
    section: "home",
    target: ["page-picker"],
    done: { action: "preview-page" },
  },
  {
    id: "ask-section",
    chapter: "edit",
    title: "Change a whole section",
    text: "For more than words (a new layout, more photos, a different order), point at a part of your page: an “Ask the AI to change this section” button appears. It starts the request for you to finish. Nothing is sent until you press Send.",
    todo: "Point at a section of your site and press its “Ask the AI…” button.",
    section: "home",
    target: ["preview"],
    done: { action: "ask-section" },
  },
  {
    id: "try-links",
    chapter: "edit",
    title: "Click around like a visitor",
    text: "While you're editing, clicks go to the words, so links and buttons don't open. Switch editing off to try them, and back on with “Edit words”.",
    todo: "Press “Stop editing to try links”.",
    section: "home",
    target: ["try-links"],
    done: { action: "try-links" },
  },
  {
    id: "phone",
    chapter: "edit",
    title: "See it on a phone",
    text: "Most visitors use a phone. Your site rearranges itself for small screens; check it here any time.",
    todo: "Press Phone above your site.",
    section: "home",
    target: ["sizes"],
    done: { action: "phone" },
  },
  {
    id: "full-size",
    chapter: "edit",
    title: "Open it full size",
    text: "Opens the page in a tab of its own, with all your latest changes, even ones that aren't live yet.",
    todo: "Press “Open full size ↗”.",
    section: "home",
    target: ["full-size"],
    done: { action: "full-size" },
  },
  {
    id: "todo",
    chapter: "edit",
    title: "Your to-do list",
    text: "What's left before your site is ready to share, worked out from your site: add your phone number, replace sample reviews, write a page… Each has a button, and ticks itself off.",
    todo: "Press “… things left before you share your site”.",
    section: "home",
    target: ["steps"],
    done: { action: "todo" },
  },

  // The AI helper
  {
    id: "ai",
    chapter: "ai",
    title: "Ask the AI",
    text: "Tell it what you want in your own words: “Add a Contact page with our email and phone”, “Make the homepage friendlier”. It can also answer how to do things here. Each request uses a few credits.",
    todo: "Send it a message, e.g. “What should I do next to finish my site?”",
    target: ["ai-bar", "chat-panel"],
    done: { action: "ai" },
  },
  {
    id: "ai-attach",
    chapter: "ai",
    title: "Give it files",
    text: "Attach photos to put on a page, a menu or price list to type up, or a screenshot of a design you like for it to copy. Up to 20 at a time.",
    todo: "Press + in the AI box and pick a file. You don't have to send it.",
    target: ["ai-bar", "chat-panel"],
    done: { action: "ai-attach" },
  },
  {
    id: "chat-panel",
    chapter: "ai",
    title: "The full chat",
    text: "Your whole conversation, past conversations, and the “Make changes automatically” switch: on, the AI's changes are made as it goes; off, you check and approve each one.",
    todo: "Press “Chat with the AI” at the top.",
    target: ["chat"],
    done: { action: "chat-panel" },
  },
  {
    id: "pictures",
    chapter: "ai",
    title: "Pictures and logos",
    text: "No photos yet? Ask for one: “Make a picture of a cosy café for the top of the homepage”. It can draw a simple logo and tab icon too.",
    target: ["ai-bar", "chat-panel"],
    done: "read",
  },

  // Pages
  {
    id: "pages",
    chapter: "pages",
    title: "All your pages",
    text: "Every page of your site in one list, the homepage first, with a search box at the top to find one by its title or address.",
    todo: "Open Pages in the menu.",
    target: MENU("pages"),
    done: { visit: "pages" },
  },
  {
    id: "page-add",
    chapter: "pages",
    title: "Add a page",
    text: "Three ways: write it yourself, give the AI a few notes and it writes the page, or bring one in from your old website. Regular pages, blog posts, services and products.",
    todo: "Press “+ Add a page” to see the choices. You can close it without adding one.",
    section: "pages",
    target: ["add-page"],
    done: { action: "page-add" },
  },
  {
    id: "page-open",
    chapter: "pages",
    title: "Edit a whole page",
    text: "Write the page's words yourself, or tell the AI what to change and see it before you keep it. Its “Search and sharing” tab sets how it looks on Google.",
    todo: "Press “Edit page” on any page.",
    section: "pages",
    target: ["screen"],
    done: { action: "page-open" },
  },
  {
    id: "page-menu",
    chapter: "pages",
    title: "Menu, hide, delete",
    text: "The ⋯ beside each page puts it in your menu or takes it out, hides it from visitors while you work on it, or deletes it. Pages nothing links to are pointed out, with a fix.",
    section: "pages",
    target: ["screen"],
    done: "read",
  },
  {
    id: "page-on-site",
    chapter: "pages",
    title: "Jump to it on your site",
    text: "Shows the page on Edit site, ready to type on.",
    todo: "Press “Edit on site” on a page.",
    section: "pages",
    target: ["page-on-site"],
    done: { action: "page-on-site" },
  },
  {
    id: "find",
    chapter: "pages",
    title: "Find any page",
    text: "Type part of a page's name to open it, from any screen.",
    todo: "Press “Find a page” in the menu, or Ctrl K.",
    target: ["find", "menu"],
    done: { action: "find" },
  },

  // Look & logo
  {
    id: "design",
    chapter: "design",
    title: "How your site looks",
    text: "Everything here shows on every page at once.",
    todo: "Open Look & logo in the menu.",
    target: MENU("design"),
    done: { visit: "design" },
  },
  {
    id: "brand",
    chapter: "design",
    title: "Logo and tab icon",
    text: "Upload your logo (and a light one for dark headers) and the little icon in the browser tab. No logo? Your name shows with a simple mark.",
    section: "design",
    target: ["brand"],
    done: "read",
  },
  {
    id: "header-footer",
    chapter: "design",
    title: "Header and footer",
    text: "Colours, the menu's links and order, the button at the top (book, call, contact), sticky on scroll, and the footer's columns, contact details and social links, with a live preview. Or ask the AI to design a new pair.",
    section: "design",
    target: ["header-footer"],
    done: "read",
  },

  // Business info
  {
    id: "details",
    chapter: "details",
    title: "Your business details",
    text: "Change them once and every page that shows them updates.",
    todo: "Open Business info in the menu.",
    target: MENU("details"),
    done: { visit: "details" },
  },
  {
    id: "details-tab",
    chapter: "details",
    title: "Contact, social, reviews, FAQ",
    text: "About, Contact (phone, email, address, opening hours, booking link), Social media, Customer reviews and Questions & answers, each on its own tab.",
    todo: "Open another tab, like Contact.",
    section: "details",
    target: ["screen"],
    done: { action: "details-tab" },
  },

  // Get found
  {
    id: "seo",
    chapter: "tools",
    title: "Found on Google",
    text: "How every page shows up in Google and when shared, with a score out of 100. Fix one page, or let the AI write the search text for all of them.",
    todo: "Open Google & sharing in More tools.",
    section: "more",
    target: ["tool-seo"],
    done: { visit: "seo" },
  },
  {
    id: "domain",
    chapter: "domain",
    title: "Your own web address",
    text: "Your site already has a free address that works today. If you own a domain name, like www.yourbusiness.com, you can use it instead.",
    todo: "Open Your domain in the menu.",
    target: MENU("domain"),
    done: { visit: "domain" },
  },
  {
    id: "domain-how",
    chapter: "domain",
    title: "How connecting works",
    text: "Type your domain and save. The screen then lists the exact records to add where you bought it (GoDaddy, Namecheap…), checks them for you, and turns on the secure padlock (HTTPS) once they work. It can take up to a day to start working.",
    section: "domain",
    target: ["screen"],
    done: "read",
  },
  {
    id: "analytics",
    chapter: "analytics",
    title: "Who visits",
    text: "How many people visit, day by day, which pages they read, where they come from and on which devices. Only you can see it. Turn counting on once, then publish.",
    todo: "Open Visitors in the menu.",
    target: MENU("analytics"),
    done: { visit: "analytics" },
    requires: "nav-analytics",
  },
  {
    id: "analytics-more",
    chapter: "analytics",
    title: "Dig into the numbers",
    text: "Pick a period, click any row (a page, a source, a device) to see only those visitors, and see clicks on your phone number and email. Download it all as a PDF report or a spreadsheet.",
    section: "analytics",
    target: ["screen"],
    done: "read",
    requires: "nav-analytics",
  },

  // More tools
  {
    id: "schedule",
    chapter: "tools",
    title: "Planned posts",
    text: "Plan blog posts or pages ahead, and the AI writes each one on the date you choose.",
    todo: "Open Planned posts in More tools.",
    section: "more",
    target: ["tool-schedule"],
    done: { visit: "schedule" },
  },
  {
    id: "files",
    chapter: "tools",
    title: "Files",
    text: "Add PDFs and other files, like a printable menu or price list, and link to them from any page.",
    todo: "Open Files in More tools.",
    section: "more",
    target: ["tool-files"],
    done: { visit: "files" },
  },
  {
    id: "memory",
    chapter: "tools",
    title: "AI notes about your site",
    text: "Standing notes the AI always follows, like “write in British English”, and a work log of every change, yours and the AI's, so it builds on your edits instead of undoing them.",
    todo: "Open AI notes about your site in More tools.",
    section: "more",
    target: ["tool-memory"],
    done: { visit: "memory" },
  },
  {
    id: "styles",
    chapter: "tools",
    title: "Custom code",
    text: "Add Google Analytics, a chat widget or another service's code, on every page or only some.",
    todo: "Open Custom code in More tools.",
    section: "more",
    target: ["tool-styles"],
    done: { visit: "styles" },
  },
  {
    id: "models",
    chapter: "tools",
    title: "AI settings",
    text: "Which AI models write your pages and make your pictures. Most owners never change this.",
    todo: "Open AI settings in More tools.",
    section: "more",
    target: ["tool-models"],
    done: { visit: "models" },
  },
  {
    id: "log",
    chapter: "tools",
    title: "Technical log",
    text: "What happened, step by step, when something didn't work. Handy if you ever ask for help.",
    todo: "Open Technical log in More tools.",
    section: "more",
    target: ["tool-tools"],
    done: { visit: "tools" },
  },

  // Publish
  {
    id: "publish",
    chapter: "publish",
    title: "What's changed",
    text: "Every change since you last published, in plain words. The label beside Publish says how many aren't live yet.",
    todo: "Press the label beside Publish.",
    target: ["changes"],
    done: { visit: "publish" },
  },
  {
    id: "undo",
    chapter: "publish",
    title: "Undo what you don't want",
    text: "Each change on What's changed can be undone before it goes live. Problems that would stop your site updating, like a broken link, are listed with a fix.",
    section: "publish",
    target: ["screen"],
    done: "read",
  },
  {
    id: "versions",
    chapter: "publish",
    title: "Earlier versions",
    text: "Go back to one of your last 5 published versions. It comes back as changes you check, then publish.",
    todo: "Open Earlier versions in More tools.",
    section: "more",
    target: ["tool-versions"],
    done: { action: "versions" },
  },
  {
    id: "publish-button",
    chapter: "publish",
    title: "Publish",
    text: "When you're happy, press Publish: your live site updates for everyone in a minute or two. Want someone to check first? Use “Send for review” under More options on What's changed.",
    target: ["publish"],
    done: "read",
  },
  {
    id: "updates",
    chapter: "publish",
    title: "Site updates and credits",
    text: "New builder features reach your site by themselves, without touching your pages or design; a banner tells you, with Undo. The AI runs on credits: your balance is at the top, and the Credits page shows what each request used.",
    done: "read",
  },
];

// ——— Badges: one per chapter, for finishing it ———

const BADGES: Record<Chapter, { icon: string; name: string }> = {
  edit: { icon: "✏️", name: "Quick editor" },
  ai: { icon: "✨", name: "AI whisperer" },
  pages: { icon: "📄", name: "Page pro" },
  design: { icon: "🎨", name: "Design whiz" },
  details: { icon: "📇", name: "Detail keeper" },
  domain: { icon: "🌐", name: "Address owner" },
  analytics: { icon: "📈", name: "Number cruncher" },
  tools: { icon: "🧰", name: "Toolbox master" },
  publish: { icon: "🚀", name: "Publisher" },
};

const btn = "cursor-pointer disabled:cursor-default";

// ——— What's been tried, kept in localStorage and shared by the screen, the helper and the menu ———

function storageKey(owner: string, repo: string) {
  return `twinstack:features-tried:${owner}/${repo}`;
}

/** The stored JSON list of step ids; "[]" when storage is empty or blocked. */
function readStored(owner: string, repo: string): string {
  try {
    return localStorage.getItem(storageKey(owner, repo)) ?? "[]";
  } catch {
    return "[]";
  }
}

function parseTried(raw: string): string[] {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function subscribeTried(onChange: () => void) {
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function useTried(owner: string, repo: string): string[] {
  const raw = useSyncExternalStore(
    subscribeTried,
    () => readStored(owner, repo),
    () => "[]",
  );
  return useMemo(() => parseTried(raw), [raw]);
}

type Celebration = { chapter: Chapter; all: boolean };

/**
 * Saves a step as tried; false when it already was. When that finishes its chapter (of `steps`,
 * the ones this owner has), the celebration is announced.
 */
function saveTried(owner: string, repo: string, id: string, steps: Step[]) {
  const list = parseTried(readStored(owner, repo));
  if (list.includes(id)) return false;
  const next = [...list, id];
  try {
    localStorage.setItem(storageKey(owner, repo), JSON.stringify(next));
  } catch {
    // Storage blocked: nothing is kept, so nothing ticks. Harmless.
    return false;
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
  const chapter = steps.find((s) => s.id === id)?.chapter;
  if (chapter && steps.filter((s) => s.chapter === chapter).every((s) => next.includes(s.id))) {
    const detail: Celebration = { chapter, all: steps.every((s) => next.includes(s.id)) };
    window.dispatchEvent(new CustomEvent(CELEBRATE_EVENT, { detail }));
  }
  return true;
}

/** Clears every tick on this site (the Learn screen's "Start over"). */
function resetTried(owner: string, repo: string) {
  try {
    localStorage.removeItem(storageKey(owner, repo));
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** The steps this owner has (Visitors is the creator's alone). */
function useSteps(isCreator: boolean) {
  return useMemo(() => STEPS.filter((s) => s.requires !== "nav-analytics" || isCreator), [isCreator]);
}

/** How many steps the owner has tried on this site, and of how many, for the menu's badge. */
export function useFeatureProgress(isCreator: boolean) {
  const { owner, repo } = useSite();
  const steps = useSteps(isCreator);
  const tried = useTried(owner, repo);
  return { done: steps.filter((s) => tried.includes(s.id)).length, total: steps.length };
}

function chapterDone(chapter: Chapter, steps: Step[], tried: string[]) {
  const these = steps.filter((s) => s.chapter === chapter);
  return these.length > 0 && these.every((s) => tried.includes(s.id));
}

// ——— What's being tried: one step ("Try it"), or a whole chapter in turn (a guided run) ———

type Run = { chapter: Chapter; skipped: string[] };
type GuideState = { trying: string | null; run: Run | null };

const IDLE: GuideState = { trying: null, run: null };
let guide: GuideState = IDLE;

function setGuide(next: Partial<GuideState>) {
  guide = { ...guide, ...next };
  window.dispatchEvent(new Event(TRYING_EVENT));
}

function subscribeGuide(onChange: () => void) {
  window.addEventListener(TRYING_EVENT, onChange);
  return () => window.removeEventListener(TRYING_EVENT, onChange);
}

function useGuide() {
  return useSyncExternalStore(
    subscribeGuide,
    () => guide,
    () => IDLE,
  );
}

/** The run's next step: not done, not skipped. */
function nextInRun(run: Run, steps: Step[], tried: string[]) {
  return steps.find((s) => s.chapter === run.chapter && !tried.includes(s.id) && !run.skipped.includes(s.id)) ?? null;
}

// ——— Finding what a step points at ———

function visibleTarget(names: string[]): HTMLElement | null {
  for (const name of names) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
      if (el.closest("[inert]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

type Box = { top: number; left: number; width: number; height: number };

function boxOf(el: HTMLElement | null): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function sameBox(a: Box | null, b: Box | null) {
  return a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);
}

/** Where the target and the open chat panel are, kept up to date as the screen moves. */
function useLayout(target: string[] | null) {
  const [layout, setLayout] = useState<{ target: Box | null; panel: Box | null }>({ target: null, panel: null });
  const key = target?.join(" ") ?? "";
  useLayoutEffect(() => {
    const names = key ? key.split(" ") : [];
    const measure = () => {
      const next = { target: names.length ? boxOf(visibleTarget(names)) : null, panel: boxOf(visibleTarget(["chat-panel"])) };
      setLayout((prev) => (sameBox(prev.target, next.target) && sameBox(prev.panel, next.panel) ? prev : next));
    };
    measure();
    const timer = window.setInterval(measure, 300);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [key]);
  return layout;
}

const HINT_WIDTH = 340;

/**
 * Where the "Try it" helper goes: away from what it points at and clear of the chat panel.
 * Bottom-right by default (the menu is on the left); bottom-left when the target is on the right;
 * full width at the bottom on phones.
 */
function hintPlace(target: Box | null, panel: Box | null): React.CSSProperties {
  if (typeof window === "undefined") return { right: 16, bottom: 16 };
  const vw = window.innerWidth;
  if (vw < 640) return { left: 8, right: 8, bottom: 8 };
  const rightEdge = panel ? vw - panel.left + 16 : 16;
  const targetOnRight = target && target.left + target.width / 2 > vw * 0.55;
  if (targetOnRight || vw - rightEdge - HINT_WIDTH < 16) return { left: 16, bottom: 16, width: HINT_WIDTH };
  return { right: rightEdge, bottom: 16, width: HINT_WIDTH };
}

/** Starting one step, or a chapter's guided run. */
function useStartTrying() {
  const { showSection } = useSite();
  const tryStep = useCallback(
    (step: Step) => {
      setGuide({ trying: step.id });
      // No screen of its own: it's in the menu, the top bar or the AI box, all on every screen.
      // Edit site then, so the Learn screen doesn't sit under the helper.
      showSection(step.section ?? "home");
      if (step.target) window.setTimeout(() => visibleTarget(step.target!)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
    },
    [showSection],
  );
  const startRun = useCallback(
    (chapter: Chapter, steps: Step[], tried: string[]) => {
      const run: Run = { chapter, skipped: [] };
      const first = nextInRun(run, steps, tried);
      if (!first) return;
      setGuide({ run });
      tryStep(first);
    },
    [tryStep],
  );
  /** One step alone: ends any run. */
  const tryOne = useCallback(
    (step: Step) => {
      setGuide({ run: null });
      tryStep(step);
    },
    [tryStep],
  );
  return { tryStep, tryOne, startRun };
}

// ——— The Learn screen ———

/** The "Learn the features" screen: every feature by chapter, with demos, videos and "Try it". */
export function LearnPanel({ isCreator }: { isCreator: boolean }) {
  const { owner, repo } = useSite();
  const steps = useSteps(isCreator);
  const tried = useTried(owner, repo);
  const { tryOne, startRun } = useStartTrying();
  const doneCount = steps.filter((s) => tried.includes(s.id)).length;
  const all = doneCount === steps.length;
  const chapters = CHAPTERS.filter((c) => steps.some((s) => s.chapter === c.id));
  const firstOpen = chapters.find((c) => !chapterDone(c.id, steps, tried))?.id ?? chapters[0].id;
  const [picked, setPicked] = useState<Chapter | null>(null);
  const chapter = picked ?? firstOpen;
  const inChapter = steps.filter((s) => s.chapter === chapter);
  const left = inChapter.filter((s) => !tried.includes(s.id)).length;
  const chapterIndex = chapters.findIndex((c) => c.id === chapter);
  const nextChapter = chapters[chapterIndex + 1];
  const badge = BADGES[chapter];

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Learn the features</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Everything the builder can do, screen by screen. Watch the demo, then press <span className="font-medium text-foreground">Try it</span> to do it for real on your own site.
            </p>
          </div>
          {!all && (
            <button
              type="button"
              onClick={() => startRun(firstOpen, steps, tried)}
              className={`${btn} h-10 shrink-0 rounded-xl bg-indigo-700 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-800`}
            >
              {doneCount ? "▶ Continue where you left off" : "▶ Start the guided tour"}
            </button>
          )}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <span className="shrink-0 text-sm text-zinc-600 dark:text-zinc-400">{all ? "All done 🎉" : `${doneCount} of ${steps.length} tried`}</span>
          {doneCount > 0 && (
            <button
              type="button"
              onClick={async () => {
                const ok = await confirmModal("Every feature goes back to not tried, and your badges are taken off, so you can work through them again. Your site isn't changed.", {
                  title: "Start over?",
                  confirmLabel: "Start over",
                });
                if (!ok) return;
                resetTried(owner, repo);
                setPicked(null);
              }}
              className={`${btn} shrink-0 text-sm text-zinc-500 hover:text-foreground hover:underline`}
            >
              Start over
            </button>
          )}
        </div>

        {/* Badges: one per chapter, lit once it's finished */}
        <ul aria-label="Your badges" className="mt-4 flex flex-wrap gap-2">
          {chapters.map((c) => {
            const earned = chapterDone(c.id, steps, tried);
            const b = BADGES[c.id];
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setPicked(c.id)}
                  title={earned ? `${b.name}: you finished ${c.title}` : `Finish ${c.title} to earn “${b.name}”`}
                  className={`${btn} flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                    earned
                      ? "border-amber-300 bg-gradient-to-r from-amber-50 to-yellow-100 text-amber-900 shadow-sm dark:border-amber-700 dark:from-amber-950 dark:to-yellow-950 dark:text-amber-100"
                      : "border-dashed border-zinc-300 text-zinc-400 hover:border-zinc-400 dark:border-zinc-700"
                  }`}
                >
                  <span className={earned ? "" : "opacity-40 grayscale"} aria-hidden>
                    {b.icon}
                  </span>
                  {b.name}
                  <span className="sr-only">{earned ? "(earned)" : "(not earned yet)"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {all && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-amber-300 bg-gradient-to-r from-amber-50 via-yellow-50 to-emerald-50 p-5 dark:border-amber-800 dark:from-amber-950/60 dark:via-yellow-950/40 dark:to-emerald-950/40">
          <span className="text-4xl" aria-hidden>
            🏆
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Builder expert</p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">You&apos;ve tried every feature. Anything you forget is still here, with its demo.</p>
          </div>
        </div>
      )}

      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        {/* Chapters: one per screen of the menu */}
        <nav aria-label="Chapters" className="mb-5 lg:sticky lg:top-4 lg:mb-0 lg:self-start">
          {/* Every row the same shape: progress ring, title, count; the badge row above shows the emoji. */}
          <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:rounded-2xl lg:border lg:border-zinc-200 lg:p-1.5 lg:pb-1.5 dark:lg:border-zinc-800">
            {chapters.map((c) => {
              const these = steps.filter((s) => s.chapter === c.id);
              const done = these.filter((s) => tried.includes(s.id)).length;
              const complete = done === these.length;
              const active = c.id === chapter;
              return (
                <li key={c.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setPicked(c.id)}
                    aria-current={active ? "page" : undefined}
                    title={complete ? `Finished: ${BADGES[c.id].name}` : undefined}
                    className={`${btn} flex h-10 w-full items-center gap-2.5 whitespace-nowrap rounded-xl border px-2.5 text-left text-sm transition-colors lg:border-transparent ${
                      active
                        ? "border-indigo-200 bg-indigo-50 font-semibold text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100"
                        : "border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    }`}
                  >
                    <ProgressRing done={done} total={these.length} />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className={`w-8 shrink-0 text-right text-xs tabular-nums ${complete ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}`}>
                      {done}/{these.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* The chapter's features */}
        <section aria-labelledby="learn-chapter" className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id="learn-chapter" className="flex-1 text-lg font-semibold">
              {chapters[chapterIndex].title}
            </h3>
            {left > 0 ? (
              <button
                type="button"
                onClick={() => startRun(chapter, steps, tried)}
                className={`${btn} h-9 rounded-lg border border-indigo-300 bg-indigo-50 px-3 text-sm font-semibold text-indigo-800 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200 dark:hover:bg-indigo-900`}
              >
                ▶ {left === inChapter.length ? "Walk me through this" : `Walk me through the ${left} left`}
              </button>
            ) : (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                {badge.icon} {badge.name}
              </span>
            )}
          </div>
          <ol className="mt-3 space-y-3">
            {inChapter.map((step, i) => (
              <FeatureCard
                key={step.id}
                step={step}
                number={i + 1}
                done={tried.includes(step.id)}
                onTry={() => tryOne(step)}
                onGotIt={() => saveTried(owner, repo, step.id, steps)}
              />
            ))}
          </ol>
          {nextChapter && (
            <button type="button" onClick={() => setPicked(nextChapter.id)} className={`${btn} mt-4 text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300`}>
              Next: {nextChapter.title} →
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function FeatureCard({ step, number, done, onTry, onGotIt }: { step: Step; number: number; done: boolean; onTry: () => void; onGotIt: () => void }) {
  const video = FEATURE_VIDEOS[step.id];
  const demo = STEP_DEMOS[step.id];
  const [playing, setPlaying] = useState(false);
  const read = step.done === "read";
  return (
    <li
      className={`grid gap-4 rounded-2xl border p-4 transition-colors sm:p-5 md:grid-cols-[minmax(0,1fr)_15rem] ${
        done ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20" : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <div className="flex min-w-0 gap-3">
        <span
          aria-hidden
          className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors ${
            done ? "bg-emerald-500 text-white" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          }`}
        >
          {done ? "✓" : number}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold">
            {step.title}
            {done && <span className="sr-only"> (tried)</span>}
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{step.text}</p>
          {step.todo && !done && <p className="mt-2 text-sm font-medium text-indigo-900 dark:text-indigo-200">👉 {step.todo}</p>}

          {video && playing && (
            <div className="mt-3 aspect-video max-w-xl overflow-hidden rounded-xl bg-black">
              <VideoFrame url={video} title={step.title} />
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {video && (
              <button
                type="button"
                onClick={() => setPlaying(!playing)}
                className={`${btn} h-9 rounded-lg border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`}
              >
                {playing ? "Hide the video" : "▶ Watch"}
              </button>
            )}
            {step.target && (
              <button
                type="button"
                onClick={onTry}
                className={`${btn} h-9 rounded-lg px-3 text-sm font-semibold ${
                  done || read ? "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900" : "bg-indigo-700 text-white hover:bg-indigo-800"
                }`}
              >
                {read ? "Show me where" : done ? "Try it again" : "Try it"}
              </button>
            )}
            {/* Every step can be ticked by hand: an owner who already knows a feature needn't try it. */}
            {!done && (
              <button
                type="button"
                onClick={onGotIt}
                title={read ? undefined : "Already know this one? Tick it off without trying it"}
                className={`${btn} h-9 rounded-lg px-3 text-sm font-semibold ${
                  read
                    ? "bg-indigo-700 text-white hover:bg-indigo-800"
                    : "border border-indigo-300 text-indigo-800 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-200 dark:hover:bg-indigo-950"
                }`}
              >
                Got it ✓
              </button>
            )}
          </div>
        </div>
      </div>
      {demo && <FeatureDemo kind={demo} label={step.title} />}
    </li>
  );
}

// ——— The "Try it" helper and celebrations, over the other screens ———

/**
 * Mounted once by SiteManager. Ticks steps off as the owner does them (actions any time; a screen
 * opened only while that's the step being tried); while a step is being tried, rings its target
 * with a small helper saying what to do; in a guided run, moves on to the chapter's next step by
 * itself; and celebrates each finished chapter.
 */
export function FeatureGuide({ section, isCreator }: { section: SiteSection; isCreator: boolean }) {
  const { owner, repo, showSection } = useSite();
  const steps = useSteps(isCreator);
  const tried = useTried(owner, repo);
  const { trying, run } = useGuide();
  const { tryStep, tryOne, startRun } = useStartTrying();
  const [party, setParty] = useState<Celebration | null>(null);
  const step = STEPS.find((s) => s.id === trying) ?? null;

  useEffect(() => {
    const onTried = (e: Event) => {
      const action = (e as CustomEvent<FeatureAction>).detail;
      for (const s of steps) if (typeof s.done === "object" && "action" in s.done && s.done.action === action) saveTried(owner, repo, s.id, steps);
    };
    const onScreen = (e: Event) => {
      const screen = (e as CustomEvent<SiteSection>).detail;
      // Back on the Learn screen: nothing is being tried any more.
      if (screen === "learn") return setGuide(IDLE);
      const current = STEPS.find((s) => s.id === guide.trying);
      if (current && typeof current.done === "object" && "visit" in current.done && current.done.visit === screen) saveTried(owner, repo, current.id, steps);
    };
    const onCelebrate = (e: Event) => {
      const detail = (e as CustomEvent<Celebration>).detail;
      setParty(detail);
      confetti();
    };
    window.addEventListener(TRIED_EVENT, onTried);
    window.addEventListener(SCREEN_EVENT, onScreen);
    window.addEventListener(CELEBRATE_EVENT, onCelebrate);
    return () => {
      window.removeEventListener(TRIED_EVENT, onTried);
      window.removeEventListener(SCREEN_EVENT, onScreen);
      window.removeEventListener(CELEBRATE_EVENT, onCelebrate);
    };
  }, [owner, repo, steps]);

  const done = step ? tried.includes(step.id) : false;

  // A guided run moves on by itself, a moment after each step is done.
  useEffect(() => {
    if (!run || !step || !done) return;
    const timer = window.setTimeout(() => {
      const next = nextInRun(run, steps, parseTried(readStored(owner, repo)));
      if (next) tryStep(next);
      else {
        setGuide(IDLE);
        showSection("learn");
      }
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [run, step, done, steps, owner, repo, tryStep, showSection]);

  const active = Boolean(step) && section !== "learn";
  const layout = useLayout(active && !done && step?.target ? step.target : null);

  const celebration = party && (
    <CelebrationCard
      party={party}
      steps={steps}
      tried={tried}
      onClose={() => setParty(null)}
      onNext={(chapter) => {
        setParty(null);
        startRun(chapter, steps, tried);
      }}
      onLearn={() => {
        setParty(null);
        setGuide(IDLE);
        showSection("learn");
      }}
    />
  );

  if (!active || !step) return celebration ? createPortal(celebration, document.body) : null;

  const read = step.done === "read";
  const lost = !done && step.target && !layout.target;
  const runSteps = run ? steps.filter((s) => s.chapter === run.chapter) : [];
  const runAt = runSteps.findIndex((s) => s.id === step.id);
  const single = [...steps.slice(steps.indexOf(step) + 1), ...steps.slice(0, steps.indexOf(step))].find((s) => !tried.includes(s.id));

  function skip() {
    if (!run || !step) return;
    const nextRun = { ...run, skipped: [...run.skipped, step.id] };
    const next = nextInRun(nextRun, steps, tried);
    if (next) {
      setGuide({ run: nextRun });
      tryStep(next);
    } else {
      setGuide(IDLE);
      showSection("learn");
    }
  }

  return createPortal(
    <>
      {!done && layout.target && <Ring box={layout.target} />}
      <aside
        aria-label="Trying a feature"
        aria-live="polite"
        className="fixed z-50 rounded-2xl bg-background p-4 shadow-2xl ring-1 ring-black/10 transition-[left,right] duration-300 dark:ring-white/10"
        style={hintPlace(layout.target, layout.panel)}
      >
        {run && (
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
              {CHAPTERS.find((c) => c.id === run.chapter)?.title} · {runAt + 1} of {runSteps.length}
            </span>
            <span className="flex flex-1 justify-end gap-1" aria-hidden>
              {runSteps.map((s, i) => (
                <span
                  key={s.id}
                  className={`h-1.5 rounded-full transition-all ${
                    tried.includes(s.id) ? "w-1.5 bg-emerald-500" : i === runAt ? "w-4 bg-indigo-600" : run.skipped.includes(s.id) ? "w-1.5 bg-zinc-400" : "w-1.5 bg-zinc-200 dark:bg-zinc-700"
                  }`}
                />
              ))}
            </span>
          </div>
        )}
        {done ? (
          <>
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">✓ Nice, that&apos;s “{step.title}”!</p>
            {run ? (
              <p className="mt-1 text-xs text-zinc-500">Next one coming up…</p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {single && (
                  <button type="button" onClick={() => tryOne(single)} className={`${btn} h-8 rounded-lg bg-indigo-700 px-3 text-xs font-semibold text-white hover:bg-indigo-800`}>
                    Next: {single.title}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => showSection("learn")}
                  className={`${btn} h-8 rounded-lg border border-zinc-300 px-3 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`}
                >
                  Back to Learn the features
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <p className="flex-1 text-sm font-semibold">{step.title}</p>
              <button
                type="button"
                onClick={() => setGuide(IDLE)}
                aria-label={run ? "Stop the walk-through" : "Stop trying this"}
                title="Stop"
                className={`${btn} -mr-1 -mt-1 grid size-6 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900`}
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-sm">👉 {step.todo ?? step.text}</p>
            {lost && <p className="mt-1.5 text-xs text-zinc-500">Can&apos;t see it here? On a small screen, open the menu first.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => saveTried(owner, repo, step.id, steps)}
                className={`${btn} h-8 rounded-lg px-3 text-xs font-semibold ${
                  read ? "bg-indigo-700 text-white hover:bg-indigo-800" : "border border-indigo-300 text-indigo-800 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-200 dark:hover:bg-indigo-950"
                }`}
              >
                Got it ✓
              </button>
              {run && (
                <button type="button" onClick={skip} className={`${btn} h-8 rounded-lg px-2 text-xs font-medium text-zinc-500 hover:text-foreground hover:underline`}>
                  Skip
                </button>
              )}
              <button
                type="button"
                onClick={() => showSection("learn")}
                className={`${btn} ml-auto h-8 rounded-lg border border-zinc-300 px-3 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`}
              >
                ← Learn
              </button>
            </div>
          </>
        )}
      </aside>
      {celebration}
    </>,
    document.body,
  );
}

/** A finished chapter: its badge, and where to go next. The whole lot: the final award. */
function CelebrationCard({
  party,
  steps,
  tried,
  onClose,
  onNext,
  onLearn,
}: {
  party: Celebration;
  steps: Step[];
  tried: string[];
  onClose: () => void;
  onNext: (chapter: Chapter) => void;
  onLearn: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const badge = BADGES[party.chapter];
  const title = CHAPTERS.find((c) => c.id === party.chapter)?.title;
  const next = CHAPTERS.find((c) => !chapterDone(c.id, steps, tried) && steps.some((s) => s.chapter === c.id));
  const earned = CHAPTERS.filter((c) => chapterDone(c.id, steps, tried)).length;
  const total = CHAPTERS.filter((c) => steps.some((s) => s.chapter === c.id)).length;
  return (
    <div className="fixed inset-0 z-[75] grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={party.all ? "You've tried every feature" : `Chapter finished: ${title}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-3xl bg-background p-6 text-center shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
      >
        <div className="mx-auto grid size-20 animate-bounce place-items-center rounded-full bg-gradient-to-br from-amber-100 to-yellow-200 text-4xl shadow-inner motion-reduce:animate-none dark:from-amber-900 dark:to-yellow-800">
          {party.all ? "🏆" : badge.icon}
        </div>
        <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">{party.all ? "Every feature tried" : "Chapter finished"}</p>
        <h2 className="mt-1 text-xl font-bold">{party.all ? "Builder expert!" : `You're a ${badge.name}!`}</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {party.all
            ? "You know your way round the whole builder. Your site's to-do list on Edit site says what's left before you share it."
            : `That's everything on ${title}. ${earned} of ${total} badges earned.`}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          {!party.all && next && (
            <button type="button" onClick={() => onNext(next.id)} className={`${btn} h-10 rounded-xl bg-indigo-700 px-4 text-sm font-semibold text-white hover:bg-indigo-800`}>
              ▶ Next: {next.title}
            </button>
          )}
          <button type="button" onClick={onLearn} className={`${btn} h-10 rounded-xl border border-zinc-300 px-4 text-sm font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`}>
            Back to Learn the features
          </button>
          <button type="button" onClick={onClose} className={`${btn} text-sm text-zinc-500 hover:text-foreground hover:underline`}>
            Keep going on my own
          </button>
        </div>
      </div>
    </div>
  );
}

/** A short burst of confetti from the top of the window. Nothing for people who prefer less motion. */
function confetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:80;overflow:hidden";
  document.body.appendChild(layer);
  const colors = ["#4f46e5", "#10b981", "#f59e0b", "#e11d48", "#0ea5e9", "#a855f7"];
  for (let i = 0; i < 90; i++) {
    const piece = document.createElement("div");
    const size = 6 + Math.random() * 6;
    piece.style.cssText = `position:absolute;top:-12px;left:${Math.random() * 100}%;width:${size}px;height:${size * 0.45}px;background:${colors[i % colors.length]};border-radius:2px`;
    layer.appendChild(piece);
    const drift = (Math.random() - 0.5) * 240;
    piece.animate(
      [
        { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
        { transform: `translate(${drift}px, ${window.innerHeight * (0.6 + Math.random() * 0.5)}px) rotate(${Math.random() * 900 - 450}deg)`, opacity: 0 },
      ],
      { duration: 1600 + Math.random() * 1200, delay: Math.random() * 250, easing: "cubic-bezier(.15,.7,.3,1)", fill: "forwards" },
    );
  }
  window.setTimeout(() => layer.remove(), 3300);
}

/** How far through something is, as a small ring that fills; a green tick when it's all done. */
export function ProgressRing({ done, total, size = 18 }: { done: number; total: number; size?: number }) {
  const complete = total > 0 && done >= total;
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full [--track:#e4e4e7] dark:[--track:#3f3f46]"
      style={{ width: size, height: size, background: complete ? "#10b981" : `conic-gradient(#6366f1 ${pct}%, var(--track) 0)` }}
    >
      {complete ? (
        <span className="text-[10px] font-bold leading-none text-white">✓</span>
      ) : (
        <span className="rounded-full bg-background" style={{ width: size - 6, height: size - 6 }} />
      )}
    </span>
  );
}

/** A pulsing ring round the part of the screen a step is about. Clicks go straight through it. */
function Ring({ box }: { box: Box }) {
  const pad = 6;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-[45] animate-pulse rounded-xl ring-4 ring-indigo-500/70 motion-reduce:animate-none"
      style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
    />
  );
}

/** A YouTube or Vimeo link as its embeddable player address, else null (a plain video file). */
function embedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.slice(1);
    else if (host === "youtube.com" || host === "youtube-nocookie.com") id = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ?? null;
    if (id) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`;
    const vimeo = host === "vimeo.com" ? u.pathname.match(/^\/(\d+)/)?.[1] : host === "player.vimeo.com" ? u.pathname.match(/^\/video\/(\d+)/)?.[1] : null;
    if (vimeo) return `https://player.vimeo.com/video/${vimeo}?autoplay=1`;
  } catch {
    // Not a full address: a file the app serves, like /videos/files.mp4.
  }
  return null;
}

function VideoFrame({ url, title }: { url: string; title: string }) {
  const embed = embedUrl(url);
  return embed ? (
    <iframe src={embed} title={title} className="size-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
  ) : (
    <video src={url} controls autoPlay className="size-full" />
  );
}
