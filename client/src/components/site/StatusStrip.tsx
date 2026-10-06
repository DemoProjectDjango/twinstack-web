"use client";

import { useEffect, useState } from "react";
import { friendlyJobDone, friendlyJobLabel } from "@/lib/job-labels";
import { api } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, Spinner } from "./ui";

// How long "Done" stays up after a command succeeds.
const DONE_MS = 2500;

/**
 * What the site is doing right now, in a few words, pinned to the bottom of the screen. The full
 * command output lives on the Build tools screen, one click away, for when something goes wrong.
 */
export function StatusStrip({ onShowLog }: { onShowLog: () => void }) {
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
  let tone = "border-zinc-200 bg-background dark:border-zinc-800";
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
    tone = failed
      ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      : "border-zinc-200 bg-background dark:border-zinc-800";
    content = (
      <>
        <span aria-hidden="true">{failed ? "⚠" : "■"}</span>
        <span className="min-w-0 flex-1">
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
    tone = "border-green-300 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200";
    content = (
      <>
        <span aria-hidden="true">✓</span>
        <span className="min-w-0 flex-1 truncate">{friendlyJobDone(job!.command)}</span>
      </>
    );
  }

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      {content && (
        <div className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-lg ${tone}`}>
          {content}
        </div>
      )}
    </div>
  );
}
