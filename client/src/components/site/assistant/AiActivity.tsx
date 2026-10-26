"use client";

import { useEffect, useState } from "react";
import type { AssistantPart, DisplayEntry } from "@/lib/assistant-api";
import { Button, inputClass } from "../ui";
import { useAssistant } from "./AssistantProvider";
import { RichText } from "./RichText";

// The AI's work in one window in the middle of the screen, so nobody misses it:
//   - while it answers or carries out its changes, a loader saying what it's on, with Stop and
//     "Keep working in the background" (which shrinks it to a small pill at the top);
//   - when an answer from this visit needs something from the owner (its offer_choices question,
//     or text ending in "?"), the same window turns into the question, with its answer buttons and
//     a reply box. Answering turns it back into the loader.
// While it only works, the conversation panel (z-50) stays above it, so "See what it's doing" just
// opens the panel; a question goes above everything, on a phone too.

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

export function AiActivity() {
  const { turn, conversation, working, applyingAll, actions, stop, send, open, setOpen } = useAssistant();
  // Turns the owner sent to the background, and questions they put off.
  const [background, setBackground] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());

  const running = turn?.status === "running";
  const applying = working.size > 0 || applyingAll;
  const busy = running || applying;

  // What it's on: the change being made, else the latest step of its answer.
  const changing = [...working].map((id) => actions[id]).find(Boolean);
  const lastPart = turn?.parts.at(-1);
  const doing = changing
    ? changing.title
    : !running
      ? "Making the changes"
      : lastPart?.type === "activity"
        ? lastPart.label
        : lastPart
          ? "Writing its answer"
          : "Thinking about your request";

  // Only a question from a turn finished in this visit: the provider keeps that turn, never an old one.
  const latest = conversation?.display.at(-1);
  const fresh = turn && turn.status === "done" && latest?.id === turn.id ? latest : undefined;
  const question = !busy && fresh && !answered.has(fresh.id) ? questionOf(fresh) : null;

  const loading = busy && background !== turn?.id;
  const shown = loading || Boolean(question);

  return (
    <>
      {/* Always mounted so it can fade, and hiding waits a moment: carrying out several changes has short gaps between them. */}
      <div
        aria-hidden={!shown}
        className={`fixed inset-0 grid place-items-center bg-background/60 px-4 backdrop-blur-[2px] transition-opacity duration-300 ${
          question ? "z-[60] bg-black/30 backdrop-blur-sm" : `z-40 ${open ? "sm:pr-[28rem]" : ""}`
        } ${shown ? "opacity-100" : "pointer-events-none opacity-0 delay-700"}`}
      >
        <div
          role={question ? "dialog" : "status"}
          aria-modal={question ? true : undefined}
          aria-labelledby={question ? "ai-question-title" : undefined}
          aria-live={question ? undefined : "polite"}
          className={`w-full rounded-2xl border border-zinc-200 bg-background shadow-2xl transition-[max-width] dark:border-zinc-800 ${question ? "max-w-lg" : "max-w-sm"}`}
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
              <p className="mt-4 text-xs text-zinc-400">If it needs anything from you, it asks here. Nothing goes live until you publish.</p>
              <div className="mt-6 flex flex-col gap-2">
                <Button className="py-2" onClick={() => setBackground(turn?.id ?? null)} tabIndex={shown ? 0 : -1}>
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
          className="fixed left-1/2 top-16 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background shadow-lg"
        >
          <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-background/30 border-t-background motion-reduce:animate-none" />
          The AI is working…
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
