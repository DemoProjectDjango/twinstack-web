"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { AssistantPart, DisplayEntry } from "@/lib/assistant-api";
import { useSite } from "../site-context";
import { Button, ErrorText, Spinner, inputClass } from "../ui";
import { ActionCard } from "./ActionCard";
import { AttachButton, PendingChips, SentAttachments, useAttachmentUploads, useFileDrop } from "./Attachments";
import { useAssistant } from "./AssistantProvider";
import { NextSteps, useNextSteps } from "./NextSteps";
import { OutOfCredits } from "./OutOfCredits";
import { RichText } from "./RichText";
import { SUGGESTIONS } from "./suggestions";

// The conversation with Claude, in a card docked on the right of the editor (full screen on a
// phone), shown and hidden by the top bar's "Chat with the AI". It follows the owner from screen to
// screen; each message tells Claude which screen they're on.

export function AssistantPanel() {
  const { claude } = useSite();
  const { context, conversation, turn, loading, error, open, setOpen, draft, send, stop, startOver, actions, applyAll, skipAll, applyingAll, autoApply, setAutoApply } = useAssistant();
  const [text, setText] = useState("");
  const uploads = useAttachmentUploads();
  const drop = useFileDrop(uploads.add, claude.ready);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const running = turn?.status === "running";

  /** Puts a request in the box for the owner to finish, with the cursor where their part goes. */
  function fillBox(prompt: string) {
    setText(prompt);
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (!box) return;
      box.focus();
      const line = prompt.indexOf("\n");
      const at = line >= 0 ? line : prompt.length;
      box.setSelectionRange(at, at);
    });
  }

  const nextSteps = useNextSteps(open, Object.values(actions).filter((a) => a.status === "applied").length);

  // Follow the conversation as it grows, like a chat.
  // (The text itself, not its length: going from 11 to 12 messages, or a turn finishing, keeps the length.)
  const size = JSON.stringify([conversation?.display.length, turn?.id, turn?.status, turn?.parts]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [size, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Text another screen left for the owner to finish (a "Fill in" step on Home).
  const usedDraft = useRef(0);
  useEffect(() => {
    if (!open || !draft || draft.id === usedDraft.current) return;
    usedDraft.current = draft.id;
    fillBox(draft.text);
  }, [draft, open]);

  if (!open) return null;

  async function submit(value = text) {
    const message = value.trim();
    if ((!message && !uploads.ready.length) || running || uploads.uploading) return;
    if (await send(message, uploads.ready)) {
      setText("");
      uploads.clear();
    }
  }

  const entries = conversation?.display ?? [];
  const suggestions = SUGGESTIONS[context.page && context.screen === "pages" ? "page" : (context.screen as keyof typeof SUGGESTIONS)] ?? SUGGESTIONS.home;

  return (
    <aside
      aria-label="Ask the AI"
      {...drop.handlers}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden border-zinc-200 bg-background sm:inset-auto sm:bottom-4 sm:right-4 sm:top-[4.5rem] sm:w-[27rem] sm:rounded-2xl sm:border sm:shadow-2xl dark:border-zinc-800"
    >
      {drop.over && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-lg border-2 border-dashed border-foreground bg-background/90 text-sm font-medium">
          Drop files to attach them
        </div>
      )}
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground text-base text-background">
          ✦
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-5">Chat with the AI</h2>
          <AutoApplySwitch on={autoApply} onChange={setAutoApply} />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {conversation && (
            <IconButton label="New conversation" disabled={running} onClick={() => void startOver()}>
              <path d="M12 20h9" />
              <path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </IconButton>
          )}
          <IconButton label="Hide chat" onClick={() => setOpen(false)}>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </IconButton>
        </div>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {loading && <p className="text-sm text-zinc-500">Loading…</p>}

        {!loading && !entries.length && !running && (
          <div className="space-y-3">
            {nextSteps && <NextSteps data={nextSteps} onSend={(p) => void submit(p)} onFill={fillBox} disabled={running} />}
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {nextSteps ? "Or tell the AI what you want, in your own words." : "Tell the AI what you want, in your own words: new pages, changes to wording, the menu, search results and more."}{" "}
              You can attach photos, PDFs, Word documents or any other file.{" "}
              {autoApply
                ? "The AI makes its changes as soon as it answers, and nothing goes live until you publish."
                : "The AI shows you every change first, and nothing happens until you press Apply."}
            </p>
            {claude.ready && (
              <div className="flex flex-col items-start gap-2">
                {nextSteps && <p className="text-xs text-zinc-500">Or try:</p>}
                {suggestions.items.map((s) => (
                  <button
                    key={s}
                    type="button"
                    // Into the box to change or send, never sent by itself.
                    onClick={() => fillBox(s)}
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {entries.map((entry, index) => (
          <Entry
            key={entry.id}
            entry={entry}
            last={index === entries.length - 1}
            onApplyAll={() => void applyAll(entry)}
            onSkipAll={() => void skipAll(entry)}
            openCount={entry.role === "assistant" ? entry.parts.filter((p) => p.type === "action" && actions[p.id]?.status === "proposed").length : 0}
            applyingAll={applyingAll}
            running={running}
          />
        ))}

        {running && turn && (
          <div className="space-y-2">
            <Parts parts={[...turn.parts.filter((p) => p.type !== "choices"), ...turn.parts.filter((p) => p.type === "choices")]} choices="waiting" />
            <p className="flex items-center gap-2 text-xs text-zinc-500">
              <Spinner /> {turn.parts.length ? "The AI is working…" : "The AI is thinking…"}
            </p>
          </div>
        )}
        <ErrorText error={error} />
      </div>

      <footer className="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        {nextSteps && entries.length > 0 && !running && (
          <NextSteps compact data={nextSteps} onSend={(p) => void submit(p)} onFill={fillBox} disabled={running} />
        )}
        {!claude.ready ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {claude.reason}{" "}
            <Link href={claude.setupHref} className="font-medium underline">
              {claude.setupLabel}
            </Link>
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-2"
          >
            <PendingChips pending={uploads.pending} onRemove={uploads.remove} />
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                // Pasting a copied photo or file attaches it.
                if (e.clipboardData.files.length) {
                  uploads.add(e.clipboardData.files);
                  if (!e.clipboardData.getData("text")) e.preventDefault();
                }
              }}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter starts a new line.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              maxLength={8000}
              placeholder={suggestions.placeholder}
              aria-label="Message to the AI"
              className={`${inputClass} resize-none text-sm h-25`}
            />
            <div className="flex items-center gap-2">
              <AttachButton onFiles={uploads.add} disabled={running} />
              <span className="text-xs text-zinc-500">{claude.costNote}</span>
              {running ? (
                <Button className="ml-auto" onClick={() => void stop()}>
                  Stop
                </Button>
              ) : (
                <Button type="submit" variant="primary" className="ml-auto" disabled={(!text.trim() && !uploads.ready.length) || uploads.uploading}>
                  {uploads.uploading ? "Uploading…" : "Send"}
                </Button>
              )}
            </div>
          </form>
        )}
      </footer>
    </aside>
  );
}

/** The "Make changes automatically" setting, as a switch under the panel's title. */
function AutoApplySwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="On: the AI's changes are made as soon as it answers. Off: you apply or skip each one."
      className="group mt-0.5 flex items-center gap-1.5 rounded text-xs text-zinc-600 focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-zinc-400"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${on ? "bg-foreground" : "bg-zinc-300 dark:bg-zinc-700"}`}
      >
        <span className={`absolute size-2.5 rounded-full bg-background shadow-sm transition-transform ${on ? "translate-x-3" : "translate-x-0.5"}`} />
      </span>
      <span className="truncate group-hover:text-foreground">{on ? "Makes changes automatically" : "Asks before each change"}</span>
    </button>
  );
}

/** A square button holding a 24×24 stroke icon (its paths are the children). */
function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    // Not <Button>: its padding would fight the fixed square size.
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
      {...props}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function Entry({
  entry,
  last,
  openCount,
  onApplyAll,
  onSkipAll,
  applyingAll,
  running,
}: {
  entry: DisplayEntry;
  last: boolean;
  openCount: number;
  onApplyAll: () => void;
  onSkipAll: () => void;
  applyingAll: boolean;
  running: boolean;
}) {
  if (entry.role === "user") {
    return (
      <div className="flex flex-col items-end gap-2">
        {entry.attachments?.length ? <SentAttachments attachments={entry.attachments} /> : null}
        {entry.text && (
          <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-foreground px-3 py-2 text-sm text-background">{entry.text}</p>
        )}
      </div>
    );
  }
  if (entry.role === "notice") {
    return <p className="text-center text-xs text-zinc-500">{entry.text}</p>;
  }
  // The AI's buttons always end its message, whenever it offered them; "Accept all" goes right under
  // the message's last card, before the rest of what the AI says.
  const parts = [...entry.parts.filter((p) => p.type !== "choices"), ...entry.parts.filter((p) => p.type === "choices")];
  const split = parts.findLastIndex((p) => p.type === "action") + 1;
  const offerCredits = last && !running;
  // Only the latest answer's buttons are shown, and they wait while the AI or its changes are working.
  const choices = !last ? "hidden" : running || applyingAll ? "waiting" : "ready";
  return (
    <div className="space-y-2">
      <Parts parts={parts.slice(0, split)} offerCredits={offerCredits} choices={choices} />
      {(openCount > 1 || (last && applyingAll)) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 p-2 dark:border-sky-900 dark:bg-sky-950/40">
          <span className="mr-auto text-xs text-zinc-700 dark:text-zinc-300">{applyingAll ? "Making the changes in order…" : `${openCount} changes are waiting for you.`}</span>
          {applyingAll ? (
            <Spinner />
          ) : (
            <>
              <Button variant="primary" className="text-xs" disabled={running} onClick={onApplyAll}>
                Accept all {openCount}
              </Button>
              <Button variant="ghost" className="text-xs" disabled={running} onClick={onSkipAll}>
                Skip all
              </Button>
            </>
          )}
        </div>
      )}
      <Parts parts={parts.slice(split)} offerCredits={offerCredits} choices={choices} />
      {entry.error && <p className="text-sm text-red-600 dark:text-red-400">{entry.error}</p>}
    </div>
  );
}

/**
 * `offerCredits`: show the buy-credits card under an out-of-credits note (only the latest answer's).
 * `choices`: whether the AI's buttons show, and whether they can be pressed yet.
 */
function Parts({ parts, offerCredits = false, choices = "hidden" }: { parts: AssistantPart[]; offerCredits?: boolean; choices?: ChoicesState }) {
  return (
    <>
      {parts.map((part, i) =>
        part.type === "text" ? (
          <div key={i} className="space-y-2">
            <RichText text={part.text} />
            {offerCredits && part.credits && <OutOfCredits reason={part.credits} />}
          </div>
        ) : part.type === "activity" ? (
          <p key={i} className="flex items-center gap-2 text-xs text-zinc-500">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-zinc-400" />
            {part.label}
          </p>
        ) : part.type === "choices" ? (
          choices !== "hidden" && <Choices key={i} part={part} waiting={choices === "waiting"} />
        ) : (
          <ActionCard key={part.id} id={part.id} />
        ),
      )}
    </>
  );
}

type ChoicesState = "hidden" | "waiting" | "ready";

/** The AI's question or next steps as buttons: pressing one sends its words as the owner's message. */
function Choices({ part, waiting }: { part: Extract<AssistantPart, { type: "choices" }>; waiting: boolean }) {
  const { send } = useAssistant();
  const [sent, setSent] = useState<string | null>(null);
  const question = part.kind === "question";
  return (
    <div className={question ? "rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" : ""}>
      <p className={question ? "text-sm font-medium" : "text-xs font-medium text-zinc-500"}>{question ? part.question : "What next?"}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {part.choices.map((choice) => (
          <button
            key={choice}
            type="button"
            disabled={waiting || sent !== null}
            onClick={async () => {
              setSent(choice);
              if (!(await send(choice))) setSent(null);
            }}
            className={`min-h-9 rounded-full border px-3 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              sent === choice
                ? "border-foreground bg-foreground text-background"
                : "border-zinc-300 hover:border-foreground hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            }`}
          >
            {choice}
          </button>
        ))}
      </div>
      {question && <p className="mt-2 text-xs text-zinc-500">{part.choices.length ? "Or type your own answer below." : "Type your answer below."}</p>}
    </div>
  );
}
