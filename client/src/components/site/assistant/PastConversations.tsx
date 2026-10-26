"use client";

import { useEffect, useState } from "react";
import { assistantApi, type PastConversation } from "@/lib/assistant-api";
import { confirmModal } from "@/lib/confirm";
import { useSite } from "../site-context";
import { ErrorText, Spinner } from "../ui";
import { useAssistant } from "./AssistantProvider";

// The panel's "Past conversations": the site's conversations the server keeps (the current one and
// the newest 30 archived), newest first. Opening one makes it the current conversation again; the
// current one joins the list.

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

function when(iso: string) {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 60) return relativeTime.format(-Math.max(minutes, 0), "minute");
  if (minutes < 24 * 60) return relativeTime.format(-Math.round(minutes / 60), "hour");
  const days = Math.round(minutes / (24 * 60));
  return days < 14 ? relativeTime.format(-days, "day") : dateFormat.format(date);
}

export function PastConversations({ onClose }: { onClose: () => void }) {
  const { owner, repo } = useSite();
  const { reopen } = useAssistant();
  const [list, setList] = useState<PastConversation[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    assistantApi
      .history(owner, repo)
      .then(({ conversations }) => !cancelled && setList(conversations))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  async function open(item: PastConversation) {
    if (item.current) return onClose();
    setBusy(item.id);
    if (await reopen(item.id)) onClose();
    else setBusy(null);
  }

  async function forget(item: PastConversation) {
    if (!(await confirmModal(`Delete “${item.title}”? Your site keeps every change you applied.`, { title: "Delete conversation", confirmLabel: "Delete", danger: true }))) return;
    setBusy(item.id);
    try {
      await assistantApi.forget(owner, repo, item.id);
      setList((l) => l?.filter((c) => c.id !== item.id) ?? l);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="rounded text-sm text-zinc-600 hover:text-foreground dark:text-zinc-400">
          ← Back
        </button>
        <h3 className="text-sm font-semibold">Past conversations</h3>
      </div>
      <ErrorText error={error} />
      {!list && !error && (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner /> Loading…
        </p>
      )}
      {list && !list.length && <p className="text-sm text-zinc-600 dark:text-zinc-400">No conversations yet. They appear here once you&apos;ve chatted with the AI.</p>}
      {list && list.length > 0 && (
        <ul className="space-y-2">
          {list.map((item) => (
            <li key={item.id} className="flex items-start gap-1 rounded-lg border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void open(item)}
                className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-900"
              >
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="mt-0.5 block text-xs text-zinc-500">
                  {item.current ? "Open now · " : ""}
                  {when(item.updatedAt)} · {item.entries} {item.entries === 1 ? "message" : "messages"}
                  {!item.continuable && " · the AI can’t carry this one on: a new message starts afresh"}
                </span>
              </button>
              {!item.current && (
                <button
                  type="button"
                  aria-label={`Delete “${item.title}”`}
                  title="Delete"
                  disabled={busy !== null}
                  onClick={() => void forget(item)}
                  className="m-1 grid size-8 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-900"
                >
                  {busy === item.id ? (
                    <Spinner />
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="m19 6-1 14H6L5 6" />
                    </svg>
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
