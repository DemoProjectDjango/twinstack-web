"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSite } from "../site-context";
import { useAssistant } from "./AssistantProvider";
import { AttachButton, PendingChips, useAttachmentUploads, useFileDrop } from "./Attachments";
import { ChatPreview } from "./ChatPreview";
import { SUGGESTIONS } from "./suggestions";

/**
 * The one way to ask the AI: a white card pinned to the bottom of every screen (but the technical
 * log). Sending opens the conversation; the message carries the screen, so "this page" or "here"
 * means what the owner is looking at. The top bar's "Chat with the AI" shows and hides it without sending.
 * A suggestion never sends by itself: it opens the conversation with the request in its box, for
 * the owner to change or send.
 */
export function AskClaude({ placeholder, suggestions }: { placeholder?: string; suggestions?: string[] }) {
  const { claude } = useSite();
  const { context, send, turn, fillDraft, setOpen } = useAssistant();
  const [text, setText] = useState("");
  // In use (focus inside it): the conversation so far and the past ones open above the box
  // (ChatPreview). A click elsewhere or Escape folds it again; a dialog it opened doesn't.
  const [expanded, setExpanded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target && !boxRef.current?.contains(target) && !target.closest?.('[role="dialog"], [role="alertdialog"]')) setExpanded(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [expanded]);
  const uploads = useAttachmentUploads();
  const drop = useFileDrop(uploads.add, claude.ready);
  const preset = SUGGESTIONS[context.page && context.screen === "pages" ? "page" : (context.screen as keyof typeof SUGGESTIONS)] ?? SUGGESTIONS.home;
  const items = suggestions ?? preset.items;
  const running = turn?.status === "running";

  // The ✦ in its tinted square, at the start of the box.
  const mark = (
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
      ✦
    </span>
  );

  if (!claude.ready) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2.5 rounded-[18px] bg-background p-3 text-sm text-zinc-600 shadow-[0_1px_2px_rgba(0,0,0,.06),0_10px_30px_rgba(21,21,26,.08)] dark:text-zinc-400">
        {mark}
        <span>The AI can make changes for you: just describe what you want.</span>
        <Link href={claude.setupHref} className="font-semibold text-foreground underline">
          {claude.setupLabel}
        </Link>
      </div>
    );
  }

  async function submit(value: string) {
    const message = value.trim();
    if ((!message && !uploads.ready.length) || running || uploads.uploading) return;
    if (await send(message, uploads.ready)) {
      setText("");
      uploads.clear();
    }
  }

  return (
    <div
      ref={boxRef}
      {...drop.handlers}
      onFocus={() => setExpanded(true)}
      className={`mx-auto w-full max-w-3xl rounded-[18px] bg-background p-3 shadow-[0_1px_2px_rgba(0,0,0,.06),0_10px_30px_rgba(21,21,26,.08)] ${drop.over ? "outline-2 outline-dashed outline-indigo-400" : ""}`}
    >
      {/* Opens upward (the bar sits at the foot of the window) by its row growing from 0 to its height. */}
      <div
        inert={!expanded}
        aria-hidden={!expanded}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <ChatPreview
            onOpenChat={() => {
              setExpanded(false);
              setOpen(true);
            }}
          />
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(text);
        }}
        className="flex items-center gap-2.5"
      >
        {mark}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={8000}
          placeholder={placeholder ?? preset.placeholder}
          aria-label="Tell the AI what to change"
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              uploads.add(e.clipboardData.files);
              if (!e.clipboardData.getData("text")) e.preventDefault();
            }
          }}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-foreground outline-none placeholder:text-zinc-500"
        />
        <AttachButton
          onFiles={uploads.add}
          disabled={running}
          className="grid size-9 shrink-0 place-items-center rounded-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-zinc-900"
          label={
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          }
        />
        <button
          type="submit"
          disabled={(!text.trim() && !uploads.ready.length) || running || uploads.uploading}
          className="h-9 shrink-0 rounded-[10px] bg-zinc-900 px-4 text-[13px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {uploads.uploading ? "Uploading…" : "Send"}
        </button>
      </form>
      {uploads.pending.length > 0 && (
        <div className="mt-2 pl-[2.625rem]">
          <PendingChips pending={uploads.pending} onRemove={uploads.remove} />
        </div>
      )}
      {drop.over && <p className="mt-2 pl-[2.625rem] text-xs font-medium">Drop files to attach them</p>}
      {items.length > 0 && !text && (
        // Under the message, lined up with it; one row that scrolls sideways, so the box stays small.
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {items.map((s) => (
            <button
              key={s}
              type="button"
              disabled={running}
              onClick={() => {
                // Files attached here stay with this bar's box, so the request goes there too.
                if (uploads.ready.length) setText(s);
                else fillDraft(s);
              }}
              className="shrink-0 rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-200 hover:text-foreground disabled:opacity-50 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
