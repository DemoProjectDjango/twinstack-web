"use client";

import { useEffect, useState } from "react";
import { type NextStep, type NextSteps as NextStepsData, api, workspacePath } from "@/lib/site-api";
import { type SiteSection, useSite } from "../site-context";

// "Next steps" in the Ask Claude panel: how ready the site is and the few things to do next, worked
// out from the site's own files (server/src/next-steps.js, no credits). A step sends Claude a
// request, puts one in the message box for the owner to finish, or opens a screen.

const SHOWN = 3;
const SECTIONS: SiteSection[] = ["home", "pages", "design", "details", "publish", "seo", "tree", "schedule", "memory", "styles", "tools"];

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
  const [expanded, setExpanded] = useState(!compact);
  const [all, setAll] = useState(false);

  const todo = data.steps.filter((s) => !s.done && s.action);
  if (!data.steps.length) return null;
  const { done, total } = data.progress;
  const percent = total ? Math.round((done / total) * 100) : 100;

  function act(step: NextStep) {
    const action = step.action;
    if (!action) return;
    if (action.type === "open") {
      if ((SECTIONS as string[]).includes(action.section)) showSection(action.section as SiteSection);
    } else if (action.type === "fill") onFill(action.prompt);
    else onSend(action.prompt);
  }
  const needsClaude = (step: NextStep) => step.action?.type !== "open";

  const header = (
    <div className="space-y-1.5">
      <p className="flex items-baseline gap-2 text-sm">
        <span className="font-semibold">{todo.length ? `Your site is ${percent}% ready` : "Your site is ready"}</span>
        <span className="text-xs text-zinc-500">
          {done} of {total} done
        </span>
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );

  if (compact && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-left hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
      >
        {header}
        {todo[0] && <p className="mt-1.5 truncate text-xs text-zinc-600 dark:text-zinc-400">Next: {todo[0].title}</p>}
      </button>
    );
  }

  const shown = all ? data.steps.filter((s) => s.action || s.done) : todo.slice(0, SHOWN);
  return (
    // Above the message box (`compact`) it's outside the conversation's scrolling, so it scrolls itself.
    <div className={`space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 ${compact ? "max-h-[45vh] overflow-y-auto overscroll-contain" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{header}</div>
        {compact && (
          <button type="button" className="text-xs text-zinc-500 hover:underline" onClick={() => setExpanded(false)}>
            Hide
          </button>
        )}
      </div>
      {todo.length > 0 && !all && <p className="text-xs text-zinc-600 dark:text-zinc-400">Pick one and Claude will help you do it:</p>}
      <ul className="space-y-2">
        {shown.map((step) => (
          <li key={step.id}>
            {step.done ? (
              <p className="flex gap-2 px-1 text-sm text-zinc-500">
                <span aria-hidden="true" className="text-emerald-600">✓</span>
                <span className="line-through decoration-zinc-400/60">{step.title}</span>
              </p>
            ) : (
              <button
                type="button"
                disabled={(disabled || !claude.ready) && needsClaude(step)}
                onClick={() => act(step)}
                className="block w-full rounded-lg border border-zinc-200 px-3 py-2 text-left hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {step.title}
                  <span className="ml-auto shrink-0 text-xs font-normal text-zinc-500">
                    {step.action?.type === "open" ? "Open →" : step.action?.type === "fill" ? "Fill in →" : "Ask Claude →"}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">{step.why}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {(todo.length > SHOWN || data.steps.some((s) => s.done)) && (
        <button type="button" className="text-xs text-zinc-600 hover:underline dark:text-zinc-400" onClick={() => setAll(!all)}>
          {all ? "Show only what's next" : `Show all ${data.steps.length} steps`}
        </button>
      )}
      {!data.linksChecked && <p className="text-xs text-zinc-500">Build the preview once to check your links too.</p>}
    </div>
  );
}
