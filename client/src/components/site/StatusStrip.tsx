"use client";

import { useEffect, useState } from "react";
import { friendlyJobDone, friendlyJobLabel } from "@/lib/job-labels";
import { api } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, Spinner } from "./ui";

// How long "Done" stays up after a command succeeds.
const DONE_MS = 2500;

// The colours that flow around the strip's border (`.status-strip-border` in globals.css).
type Flow = "working" | "done" | "failed" | "cancelled";

/**
 * What the site is doing right now, in a few words, pinned to the bottom of the screen. The full
 * command output lives on the Build tools screen, one click away, for when something goes wrong.
 * While it's showing, a streak of the status's colour glides around its thin border, so it's noticed.
 * `inline` puts it in the page's flow instead (above the AI bar, which is pinned to the bottom).
 */
export function StatusStrip({ onShowLog, inline = false }: { onShowLog: () => void; inline?: boolean }) {
  const { job, status } = useSite();
  const [dismissed, setDismissed] = useState<string | null>(null);
  // The succeeded job whose "Done" has been up long enough.
  const [doneHidden, setDoneHidden] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const finishedOk = job?.status === "succeeded" ? job.id : null;
  useEffect(() => {
    if (!finishedOk) return;
    const timer = setTimeout(() => setDoneHidden(finishedOk), DONE_MS);
    return () => clearTimeout(timer);
  }, [finishedOk]);

  async function cancel() {
    if (!job) return;
    setCancelling(true);
    await api(`/api/jobs/${job.id}/cancel`, { method: "POST", body: {} }).catch(() => {});
    setCancelling(false);
  }

  let content: React.ReactNode = null;
  let flow: Flow = "working";
  // A check that fails has found problems, not gone wrong: the Publish screen lists them, and Build tools shows its log.
  const foundProblems = job?.command === "check" && job.status === "failed";

  if (job?.status === "running") {
    content = (
      <>
        <Spinner />
        <span className="min-w-0 flex-1 truncate">{friendlyJobLabel(job.command, job.label)}…</span>
        <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={cancel} disabled={cancelling}>
          Cancel
        </Button>
      </>
    );
  } else if (status.busy && !job) {
    content = (
      <>
        <Spinner />
        <span className="min-w-0 flex-1 truncate">Busy: {status.busy}…</span>
      </>
    );
  } else if (job && (job.status === "failed" || job.status === "cancelled") && dismissed !== job.id && !foundProblems) {
    const failed = job.status === "failed";
    flow = failed ? "failed" : "cancelled";
    content = (
      <>
        <span aria-hidden="true" className={failed ? "text-red-600 dark:text-red-400" : "text-zinc-400"}>
          {failed ? "⚠" : "■"}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {friendlyJobLabel(job.command, job.label)} {failed ? "didn't work." : "was cancelled."}
        </span>
        {failed && (
          <Button variant="ghost" className="px-2 py-0.5 text-xs underline" onClick={onShowLog}>
            See what happened
          </Button>
        )}
        <Button variant="ghost" className="px-2 py-0.5 text-xs" aria-label="Dismiss" onClick={() => setDismissed(job.id)}>
          ✕
        </Button>
      </>
    );
  } else if (finishedOk && doneHidden !== finishedOk) {
    flow = "done";
    content = (
      <>
        <span aria-hidden="true" className="text-green-600 dark:text-green-400">
          ✓
        </span>
        <span className="min-w-0 flex-1 truncate">{friendlyJobDone(job!.command)}</span>
      </>
    );
  }

  return (
    <div aria-live="polite" className={inline ? "pointer-events-none flex justify-center" : "pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"}>
      {content && (
        <div className="status-strip-border pointer-events-auto w-full max-w-md rounded-lg p-px shadow-md shadow-black/5" data-flow={flow}>
          {/* One fixed height for every status, with or without buttons. */}
          <div className="flex h-11 items-center gap-3 rounded-[7px] bg-background px-4 text-sm">{content}</div>
        </div>
      )}
    </div>
  );
}
