"use client";

import { useDeferredValue, useMemo } from "react";
import { diffLines, toHunks, type DiffLine } from "@/lib/line-diff";

const KIND_CLASS: Record<DiffLine["kind"], string> = {
  same: "",
  add: "bg-green-500/10 text-green-800 dark:text-green-300",
  del: "bg-red-500/10 text-red-800 dark:text-red-300",
};
const SIGN: Record<DiffLine["kind"], string> = { same: " ", add: "+", del: "-" };

/**
 * What the text in an editor changes compared with the file on disk, updated
 * as the user types. `before` is the saved file, `after` the editor's text.
 */
export function LiveDiff({ before, after, label }: { before: string; after: string; label: string }) {
  // Typing stays responsive on long files: the diff catches up between keystrokes.
  const deferred = useDeferredValue(after);
  const { hunks, added, removed } = useMemo(() => {
    const lines = diffLines(before, deferred);
    return {
      hunks: toHunks(lines),
      added: lines.filter((l) => l.kind === "add").length,
      removed: lines.filter((l) => l.kind === "del").length,
    };
  }, [before, deferred]);

  return (
    <div className="flex min-w-0 flex-col rounded-md border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-x-3 border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
        <span className="font-medium">{label}</span>
        {hunks.length ? (
          <span className="text-zinc-500">
            <span className="text-green-700 dark:text-green-400">+{added}</span>{" "}
            <span className="text-red-700 dark:text-red-400">−{removed}</span> lines
          </span>
        ) : (
          <span className="text-zinc-500">No changes</span>
        )}
        {deferred !== after && <span className="text-zinc-400">updating…</span>}
      </div>
      <div className={`max-h-[32rem] flex-1 overflow-auto font-mono text-xs leading-relaxed ${hunks.length ? "" : "hidden"}`}>
        {hunks.map((hunk, h) => (
          <div key={h} className={h ? "border-t border-dashed border-zinc-200 dark:border-zinc-800" : ""}>
            {hunk.lines.map((line, i) => (
              <div key={i} className={`flex whitespace-pre-wrap break-all ${KIND_CLASS[line.kind]}`}>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-zinc-400">{line.newNo ?? line.oldNo}</span>
                <span className="w-4 shrink-0 select-none">{SIGN[line.kind]}</span>
                <span className="min-w-0 flex-1 pr-2">{line.text || " "}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
