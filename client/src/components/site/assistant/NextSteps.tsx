"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type NextStep, type NextSteps as NextStepsData, api, workspacePath } from "@/lib/site-api";
import { type SiteSection, useSite } from "../site-context";
import { Button, Spinner, StepList, type Step } from "../ui";
import { useAssistant } from "./AssistantProvider";

// "Next steps" in the Ask Claude panel and on Home: how ready the site is and the few things to do
// next, worked out from the site's own files (server/src/next-steps.js, no credits). A step sends
// Claude a request, puts one in the message box for the owner to finish, or opens a screen. The
// owner can put optional steps off ("Not now"), and sees the bar move as steps get done.

const SHOWN = 3;
const SECTIONS: SiteSection[] = ["home", "pages", "design", "details", "publish", "seo", "tree", "schedule", "memory", "styles", "tools"];
// Steps an owner may put off: nice to have, not needed for a working site.
const OPTIONAL = new Set(["social", "testimonials", "faq", "seo", "logo", "chrome", "notfound"]);

/** A word of encouragement for where the owner is. */
function milestone(percent: number) {
  if (percent >= 100) return "Your site has everything it needs. Nice work! 🎉";
  if (percent >= 75) return "Almost ready to share.";
  if (percent >= 50) return "Over halfway there!";
  if (percent >= 25) return "Good start, keep going.";
  return "Let's build your site, one step at a time.";
}

/**
 * Loads the steps while the panel is open, again whenever the site's files may have changed
 * (`version`), and whenever `changed` does: the panel passes how many of Claude's changes have been
 * applied, since applying one doesn't always bump `version`.
 */
export function useNextSteps(open: boolean, changed: number) {
  const { owner, repo, version } = useSite();
  const [data, setData] = useState<NextStepsData | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<NextStepsData>(workspacePath(owner, repo, "/next-steps"))
      .then((next) => !cancelled && setData(next))
      // Only a help: without it the panel shows its usual examples.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version, open, changed]);

  return data;
}

/* ------------------------------------------------------------ shared state */

// Steps put off with "Not now", per site and browser. They leave the list and the progress (so it
// can reach 100%) until brought back from "Show all".
const skippedKey = (owner: string, repo: string) => `twinstack:next-steps-skipped:${owner}/${repo}`;
const SKIPPED_EVENT = "twinstack:next-steps-skipped";

function readSkipped(owner: string, repo: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(skippedKey(owner, repo)) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The skipped steps, kept in step between the panel and Home. */
function useSkipped() {
  const { owner, repo } = useSite();
  const [skipped, setSkipped] = useState<string[]>([]);
  useEffect(() => {
    const load = () => setSkipped(readSkipped(owner, repo));
    load();
    window.addEventListener(SKIPPED_EVENT, load);
    return () => window.removeEventListener(SKIPPED_EVENT, load);
  }, [owner, repo]);
  const toggle = useCallback(
    (id: string) => {
      const current = readSkipped(owner, repo);
      const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
      try {
        localStorage.setItem(skippedKey(owner, repo), JSON.stringify(next));
      } catch {
        // Storage can be blocked: it's skipped until the page reloads.
      }
      setSkipped(next);
      window.dispatchEvent(new Event(SKIPPED_EVENT));
    },
    [owner, repo],
  );
  return { skipped, toggle };
}

/** The steps as the owner sees them: skipped ones set aside, and the progress without them. */
function arrange(data: NextStepsData, skipped: string[]) {
  const isSkipped = (s: NextStep) => !s.done && skipped.includes(s.id);
  const todo = data.steps.filter((s) => !s.done && s.action && !isSkipped(s));
  const done = data.steps.filter((s) => s.done);
  const putOff = data.steps.filter(isSkipped);
  const total = data.progress.total - putOff.filter((s) => s.counts).length;
  const percent = total > 0 ? Math.min(100, Math.round((data.progress.done / total) * 100)) : 100;
  return { todo, done, putOff, doneCount: data.progress.done, total, percent };
}

/** The step Claude was asked to do here, until its answer ends. */
function useWorkingOn() {
  const { turn } = useAssistant();
  const [workingOn, setWorkingOn] = useState<string | null>(null);
  const running = turn?.status === "running";
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setWorkingOn(null);
    wasRunning.current = running;
  }, [running]);
  return { workingOn, setWorkingOn, running };
}

/** The bar, its words, and a short "+7%" when it grows. */
function Progress({ percent, doneCount, total, size = "sm" }: { percent: number; doneCount: number; total: number; size?: "sm" | "md" }) {
  const previous = useRef(percent);
  const [gain, setGain] = useState(0);
  useEffect(() => {
    const grew = percent - previous.current;
    previous.current = percent;
    if (grew <= 0) return;
    setGain(grew);
    const timer = setTimeout(() => setGain(0), 3500);
    return () => clearTimeout(timer);
  }, [percent]);

  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-semibold">Your site is {percent}% ready</span>
        <span className="text-xs text-zinc-500">
          {doneCount} of {total} done
        </span>
        {gain > 0 && (
          <span className="animate-pulse rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            +{gain}%, nice work!
          </span>
        )}
      </p>
      <div
        className={`${size === "md" ? "h-2" : "h-1.5"} overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800`}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="How ready your site is"
      >
        <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-700 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{milestone(percent)}</p>
    </div>
  );
}

const actionLabel = (step: NextStep) => (step.action?.type === "open" ? "Open" : step.action?.type === "fill" ? "Fill in" : "Ask the AI");

/* ------------------------------------------------------------ the panel's card */

/**
 * The card. `compact` (a conversation is open) shows one line that expands. `onSend` sends a
 * request; `onFill` puts text in the message box. Claude steps are off while Claude can't run.
 */
export function NextSteps({
  data,
  compact = false,
  onSend,
  onFill,
  disabled,
}: {
  data: NextStepsData;
  compact?: boolean;
  onSend: (prompt: string) => void;
  onFill: (prompt: string) => void;
  disabled: boolean;
}) {
  const { claude, showSection } = useSite();
  const { skipped, toggle } = useSkipped();
  const { workingOn, setWorkingOn, running } = useWorkingOn();
  const [expanded, setExpanded] = useState(!compact);
  const [all, setAll] = useState(false);

  if (!data.steps.length) return null;
  const { todo, done, putOff, doneCount, total, percent } = arrange(data, skipped);

  function act(step: NextStep) {
    const action = step.action;
    if (!action) return;
    if (action.type === "open") {
      if ((SECTIONS as string[]).includes(action.section)) showSection(action.section as SiteSection);
    } else if (action.type === "fill") onFill(action.prompt);
    else {
      setWorkingOn(step.id);
      onSend(action.prompt);
    }
  }
  const needsClaude = (step: NextStep) => step.action?.type !== "open";

  if (compact && !expanded) {
    const next = todo[0];
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="group w-full rounded-lg border border-zinc-200 px-3 py-2 text-left transition hover:border-zinc-400 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-[0.99] dark:border-zinc-800 dark:hover:border-zinc-600"
      >
        <Progress percent={percent} doneCount={doneCount} total={total} />
        {next && (
          <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-zinc-700 dark:text-zinc-300">
            <span className="truncate">Next: {next.title}</span>
            <span aria-hidden="true" className="ml-auto shrink-0 text-zinc-400 transition-transform group-hover:translate-x-0.5">
              Show steps →
            </span>
          </p>
        )}
      </button>
    );
  }

  const shown = all ? [...todo, ...putOff, ...done] : todo.slice(0, SHOWN);
  return (
    // Above the message box (`compact`) it's outside the conversation's scrolling, so it scrolls itself.
    <div className={`space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 ${compact ? "max-h-[45vh] overflow-y-auto overscroll-contain" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Progress percent={percent} doneCount={doneCount} total={total} />
        </div>
        {compact && (
          <button type="button" className="text-xs text-zinc-500 hover:underline" onClick={() => setExpanded(false)}>
            Hide
          </button>
        )}
      </div>
      {todo.length > 0 && !all && <p className="text-xs text-zinc-600 dark:text-zinc-400">Pick one and the AI will help you do it:</p>}
      <ul className="space-y-2">
        {shown.map((step) => {
          const isPutOff = !step.done && skipped.includes(step.id);
          const working = running && workingOn === step.id;
          if (step.done) {
            return (
              <li key={step.id} className="flex items-center gap-2 px-1 text-sm text-zinc-500">
                <span aria-hidden="true" className="text-emerald-600">✓</span>
                <span className="line-through decoration-zinc-400/60">{step.title}</span>
              </li>
            );
          }
          if (isPutOff) {
            return (
              <li key={step.id} className="flex items-center gap-2 px-1 text-sm text-zinc-500">
                <span className="min-w-0 flex-1 truncate">{step.title}</span>
                <button type="button" className="shrink-0 text-xs underline hover:text-foreground" onClick={() => toggle(step.id)}>
                  Bring back
                </button>
              </li>
            );
          }
          return (
            <li key={step.id} className="group relative">
              <button
                type="button"
                disabled={((disabled || !claude.ready) && needsClaude(step)) || working}
                onClick={() => act(step)}
                className="block w-full rounded-lg border border-zinc-200 px-3 py-2 text-left transition hover:-translate-y-px hover:border-zinc-400 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className="min-w-0">{step.title}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-normal text-zinc-500">
                    {working ? (
                      <>
                        <Spinner /> The AI is on it…
                      </>
                    ) : (
                      <>
                        {actionLabel(step)}
                        <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                          →
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <span className={`mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400 ${OPTIONAL.has(step.id) ? "pr-14" : ""}`}>{step.why}</span>
              </button>
              {OPTIONAL.has(step.id) && !working && (
                <button
                  type="button"
                  onClick={() => toggle(step.id)}
                  className="absolute bottom-1.5 right-2 rounded px-1 text-[11px] text-zinc-400 opacity-0 transition hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-zinc-200"
                >
                  Not now
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {(todo.length > SHOWN || done.length > 0 || putOff.length > 0) && (
        <button type="button" className="text-xs text-zinc-600 hover:underline dark:text-zinc-400" onClick={() => setAll(!all)}>
          {all ? "Show only what's next" : `Show all ${todo.length + putOff.length + done.length} steps`}
        </button>
      )}
      {!data.linksChecked && <p className="text-xs text-zinc-500">Build the preview once to check your links too.</p>}
    </div>
  );
}

/* ------------------------------------------------------------ Home */

// Home's "Next steps": the same steps, numbered like the rest of Home, with more of them shown.
const HOME_SHOWN = 5;
const OPEN_LABELS: Partial<Record<SiteSection, string>> = { design: "Open Look & logo", publish: "See what changed", details: "Open Business info", pages: "Open Pages", seo: "Open Google & sharing" };

/** The steps with a progress bar, or `fallback` until they're loaded (and when Claude isn't set up, since most steps ask Claude). */
export function HomeNextSteps({ fallback }: { fallback: ReactNode }) {
  const { claude, showSection } = useSite();
  const { actions, send, fillDraft } = useAssistant();
  const data = useNextSteps(true, Object.values(actions).filter((a) => a.status === "applied").length);
  const { skipped, toggle } = useSkipped();
  const { workingOn, setWorkingOn, running } = useWorkingOn();
  const [all, setAll] = useState(false);
  // Only the progress until the owner opens the steps.
  const [open, setOpen] = useState(false);
  if (!data || !data.steps.length || !claude.ready) return <>{fallback}</>;

  const { todo, done, putOff, doneCount, total, percent } = arrange(data, skipped);
  const visible = all ? [...todo, ...putOff, ...done] : todo.slice(0, HOME_SHOWN);

  const buttons = (step: NextStep) => {
    const action = step.action;
    if (!action) return undefined;
    if (skipped.includes(step.id)) {
      return (
        <Button variant="ghost" onClick={() => toggle(step.id)}>
          Bring back
        </Button>
      );
    }
    const notNow = OPTIONAL.has(step.id) && (
      <Button variant="ghost" className="text-zinc-500" onClick={() => toggle(step.id)}>
        Not now
      </Button>
    );
    if (action.type === "open") {
      const section = (SECTIONS as string[]).includes(action.section) ? (action.section as SiteSection) : null;
      if (!section) return undefined;
      return (
        <>
          {notNow}
          <Button variant={section === "publish" ? "primary" : undefined} onClick={() => showSection(section)}>
            {OPEN_LABELS[section] ?? "Open"}
          </Button>
        </>
      );
    }
    if (action.type === "fill") {
      return (
        <>
          {notNow}
          <Button onClick={() => fillDraft(action.prompt)}>Fill in with the AI</Button>
        </>
      );
    }
    const working = running && workingOn === step.id;
    return (
      <>
        {!working && notNow}
        <Button
          disabled={running}
          onClick={() => {
            setWorkingOn(step.id);
            void send(action.prompt);
          }}
        >
          {working ? (
            <span className="flex items-center gap-2">
              <Spinner /> The AI is on it…
            </span>
          ) : (
            "Ask the AI"
          )}
        </Button>
      </>
    );
  };
  const steps: Step[] = visible.map((step) => ({
    id: step.id,
    title: step.title,
    text: skipped.includes(step.id) ? "Put off for now." : step.why,
    done: step.done,
    // Put-off steps don't compete for "do this next".
    optional: skipped.includes(step.id),
    action: buttons(step),
  }));

  // Closed, one line above the preview: what's left, not a score, so a live site doesn't look unfinished.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        className="group flex items-center gap-2 text-sm font-medium hover:underline"
      >
        {todo.length ? `${todo.length} ${todo.length === 1 ? "thing" : "things"} left before you share your site` : "Your site has everything it needs"}
        <span aria-hidden="true" className="inline-block transition-transform group-hover:translate-x-0.5">
          ›
        </span>
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Progress percent={percent} doneCount={doneCount} total={total} size="md" />
        </div>
        <button type="button" aria-expanded className="shrink-0 text-sm text-zinc-600 hover:underline dark:text-zinc-400" onClick={() => setOpen(false)}>
          Hide steps ▴
        </button>
      </div>
      {steps.length > 0 && (
        // Expanded ("Show all"), a fixed height that scrolls inside, so the preview stays near.
        <div className={all ? "max-h-88 overflow-y-auto overscroll-contain pr-1" : undefined}>
          <StepList steps={steps} />
        </div>
      )}
      {(todo.length > HOME_SHOWN || done.length > 0 || putOff.length > 0) && (
        <button type="button" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400" onClick={() => setAll(!all)}>
          {all ? "Show only what's next" : `Show all ${todo.length + putOff.length + done.length} steps`}
        </button>
      )}
      {!data.linksChecked && <p className="text-xs text-zinc-500">Your links are checked once the preview has been built.</p>}
    </div>
  );
}
