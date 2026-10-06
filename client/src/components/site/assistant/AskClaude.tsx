"use client";

import Link from "next/link";
import { useState } from "react";
import { useSite } from "../site-context";
import { Button } from "../ui";
import { useAssistant } from "./AssistantProvider";
import { AttachButton, PendingChips, useAttachmentUploads, useFileDrop } from "./Attachments";
import { SUGGESTIONS } from "./suggestions";

/**
 * "Tell Claude what you want", at the top of a screen. Sending opens the conversation panel; the
 * message carries the screen, so "this page" or "here" means what the owner is looking at.
 */
export function AskClaude({ placeholder, suggestions }: { placeholder?: string; suggestions?: string[] }) {
  const { claude } = useSite();
  const { context, send, turn } = useAssistant();
  const [text, setText] = useState("");
  const uploads = useAttachmentUploads();
  const drop = useFileDrop(uploads.add, claude.ready);
  const preset = SUGGESTIONS[context.page ? "page" : (context.screen as keyof typeof SUGGESTIONS)] ?? SUGGESTIONS.home;
  const items = suggestions ?? preset.items;
  const running = turn?.status === "running";

  if (!claude.ready) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
        <span aria-hidden="true">✦</span>
        <span className="text-zinc-600 dark:text-zinc-400">Claude can do this for you: just describe what you want.</span>
        <Link href={claude.setupHref} className="font-medium underline">
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
      {...drop.handlers}
      className={`rounded-lg border bg-zinc-50 p-3 dark:bg-zinc-900/50 ${drop.over ? "border-dashed border-foreground" : "border-zinc-200 dark:border-zinc-800"}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(text);
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <span aria-hidden="true" className="pl-1">
          ✦
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={8000}
          placeholder={placeholder ?? preset.placeholder}
          aria-label="Ask Claude"
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              uploads.add(e.clipboardData.files);
              if (!e.clipboardData.getData("text")) e.preventDefault();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-background px-3 py-2 text-sm dark:border-zinc-700"
        />
        <AttachButton onFiles={uploads.add} disabled={running} />
        <Button type="submit" variant="primary" disabled={(!text.trim() && !uploads.ready.length) || running || uploads.uploading}>
          {uploads.uploading ? "Uploading…" : "Ask Claude"}
        </Button>
      </form>
      {uploads.pending.length > 0 && (
        <div className="mt-2">
          <PendingChips pending={uploads.pending} onRemove={uploads.remove} />
        </div>
      )}
      {drop.over && <p className="mt-2 text-center text-xs font-medium">Drop files to attach them</p>}
      {items.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.map((s) => (
            <button
              key={s}
              type="button"
              disabled={running}
              onClick={() => void submit(s)}
              title={uploads.ready.length ? "Sends this with your attached files" : undefined}
              className="rounded-full border border-zinc-300 bg-background px-2.5 py-1 text-xs text-zinc-600 hover:border-zinc-500 hover:text-foreground disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
