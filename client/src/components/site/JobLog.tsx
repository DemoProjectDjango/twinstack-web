"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button } from "./ui";

const STATUS_STYLES = {
  running: "text-zinc-500",
  succeeded: "text-green-700 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
  cancelled: "text-zinc-500",
};

export function JobLog() {
  const { job, status } = useSite();
  const outputRef = useRef<HTMLPreElement>(null);
  const [cancelling, setCancelling] = useState(false);

  // Follow new output, like a terminal.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job?.output]);

  async function cancel() {
    if (!job) return;
    setCancelling(true);
    await api(`/api/jobs/${job.id}/cancel`, { method: "POST", body: {} }).catch(() => {});
    setCancelling(false);
  }

  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <h3 className="text-sm font-semibold">Output</h3>
          {job && (
            <span className={`text-xs ${STATUS_STYLES[job.status]}`}>
              {job.label} · {job.status === "running" ? "running…" : job.status}
            </span>
          )}
          {job?.status === "running" && (
            <Button variant="ghost" className="ml-auto px-2 py-0.5 text-xs" onClick={cancel} disabled={cancelling}>
              Cancel
            </Button>
          )}
        </div>
        <pre
          ref={outputRef}
          className="h-[28rem] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-zinc-700 dark:text-zinc-300"
        >
          {job?.output ||
            (status.busy && !job
              ? `Busy: ${status.busy}`
              : "Command output appears here. Every change stays in this workspace until you commit it on the Changes tab.")}
        </pre>
      </div>
    </aside>
  );
}
