"use client";

import Link from "next/link";
import { useState } from "react";
import { useSite } from "../site-context";
import { Button } from "../ui";
import { useAssistant } from "./AssistantProvider";
import { AttachButton, PendingChips, useAttachmentUploads, useFileDrop } from "./Attachments";
import { SUGGESTIONS } from "./suggestions";

/**
 * The one way to ask the AI: a bar pinned to the bottom of every screen (but the technical log).
 * Sending opens the conversation panel; the message carries the screen, so "this page" or "here"
 * means what the owner is looking at. "Conversation" opens and closes the panel without sending.
 */
export function AskClaude({ placeholder, suggestions }: { placeholder?: string; suggestions?: string[] }) {
  const { claude } = useSite();
  const { context, send, turn, open, setOpen } = useAssistant();
  const [text, setText] = useState("");
  const uploads = useAttachmentUploads();
  const drop = useFileDrop(uploads.add, claude.ready);
  const preset = SUGGESTIONS[context.page && context.screen === "pages" ? "page" : (context.screen as keyof typeof SUGGESTIONS)] ?? SUGGESTIONS.home;
  const items = suggestions ?? preset.items;
  const running = turn?.status === "running";

  const conversation = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-900"
    >
      {open ? "Hide conversation" : "Conversation"}
      {running && <span className="size-2 animate-pulse rounded-full bg-sky-500 motion-reduce:animate-none" aria-label="The AI is working" />}
    </button>
  );

  if (!claude.ready) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-background px-4 py-3 text-sm shadow-sm dark:border-zinc-700">
        <span aria-hidden="true">✦</span>
        <span className="text-zinc-600 dark:text-zinc-400">The AI can make changes for you: just describe what you want.</span>
        <Link href={claude.setupHref} className="font-medium underline">
          {claude.setupLabel}
        </Link>
        <span className="ml-auto">{conversation}</span>
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
      {...drop.handlers}
      className={`rounded-xl border bg-background p-2 shadow-lg shadow-black/5 ${drop.over ? "border-dashed border-foreground" : "border-zinc-200 dark:border-zinc-800"}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(text);
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <span aria-hidden="true" className="pl-2">
          ✦
        </span>
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
          className="min-w-0 flex-1 basis-48 rounded-md bg-transparent px-2 py-2 text-sm outline-none placeholder:text-zinc-500 focus-visible:ring-2 focus-visible:ring-zinc-300 dark:focus-visible:ring-zinc-700"
        />
        <AttachButton onFiles={uploads.add} disabled={running} label="＋ Add photo or file" />
        <Button type="submit" variant="primary" disabled={(!text.trim() && !uploads.ready.length) || running || uploads.uploading}>
          {uploads.uploading ? "Uploading…" : "Send"}
        </Button>
        {conversation}
      </form>
      {uploads.pending.length > 0 && (
        <div className="mt-2 px-1">
          <PendingChips pending={uploads.pending} onRemove={uploads.remove} />
        </div>
      )}
      {drop.over && <p className="mt-2 text-center text-xs font-medium">Drop files to attach them</p>}
      {items.length > 0 && !text && (
        // One row that scrolls sideways, so the bar stays small.
        <div className="mt-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {items.map((s) => (
            <button
              key={s}
              type="button"
              disabled={running}
              onClick={() => void submit(s)}
              title={uploads.ready.length ? "Sends this with your attached files" : undefined}
              className="shrink-0 rounded-full border border-zinc-300 bg-background px-2.5 py-1 text-xs text-zinc-600 hover:border-zinc-500 hover:text-foreground disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
