"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSite, type SiteSection } from "./site-context";

// A short first-visit tour of the editor: a few steps, each pointing at one part of the screen
// (an element marked `data-tour="<target>"`). Shown once per browser, after the setup questions
// are out of the way; the "?" button in the top bar starts it again (START_TOUR_EVENT).

const DONE_KEY = "twinstack:tour-done:v1";
export const START_TOUR_EVENT = "twinstack:start-tour";
/** Optional: a short video showing the whole editor, offered on the tour's first and last step. */
export const HELP_VIDEO_URL = process.env.NEXT_PUBLIC_HELP_VIDEO_URL ?? "";

type TourStepDef = {
  /** The `data-tour` element to point at. */
  target: string;
  title: string;
  text: string;
  /** The screen to open first. */
  section?: SiteSection;
  /** Shown only when this `data-tour` element exists (a screen not every owner has). */
  requires?: string;
  /** "corner": the card sits in the window's corner, beside a big target (a whole screen). */
  placement?: "corner";
  /** What the owner can do there, as a short list. */
  points?: string[];
};

const STEPS: TourStepDef[] = [
  {
    section: "home",
    target: "preview",
    title: "This is your website",
    text: "Edit site shows your site exactly as visitors will see it, and you can change it right here.",
    points: [
      "Click any words to rewrite them",
      "Click a link in it to go to that page",
      "Your changes save by themselves",
    ],
  },
  {
    section: "home",
    target: "sizes",
    title: "Check it on a phone",
    text: "Most visitors will see your site on a phone. Switch between Computer and Phone to check both, or open it full size in its own tab.",
  },
  {
    section: "home",
    target: "chat",
    title: "Your AI helper",
    text: "Tell it what you want in your own words, on any screen, and it does the work for you. For example:",
    points: [
      "“Add a gallery page with photos of our cakes”",
      "“Make the homepage friendlier and shorter”",
      "“Make a picture of a cosy café for the top of the page”",
      "Attach a photo, a menu or a screenshot of a design you like",
      "Ask how to do anything in the builder",
    ],
  },
  {
    section: "home",
    target: "steps",
    title: "Your to-do list",
    text: "What's left before your site is ready to share, with a button for each step. It ticks itself off as you go. Start here if you're not sure what to do.",
  },
  {
    section: "pages",
    target: "screen",
    placement: "corner",
    title: "Pages",
    text: "Every page of your site. Open one to change it, or add a new one in three ways:",
    points: [
      "Write it yourself",
      "Give the AI a few notes and it writes the page",
      "Bring in a page from your old website",
      "Choose which pages appear in the menu, hide or delete them",
    ],
  },
  {
    section: "design",
    target: "screen",
    placement: "corner",
    title: "Look & logo",
    text: "How your whole site looks.",
    points: ["Upload your logo and choose the tab icon", "Pick your colours", "Arrange the menu at the top and the footer at the bottom of every page"],
  },
  {
    section: "details",
    target: "screen",
    placement: "corner",
    title: "Business info",
    text: "Change it once here and it updates everywhere on your site.",
    points: ["Name, phone, email and address", "Opening hours and booking link", "Social media links", "Customer reviews and common questions (FAQ)"],
  },
  {
    section: "domain",
    target: "screen",
    placement: "corner",
    title: "Your domain",
    text: "Your site already has a free web address. Here you can use your own instead, like www.yourbusiness.com, with step-by-step instructions.",
  },
  {
    section: "analytics",
    requires: "nav-analytics",
    target: "screen",
    placement: "corner",
    title: "Visitors",
    text: "See how your site is doing.",
    points: ["How many people visit, day by day", "Which pages they look at", "Where they come from, and on which devices"],
  },
  {
    section: "more",
    target: "screen",
    placement: "corner",
    title: "More tools",
    text: "Extras you can use when you need them:",
    points: [
      "Google & sharing: how your pages look in Google search and when shared",
      "Planned posts: the AI writes new posts on the dates you choose",
      "Files: add PDFs such as a menu or price list",
      "Old web addresses: send visitors from your old site to the new pages",
      "Custom code: Google Analytics and other services",
    ],
  },
  {
    section: "publish",
    target: "screen",
    placement: "corner",
    title: "What's changed",
    text: "Everything you've changed since you last published, in plain words. Undo anything you don't want before it goes live.",
  },
  {
    section: "home",
    target: "publish",
    title: "Publish when you're ready",
    text: "Nobody sees your changes until you press Publish. Then your website updates for everyone within a minute or two.",
    points: ["The label beside it says how many changes aren't live yet", "You can take this tour again any time from the menu"],
  },
];

export function startTour() {
  window.dispatchEvent(new Event(START_TOUR_EVENT));
}

function tourDone() {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    // Storage blocked: don't show it on every visit.
    return true;
  }
}

/** Something modal (the setup questions, a confirm) is open: the tour waits for it. */
function modalOpen() {
  return Boolean(document.querySelector('[aria-modal="true"], [role="dialog"]:not([data-tour-card])'));
}

function visibleTarget(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** Runs the tour on the Edit site screen (`active`), the first time, or when asked again. */
export function Tour({ active }: { active: boolean }) {
  const { showSection } = useSite();
  const [step, setStep] = useState<number | null>(null);
  // Fixed when the tour starts: the screens this owner has.
  const [steps, setSteps] = useState<TourStepDef[]>(STEPS);
  const begin = useCallback(() => {
    setSteps(STEPS.filter((s) => !s.requires || document.querySelector(`[data-tour="${s.requires}"]`)));
    setStep(0);
  }, []);

  // Each step opens its screen.
  const section = step === null ? null : steps[step]?.section;
  useEffect(() => {
    if (section) showSection(section);
    // showSection changes identity with the editor's state; only the step matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, step]);

  // First visit: wait until the screen has settled and nothing modal is open.
  useEffect(() => {
    if (!active || tourDone()) return;
    const timer = window.setInterval(() => {
      if (modalOpen() || !visibleTarget("preview")) return;
      window.clearInterval(timer);
      begin();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, begin]);

  useEffect(() => {
    window.addEventListener(START_TOUR_EVENT, begin);
    return () => window.removeEventListener(START_TOUR_EVENT, begin);
  }, [begin]);

  const finish = useCallback(() => {
    setStep(null);
    showSection("home");
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      // Shown again next visit; harmless.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (step === null) return null;
  return <TourStep step={steps[step]} index={step} count={steps.length} onNext={() => (step + 1 < steps.length ? setStep(step + 1) : finish())} onBack={() => setStep(Math.max(0, step - 1))} onClose={finish} />;
}

function TourStep({ step, index, count, onNext, onBack, onClose }: { step: TourStepDef; index: number; count: number; onNext: () => void; onBack: () => void; onClose: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(0);
  useLayoutEffect(() => {
    setCardHeight(cardRef.current?.offsetHeight ?? 0);
  }, [step.title]);

  useLayoutEffect(() => {
    const target = visibleTarget(step.target);
    if (step.placement !== "corner") target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
    const measure = () => setRect(visibleTarget(step.target)?.getBoundingClientRect() ?? null);
    measure();
    // Keep up with scrolling, resizing and the smooth scroll above.
    const timer = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step.target, step.placement, step.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") onNext();
      else if (e.key === "ArrowLeft") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, onBack, onClose]);

  const pad = 6;
  const cardWidth = Math.min(290, window.innerWidth - 32);
  // The card goes below the target or above it when it fits there, else in the window's corner
  // (a target as tall as the window, like the preview); always kept inside the window.
  const margin = 16;
  const h = cardHeight || 260;
  let cardStyle: React.CSSProperties;
  const corner: React.CSSProperties = window.innerWidth >= 640 ? { bottom: 24, right: 24 } : { bottom: margin, left: margin };
  if (step.placement === "corner") {
    cardStyle = corner;
  } else if (!rect) {
    cardStyle = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  } else {
    const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - cardWidth / 2), window.innerWidth - cardWidth - margin);
    const below = rect.bottom + pad + 10;
    const above = rect.top - pad - 10 - h;
    if (below + h <= window.innerHeight - margin) cardStyle = { top: below, left };
    else if (above >= margin) cardStyle = { top: above, left };
    else cardStyle = corner;
  }

  const last = index === count - 1;
  const video = HELP_VIDEO_URL && (index === 0 || last);

  return createPortal(
    <div className="fixed inset-0 z-[60]" aria-live="polite">
      {/* Clicks outside the card do nothing, so the tour isn't lost by a stray click. */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />
      {rect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-xl ring-2 ring-indigo-400 transition-all duration-200 motion-reduce:transition-none"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: "0 0 0 9999px rgba(15, 15, 20, 0.55)",
          }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-black/55" />
      )}
      <div
        role="dialog"
        data-tour-card
        ref={cardRef}
        aria-label={step.title}
        className="absolute max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl bg-background p-3.5 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
        style={{ ...cardStyle, width: cardWidth }}
      >
        <p className="text-[10px] font-semibold tracking-wider text-indigo-700 dark:text-indigo-300">
          STEP {index + 1} OF {count}
        </p>
        <h2 className="mt-0.5 text-sm font-bold">{step.title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{step.text}</p>
        {step.points && (
          <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-700 dark:text-zinc-300">
            {step.points.map((point) => (
              <li key={point} className="flex gap-1.5">
                <span aria-hidden="true" className="text-indigo-600 dark:text-indigo-400">
                  ✓
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        )}
        {video && (
          <a href={HELP_VIDEO_URL} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300">
            ▶ Watch the 2-minute video
          </a>
        )}
        <div className="mt-3 flex items-center gap-1.5">
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 hover:underline">
            {last ? "Close" : "Skip the tour"}
          </button>
          <span className="ml-auto" />
          {index > 0 && (
            <button type="button" onClick={onBack} className="h-7 rounded-lg px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900">
              Back
            </button>
          )}
          <button type="button" autoFocus onClick={onNext} className="h-7 rounded-lg bg-indigo-700 px-3 text-xs font-semibold text-white hover:bg-indigo-800">
            {last ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
