"use client";

import { useEffect, useState } from "react";
import type { AssistantAction, AssistantPart, DisplayEntry } from "@/lib/assistant-api";
import { isHomePage, type SitePage } from "@/lib/site-api";
import { useSite } from "../site-context";
import { Button, inputClass } from "../ui";
import { useAssistant } from "./AssistantProvider";
import { RichText } from "./RichText";

// The AI's work in one window, so nobody misses it:
//   - while it answers or carries out its changes, a loader over the screen's card (mounted inside
//     it, so the header and the menu stay usable) saying what it's on, with Stop and "Keep working
//     in the background" (which shrinks it to a small pill at the top);
//   - when an answer from this visit needs something from the owner (its offer_choices question,
//     or text ending in "?"), the same window turns into the question, with its answer buttons and
//     a reply box. Answering turns it back into the loader.
// The loader names what it's on in the owner's words ("Designing your homepage", "Writing the
// Contact page") and lists the changes of this stretch of work with how far each has got, so a
// long first build shows its progress. A stretch ends a few seconds after the work stops, which
// keeps a continuing answer's changes in the same list.
// While it only works, the conversation panel (z-50) stays above it, so "See what it's doing" just
// opens the panel; a question covers the whole window, above everything, on a phone too.

type Question = { context: string; question: string | null; choices: string[] };

/** What an answer needs from the owner, or null. */
function questionOf(entry: DisplayEntry | undefined): Question | null {
  if (entry?.role !== "assistant") return null;
  const asked = entry.parts.find((p): p is Extract<AssistantPart, { type: "choices" }> => p.type === "choices" && p.kind === "question");
  const text = entry.parts
    .filter((p): p is Extract<AssistantPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
    .trim();
  if (asked) return { context: text, question: asked.question?.trim() || null, choices: asked.choices };
  if (text.endsWith("?")) return { context: text, question: null, choices: [] };
  return null;
}

/** How long a pause in the work ends its stretch (and its list of changes). */
const STRETCH_GAP_MS = 4000;

/**
 * What a change is on, for the loader ("Writing the Contact page") and its list ("Contact page"),
 * and `url`: where the preview shows it once it's done (a page, or the homepage for the header and
 * footer), or null.
 */
function describe(action: AssistantAction, pages: SitePage[]): { doing: string; item: string; url: string | null } {
  const input = action.input as Record<string, unknown>;
  const meta = action.meta as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  // A new page isn't in the action, so it's found by its title (or as the homepage).
  const page =
    pages.find((p) => p.file === input.file) ??
    (action.tool === "create_page" ? (input.type === "homepage" ? pages.find(isHomePage) : pages.find((p) => p.title === input.title)) : undefined);
  const home = (page ? isHomePage(page) : false) || (action.tool === "create_page" && input.type === "homepage");
  const title = text(page?.title) ?? text(meta.title) ?? text(input.title) ?? "new";
  const item = home ? "Homepage" : `${title} page`;
  const named = home ? "your homepage" : `the ${title} page`;
  const saving = action.status === "ready";
  const url = action.tool === "design_header_and_footer" ? "/" : page ? (page.address ?? page.url ?? null) : null;
  const described = words();
  // Kept, and still working: the preview is being rebuilt with it (keep's showIt).
  if (action.status === "applied") described.doing = `Putting ${action.tool === "design_header_and_footer" ? "the header and footer" : named} in the preview`;
  return { ...described, url };

  function words(): { doing: string; item: string } {
    switch (action.tool) {
      case "edit_page":
        return {
          doing: saving ? `Saving ${named}` : home ? "Designing your homepage" : `Writing the ${title} page`,
          item,
        };
      case "create_page":
        if (saving) return { doing: `Saving ${named}`, item };
        return {
          doing: home ? "Creating your homepage" : input.brief ? `Writing the ${title} page` : `Adding the ${title} page`,
          item,
        };
      case "convert_page_from_html":
        return {
          doing: saving ? `Saving ${named}` : `Bringing in ${named}`,
          item,
        };
      case "design_header_and_footer":
        return {
          doing: saving ? "Saving the header and footer" : "Designing the header and footer",
          item: "Header and footer",
        };
      case "update_menu_and_footer":
        return {
          doing: "Updating the menu and footer",
          item: "Menu and footer",
        };
      case "update_site_details":
        return {
          doing: "Updating your business details",
          item: "Business details",
        };
      case "create_image":
        return input.prompt ? { doing: "Making a picture", item: "Picture" } : { doing: "Drawing an image", item: "Drawing" };
      case "add_file_to_site":
        return {
          doing: `Adding ${text(meta.file) ?? "a file"} to the site`,
          item: text(meta.file) ?? "File",
        };
      case "delete_page":
        return { doing: `Removing ${named}`, item: `Remove ${named}` };
      case "create_missing_pages":
        return {
          doing: "Creating the pages in your plan",
          item: "Pages in the plan",
        };
      case "write_search_text_for_all_pages":
        return {
          doing: "Writing search text for every page",
          item: "Search text",
        };
      case "publish_changes":
        return { doing: "Publishing your site", item: "Publish" };
      default:
        return { doing: action.title, item: action.title };
    }
  }
}

const sinceStart = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? "Under a minute so far" : `${m} min so far`;
};

export function AiActivity() {
  const { turn, conversation, working, applyingAll, queued, actions, stop, send, retry, open, setOpen } = useAssistant();
  const { overview, showOnSite } = useSite();
  const pages = overview?.collections.flatMap((c) => c.pages) ?? [];
  // Turns the owner sent to the background, and questions they put off.
  const [background, setBackground] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());

  const running = turn?.status === "running";
  const applying = working.size > 0 || applyingAll;
  const busy = running || applying;

  // This stretch of work: when it started and the changes carried out in it, in order.
  const [stretch, setStretch] = useState<{
    started: number;
    ids: string[];
  } | null>(null);
  const [now, setNow] = useState(0);
  // A stretch with a change that didn't work stays, as the report of what's missing, until closed.
  const failedSteps = (stretch?.ids ?? []).map((id) => actions[id]).filter((a) => a?.status === "failed");
  const hasFailed = failedSteps.length > 0;
  useEffect(() => {
    if (!busy) {
      if (hasFailed) return;
      const timer = setTimeout(() => setStretch(null), STRETCH_GAP_MS);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      const at = Date.now();
      setNow(at);
      setStretch((s) => {
        const ids = s?.ids ?? [];
        const added = [...queued, ...working].filter((id) => !ids.includes(id));
        return s && !added.length ? s : { started: s?.started ?? at, ids: [...ids, ...added] };
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [busy, hasFailed, queued, working]);
  useEffect(() => {
    if (!stretch) return;
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [stretch]);
  const steps = (stretch?.ids ?? []).map((id) => actions[id]).filter(Boolean);
  const stretchKey = stretch ? String(stretch.started) : (turn?.id ?? null);
  /** Hides the window (the work goes on) and shows the finished change on Edit site. */
  const seeIt = (url: string) => {
    setBackground(stretchKey);
    showOnSite(url);
  };

  // What it's on: the change being made, else the next one in line, else the latest step of its answer.
  const changing = [...working].map((id) => actions[id]).find(Boolean);
  const next = steps.find((a) => a.status === "proposed" || a.status === "ready");
  const lastPart = turn?.parts.at(-1);
  const doing = changing
    ? describe(changing, pages).doing
    : !running
      ? next
        ? describe(next, pages).doing
        : "Getting the next step ready"
      : steps.length && !turn?.parts.length
        ? "Planning the next steps"
        : lastPart?.type === "activity"
          ? lastPart.label
          : lastPart
            ? "Writing its answer"
            : "Thinking about your request";

  // Only a question from a turn finished in this visit: the provider keeps that turn, never an old one.
  const latest = conversation?.display.at(-1);
  const fresh = turn && turn.status === "done" && latest?.id === turn.id ? latest : undefined;
  const question = !busy && fresh && !answered.has(fresh.id) ? questionOf(fresh) : null;

  const loading = busy && background !== stretchKey;
  // The work stopped with a change that didn't work: say so, even if it was sent to the background.
  const report = !busy && !question && hasFailed;
  const shown = loading || Boolean(question) || report;

  const stepList = steps.length > (report ? 0 : 1) && (
    <ol className="mx-auto mt-4 max-w-64 space-y-1.5 text-left text-sm" aria-label="The changes">
      {steps.map((a) => {
        const current = working.has(a.id);
        const described = describe(a, pages);
        // Kept is done, even while the preview catches up; written but not yet kept is still under way.
        const state =
          a.status === "applied" ? "done" : current || a.status === "running" || a.status === "ready" ? "working" : a.status === "failed" ? "failed" : a.status === "skipped" ? "skipped" : "waiting";
        return (
          <li key={a.id} className={`flex items-center gap-2 ${current ? "font-medium" : state === "done" ? "text-zinc-500" : state === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-400"}`}>
            <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-xs">
              {state === "working" ? (
                <span className="size-3 animate-spin rounded-full border-2 border-zinc-200 border-t-foreground motion-reduce:animate-none dark:border-zinc-800" />
              ) : state === "done" ? (
                "✓"
              ) : state === "failed" ? (
                "✕"
              ) : state === "skipped" ? (
                "–"
              ) : (
                <span className="size-2 rounded-full border border-zinc-300 dark:border-zinc-700" />
              )}
            </span>
            <span className="truncate">{described.item}</span>
            <span className="sr-only">{` (${{ working: "working on it", done: "done", failed: "didn't work", skipped: "skipped", waiting: "waiting" }[state]})`}</span>
            {/* Once the preview has it (it's rebuilt while the change still counts as working). */}
            {state === "done" && !current && described.url && (
              <button
                type="button"
                onClick={() => seeIt(described.url!)}
                tabIndex={shown ? 0 : -1}
                className="ml-auto shrink-0 rounded px-1.5 text-xs font-medium text-foreground underline-offset-2 hover:underline"
              >
                See it
                <span className="sr-only"> ({described.item})</span>
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );

  return (
    <>
      {/* Always mounted so it can fade, and hiding waits a moment: carrying out several changes has short gaps between them. */}
      <div
        aria-hidden={!shown}
        className={`bg-background/60 px-4 backdrop-blur-[2px] transition-opacity duration-300 ${
          question
            ? "fixed inset-0 z-1000 grid place-items-center bg-black/30 backdrop-blur-sm"
            : // The card can be taller than the window: the loader stays in view as the screen scrolls.
              // Above the sticky AI bar and status strip (z-30), which it can reach on a short screen; below the panel (z-50).
              `absolute inset-0 z-40 flex items-start justify-center rounded-2xl ${open ? "sm:pr-[28rem] xl:pr-4" : ""}`
        } ${shown ? "opacity-100" : "pointer-events-none opacity-0 delay-700"}`}
      >
        <div
          role={question ? "dialog" : "status"}
          aria-modal={question ? true : undefined}
          aria-labelledby={question ? "ai-question-title" : undefined}
          aria-live={question ? undefined : "polite"}
          className={`w-full rounded-2xl border border-zinc-200 bg-background shadow-2xl transition-[max-width] dark:border-zinc-800 ${question ? "max-w-lg" : "sticky top-[30vh] my-8 max-w-sm"}`}
        >
          {question && fresh ? (
            <QuestionBody
              key={fresh.id}
              question={question}
              onAnswer={async (text) => {
                if (await send(text)) setAnswered((a) => new Set(a).add(fresh.id));
              }}
              onLater={() => setAnswered((a) => new Set(a).add(fresh.id))}
            />
          ) : report ? (
            <div className="p-8 text-center">
              <h2 className="font-semibold">The AI couldn&apos;t finish everything</h2>
              <p className="mt-1 text-sm text-zinc-500">
                {failedSteps.map((a) => describe(a, pages).item).join(", ")} didn&apos;t work. Everything with a tick is saved.
              </p>
              {stepList}
              <div className="mt-6 flex flex-col gap-2">
                <Button variant="primary" className="py-2" onClick={() => void retry(failedSteps[0])}>
                  Try again
                </Button>
                <div className="flex justify-center gap-1">
                  <Button variant="ghost" className="text-zinc-500" onClick={() => setOpen(true)}>
                    See what happened
                  </Button>
                  <Button variant="ghost" className="text-zinc-500" onClick={() => setStretch(null)}>
                    Close
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 text-center">
              <div className="relative mx-auto size-14">
                <span aria-hidden="true" className="absolute inset-0 animate-spin rounded-full border-[3px] border-zinc-200 border-t-foreground motion-reduce:animate-none dark:border-zinc-800" />
                <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-lg">
                  ✦
                </span>
              </div>
              <h2 className="mt-5 font-semibold">The AI is working on your site</h2>
              <p className="mt-1 min-h-5 text-sm text-zinc-500">{doing}…</p>
              {stepList}
              {steps.length === 1 && steps[0].status === "applied" && !working.has(steps[0].id) && describe(steps[0], pages).url && (
                <Button variant="ghost" className="mt-3 text-sm" onClick={() => seeIt(describe(steps[0], pages).url!)} tabIndex={shown ? 0 : -1}>
                  See {describe(steps[0], pages).item.toLowerCase()}
                </Button>
              )}
              {stretch && now - stretch.started > 60000 && <p className="mt-3 text-xs text-zinc-400">{sinceStart(now - stretch.started)}. Each page can take a few minutes.</p>}
              <p className="mt-4 text-xs text-zinc-400">If it needs anything from you, it asks here. Nothing goes live until you publish.</p>
              <div className="mt-6 flex flex-col gap-2">
                <Button className="py-2" onClick={() => setBackground(stretchKey)} tabIndex={shown ? 0 : -1}>
                  Keep working in the background
                </Button>
                <div className="flex justify-center gap-1">
                  <Button variant="ghost" className="text-zinc-500" onClick={() => setOpen(true)} tabIndex={shown ? 0 : -1}>
                    See what it&apos;s doing
                  </Button>
                  {running && (
                    <Button variant="ghost" className="text-zinc-500" onClick={() => void stop()} tabIndex={shown ? 0 : -1}>
                      Stop
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {busy && !loading && (
        <button
          type="button"
          onClick={() => setBackground(null)}
          aria-label={`The AI: ${doing}. Show progress`}
          className="fixed left-1/2 top-16 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background shadow-lg"
        >
          <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-background/30 border-t-background motion-reduce:animate-none" />
          <span className="max-w-[60vw] truncate">{doing}…</span>
        </button>
      )}
    </>
  );
}

/** The AI's question in the window: what it said, the question, its answers as buttons, and a reply box. */
function QuestionBody({ question, onAnswer, onLater }: { question: Question; onAnswer: (text: string) => Promise<void>; onLater: () => void }) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  // Escape puts it off, like "Answer later".
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onLater();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onLater]);

  async function answer(text: string) {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    await onAnswer(value);
    setSending(false);
  }

  // The question once: as its own line when the AI gave one that its text doesn't already end with.
  const separate = question.question && !question.context.includes(question.question) ? question.question : null;

  return (
    <form
      className="p-6 sm:p-8"
      onSubmit={(e) => {
        e.preventDefault();
        void answer(reply);
      }}
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background">
          ✦
        </span>
        <h2 id="ai-question-title" className="font-semibold">
          The AI needs something from you
        </h2>
      </div>

      <div className="mt-4 max-h-64 space-y-3 overflow-y-auto text-[15px] leading-relaxed">
        {question.context && <RichText text={question.context} />}
        {separate && <p className="font-medium">{separate}</p>}
      </div>

      {question.choices.length > 0 && (
        <div className="mt-5 flex flex-col gap-2">
          {question.choices.map((choice, i) => (
            <button
              key={choice}
              type="button"
              disabled={sending}
              autoFocus={i === 0}
              onClick={() => void answer(choice)}
              className="rounded-xl border border-zinc-200 px-4 py-3 text-left text-sm hover:border-foreground hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              {choice}
            </button>
          ))}
        </div>
      )}

      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter starts a new line, like the conversation panel.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void answer(reply);
          }
        }}
        rows={2}
        maxLength={8000}
        disabled={sending}
        placeholder={question.choices.length ? "Or type your own answer…" : "Type your answer…"}
        aria-label="Your answer"
        autoFocus={!question.choices.length}
        className={`${inputClass} mt-4 resize-none py-2.5 text-sm`}
      />

      <div className="mt-5 flex items-center gap-2">
        <Button variant="ghost" className="px-4 py-2 text-zinc-500" onClick={onLater} disabled={sending}>
          Answer later
        </Button>
        <Button type="submit" variant="primary" className="ml-auto px-5 py-2" disabled={!reply.trim() || sending}>
          {sending ? "Sending…" : "Send answer"}
        </Button>
      </div>
    </form>
  );
}
