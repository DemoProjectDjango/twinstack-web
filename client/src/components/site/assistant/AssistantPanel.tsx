"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AssistantPart, DisplayEntry } from "@/lib/assistant-api";
import { useSite } from "../site-context";
import { Button, ErrorText, Spinner, inputClass } from "../ui";
import { ActionCard } from "./ActionCard";
import { AttachButton, PendingChips, SentAttachments, useAttachmentUploads, useFileDrop } from "./Attachments";
import { useAssistant } from "./AssistantProvider";
import { RichText } from "./RichText";
import { SUGGESTIONS } from "./suggestions";

// The conversation with Claude, in a panel beside the editor (full screen on a phone). It follows
// the owner from screen to screen; each message tells Claude which screen they're on.

export function AssistantPanel() {
  const { claude } = useSite();
  const { context, conversation, turn, loading, error, open, setOpen, send, stop, startOver, actions, applyAll, applyingAll, autoApply, setAutoApply } = useAssistant();
  const [text, setText] = useState("");
  const uploads = useAttachmentUploads();
  const drop = useFileDrop(uploads.add, claude.ready);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const running = turn?.status === "running";

  // Follow the conversation as it grows, like a chat.
  const size = JSON.stringify([conversation?.display.length, turn?.parts]).length;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [size, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

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
  const suggestions = SUGGESTIONS[context.page ? "page" : (context.screen as keyof typeof SUGGESTIONS)] ?? SUGGESTIONS.home;

  return (
    <aside
      aria-label="Ask Claude"
      {...drop.handlers}
      className="fixed inset-0 z-50 flex flex-col border-zinc-200 bg-background sm:inset-auto sm:bottom-0 sm:right-0 sm:top-14 sm:w-[27rem] sm:border-l sm:shadow-xl dark:border-zinc-800"
    >
      {drop.over && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-lg border-2 border-dashed border-foreground bg-background/90 text-sm font-medium">
          Drop files to attach them
        </div>
      )}
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span aria-hidden="true">✦</span>
        <h2 className="font-semibold">Ask Claude</h2>
        <span className="ml-auto flex items-center gap-1">
          <label
            className="mr-1 flex cursor-pointer items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400"
            title="On: Claude's changes are made as soon as it answers. Off: you apply or skip each one."
          >
            <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
            Make changes automatically
          </label>
          {conversation && (
            <Button variant="ghost" className="px-2 py-1 text-xs" disabled={running} onClick={() => void startOver()}>
              New conversation
            </Button>
          )}
          <Button variant="ghost" className="px-2 py-1" aria-label="Close" onClick={() => setOpen(false)}>
            ✕
          </Button>
        </span>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {loading && <p className="text-sm text-zinc-500">Loading…</p>}

        {!loading && !entries.length && !running && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Tell Claude what you want, in your own words: new pages, changes to wording, the menu, search results and more.
              You can attach photos, PDFs, Word documents or any other file. Claude shows you every change first, and nothing
              happens until you press Apply.
            </p>
            {claude.ready && (
              <div className="flex flex-col items-start gap-2">
                {suggestions.items.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void submit(s)}
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
            onApplyAll={() => applyAll(entry)}
            openCount={entry.role === "assistant" ? entry.parts.filter((p) => p.type === "action" && actions[p.id]?.status === "proposed").length : 0}
            applyingAll={applyingAll}
            running={running}
          />
        ))}

        {running && turn && (
          <div className="space-y-2">
            <Parts parts={turn.parts} />
            <p className="flex items-center gap-2 text-xs text-zinc-500">
              <Spinner /> {turn.parts.length ? "Claude is working…" : "Claude is thinking…"}
            </p>
          </div>
        )}
        <ErrorText error={error} />
      </div>

      <footer className="border-t border-zinc-200 p-3 dark:border-zinc-800">
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
              aria-label="Message to Claude"
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

function Entry({
  entry,
  last,
  openCount,
  onApplyAll,
  applyingAll,
  running,
}: {
  entry: DisplayEntry;
  last: boolean;
  openCount: number;
  onApplyAll: () => void;
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
  return (
    <div className="space-y-2">
      <Parts parts={entry.parts} />
      {entry.error && <p className="text-sm text-red-600 dark:text-red-400">{entry.error}</p>}
      {openCount > 1 && last && (
        <Button variant="primary" className="text-xs" disabled={applyingAll || running} onClick={onApplyAll}>
          {applyingAll ? "Applying in order…" : `Apply all ${openCount} in order`}
        </Button>
      )}
    </div>
  );
}

function Parts({ parts }: { parts: AssistantPart[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.type === "text" ? (
          <RichText key={i} text={part.text} />
        ) : part.type === "activity" ? (
          <p key={i} className="flex items-center gap-2 text-xs text-zinc-500">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-zinc-400" />
            {part.label}
          </p>
        ) : (
          <ActionCard key={part.id} id={part.id} />
        ),
      )}
    </>
  );
}
