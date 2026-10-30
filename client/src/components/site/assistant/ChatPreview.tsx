"use client";

import { useEffect, useRef, useState } from "react";
import type { AssistantAction, AssistantPart, DisplayEntry } from "@/lib/assistant-api";
import { ErrorText, Spinner } from "../ui";
import { useAssistant } from "./AssistantProvider";
import { PastConversations } from "./PastConversations";
import { RichText } from "./RichText";

// What the AI bar under the screen shows above its box while it's in use (AskClaude's `expanded`):
// the latest messages of the conversation, what the AI is doing now, and the past conversations,
// with a way into the full chat on the right. Small on purpose: the full chat has everything.

// How many of the latest messages it shows.
const SHOWN_ENTRIES = 6;

const STATUS: Record<AssistantAction["status"], { label: string; className: string }> = {
  proposed: { label: "Waiting", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400" },
  running: { label: "Working", className: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" },
  ready: { label: "Ready to keep", className: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  applied: { label: "Done", className: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300" },
  skipped: { label: "Skipped", className: "bg-zinc-100 text-zinc-500 dark:bg-zinc-900" },
  failed: { label: "Didn't work", className: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" },
};

/** One of the AI's message parts, in a line or a few: its text, a change and how it went, or what it's doing. */
function Part({ part, actions }: { part: AssistantPart; actions: Record<string, AssistantAction> }) {
  if (part.type === "text") {
    return (
      // A few lines of it, fading out: the full chat has the rest.
      <div className="max-h-[6.5rem] overflow-hidden text-zinc-700 [mask-image:linear-gradient(to_bottom,black_5rem,transparent_6.5rem)] dark:text-zinc-300">
        <RichText text={part.text} />
      </div>
    );
  }
  if (part.type === "action") {
    const action = actions[part.id];
    if (!action) return null;
    const status = STATUS[action.status];
    return (
      <p className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <span className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${status.className}`}>{status.label}</span>
        <span className="min-w-0">
          <span className="font-medium text-foreground">{action.title}</span>
          {action.summary ? ` · ${action.summary}` : ""}
        </span>
      </p>
    );
  }
  if (part.type === "choices" && part.question) return <p className="text-sm text-zinc-700 dark:text-zinc-300">{part.question}</p>;
  return null;
}

function Entry({ entry, actions }: { entry: DisplayEntry; actions: Record<string, AssistantAction> }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="line-clamp-3 max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-100 px-3 py-1.5 text-sm dark:bg-zinc-900">
          {entry.text || `${entry.attachments?.length ?? 0} file${entry.attachments?.length === 1 ? "" : "s"}`}
        </p>
      </div>
    );
  }
  if (entry.role === "notice") return <p className="text-center text-xs text-zinc-500">{entry.text}</p>;
  return (
    <div className="space-y-1.5">
      {entry.parts.map((part, i) => (
        <Part key={i} part={part} actions={actions} />
      ))}
      {entry.error && <p className="text-xs text-red-600 dark:text-red-400">{entry.error}</p>}
    </div>
  );
}

export function ChatPreview({ onOpenChat }: { onOpenChat: () => void }) {
  const { conversation, turn, actions, loading, error, startOver } = useAssistant();
  const [view, setView] = useState<"chat" | "past">("chat");
  const listRef = useRef<HTMLDivElement>(null);

  const entries = conversation?.display ?? [];
  const shown = entries.slice(-SHOWN_ENTRIES);
  const running = turn?.status === "running";
  // The running turn's latest activity ("Reading the homepage…"), until its answer is saved.
  const doing = running ? [...(turn.parts ?? [])].reverse().find((p) => p.type === "activity") : null;

  // The newest message in view, as in a chat.
  const size = JSON.stringify([entries.length, turn?.id, turn?.status, turn?.parts.length, view]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [size]);

  const tab = (id: typeof view, label: string) => (
    <button
      type="button"
      onClick={() => setView(id)}
      aria-pressed={view === id}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium ${view === id ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mb-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {tab("chat", "This conversation")}
        {tab("past", "Past conversations")}
        <span className="ml-auto flex items-center gap-1">
          {entries.length > 0 && (
            <button
              type="button"
              disabled={running}
              onClick={() => void startOver().then(() => setView("chat"))}
              className="rounded-lg px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-foreground disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              New conversation
            </button>
          )}
          <button
            type="button"
            onClick={onOpenChat}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950"
          >
            Open full chat →
          </button>
        </span>
      </div>

      <div ref={listRef} className="max-h-[min(22rem,45vh)] overflow-y-auto pr-1">
        {view === "past" ? (
          <PastConversations onClose={() => setView("chat")} />
        ) : loading ? (
          <p className="flex items-center gap-2 py-2 text-sm text-zinc-500">
            <Spinner /> Loading your conversation…
          </p>
        ) : (
          <div className="space-y-3">
            <ErrorText error={error} />
            {!shown.length && !running && (
              <p className="py-1 text-sm text-zinc-600 dark:text-zinc-400">
                No messages yet. Tell the AI what to change below: it can write pages, change your design and fix problems.
              </p>
            )}
            {entries.length > shown.length && (
              <button type="button" onClick={onOpenChat} className="text-xs text-zinc-500 hover:text-foreground hover:underline">
                {entries.length - shown.length} earlier {entries.length - shown.length === 1 ? "message" : "messages"}: open the full chat to see {entries.length - shown.length === 1 ? "it" : "them"}
              </button>
            )}
            {shown.map((entry) => (
              <Entry key={entry.id} entry={entry} actions={actions} />
            ))}
            {running && (
              <p className="flex items-center gap-2 text-sm text-zinc-500">
                <Spinner /> {doing?.type === "activity" ? doing.label : "Thinking…"}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
