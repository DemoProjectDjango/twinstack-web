"use client";

import { useEffect, useState } from "react";
import { api, workspacePath } from "@/lib/site-api";
import { useSite } from "../site-context";
import { Button } from "../ui";

// The window that shows a new site being built from its setup answers: the `site-build` job
// (server/src/setup-build.js), which runs without the assistant, so AiActivity never sees it. It
// follows the job's "▸ n/total …" lines as a list of steps with a clock, can be sent to the
// background (a pill at the top), and if the build stops, says what didn't work and offers to try
// again (the build's plan is kept until it finishes). A build cut short where this tab didn't see
// it (the server restarted, which ends every job, or the editor was closed) is offered again when
// the site opens: GET …/setup/build says there's one, and it carries on from where it stopped.

type Step = { text: string; state: "done" | "working" | "failed" };

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The build's steps so far, from its log. */
function stepsOf(output: string, status: string): Step[] {
  const lines = (output.match(/^▸ .+$/gm) ?? []).map((l) => l.slice(2)).filter((l) => l !== "Done");
  return lines.map((line, i) => ({
    text: line.replace(/^\d+\/\d+\s+/, ""),
    state: i < lines.length - 1 || status === "succeeded" ? "done" : status === "running" ? "working" : "failed",
  }));
}

/** Why the build stopped, in the job's own words: its last "!" lines, or its final message. */
function failureOf(output: string) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const said = lines.filter((l) => /^!/.test(l) || /couldn't|refused|failed|error/i.test(l)).slice(-3);
  return (said.length ? said : lines.slice(-2)).map((l) => l.replace(/^!\s*/, "")).join(" ");
}

export function SiteBuildActivity() {
  const { owner, repo, job, busy, version, run, showSection } = useSite();
  const build = job?.command === "site-build" ? job : null;
  // An unfinished build this tab didn't start, checked whenever the site changes and nothing runs.
  const [pending, setPending] = useState(false);
  const [notNow, setNotNow] = useState(false);
  useEffect(() => {
    if (busy) return;
    let live = true;
    api<{ pending: boolean }>(workspacePath(owner, repo, "/setup/build"))
      .then((r) => live && setPending(r.pending))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [owner, repo, busy, version]);
  const [background, setBackground] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [started, setStarted] = useState<{ id: string; at: number } | null>(null);
  const [now, setNow] = useState(0);

  // The clock starts when this tab first sees the build, and ticks while it runs.
  useEffect(() => {
    if (!build || build.status !== "running") return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      setStarted((s) => (s?.id === build.id ? s : { id: build.id, at }));
    }, 1000);
    return () => clearInterval(timer);
  }, [build]);

  if ((!build || build.status !== "running") && pending && !notNow && !busy && !(build && build.status === "failed" && closed !== build.id)) {
    return (
      <div className="absolute inset-0 z-40 flex items-start justify-center rounded-2xl bg-background/60 px-4 backdrop-blur-[2px]">
        <div role="dialog" aria-labelledby="site-build-pending" className="sticky top-[30vh] my-8 w-full max-w-sm rounded-2xl border border-zinc-200 bg-background p-8 text-center shadow-2xl dark:border-zinc-800">
          <span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-full bg-zinc-100 text-lg dark:bg-zinc-900">
            ✦
          </span>
          <h2 id="site-build-pending" className="mt-4 font-semibold">
            Finish building your site
          </h2>
          <p className="mt-1 text-sm text-zinc-500">Building your site stopped before it finished. What was done is kept: the AI carries on from there.</p>
          <div className="mt-6 flex flex-col gap-2">
            <Button
              variant="primary"
              className="py-2"
              onClick={() => {
                setPending(false);
                void run("site-build");
              }}
            >
              Finish building
            </Button>
            <Button variant="ghost" className="text-zinc-500" onClick={() => setNotNow(true)}>
              Not now
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (!build || closed === build.id) return null;
  const running = build.status === "running";
  const failed = build.status === "failed" || build.status === "cancelled";
  if (!running && !failed) return null;
  const steps = stepsOf(build.output, build.status);
  const current = steps.find((s) => s.state === "working");
  const elapsed = started?.id === build.id ? now - started.at : 0;
  const hidden = running && background === build.id;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setBackground(null)}
        aria-label={`Building your site: ${current?.text ?? "starting"}. Show progress`}
        className="fixed left-1/2 top-16 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background shadow-lg"
      >
        <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-background/30 border-t-background motion-reduce:animate-none" />
        <span className="max-w-[60vw] truncate">{current?.text ?? "Starting"}…</span>
        <span aria-hidden="true" className="font-mono tabular-nums text-background/70">
          {clock(elapsed)}
        </span>
      </button>
    );
  }

  const list = steps.length > 0 && (
    <ol className="mx-auto mt-4 max-w-72 space-y-1.5 text-left text-sm" aria-label="The steps">
      {steps.map((s, i) => (
        <li key={i} className={`flex items-center gap-2 ${s.state === "working" ? "font-medium" : s.state === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
          <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-xs">
            {s.state === "working" ? <span className="size-3 animate-spin rounded-full border-2 border-zinc-200 border-t-foreground motion-reduce:animate-none dark:border-zinc-800" /> : s.state === "done" ? "✓" : "✕"}
          </span>
          <span className="truncate">{s.text}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center rounded-2xl bg-background/60 px-4 backdrop-blur-[2px]">
      <div role="status" aria-live="polite" className="sticky top-[30vh] my-8 w-full max-w-sm rounded-2xl border border-zinc-200 bg-background shadow-2xl dark:border-zinc-800">
        {failed ? (
          <div className="p-8 text-center">
            <h2 className="font-semibold">{build.status === "cancelled" ? "The build was stopped" : "Your site couldn't be built"}</h2>
            <p className="mt-1 text-sm text-zinc-500">{build.status === "cancelled" ? "Nothing after the last tick was made." : failureOf(build.output)}</p>
            {list}
            <div className="mt-6 flex flex-col gap-2">
              <Button
                variant="primary"
                className="py-2"
                onClick={() => {
                  setClosed(build.id);
                  void run("site-build");
                }}
              >
                Try again
              </Button>
              <div className="flex justify-center gap-1">
                <Button variant="ghost" className="text-zinc-500" onClick={() => showSection("tools")}>
                  See the log
                </Button>
                <Button variant="ghost" className="text-zinc-500" onClick={() => setClosed(build.id)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center">
            <div className="relative mx-auto size-14">
              <span aria-hidden="true" className="absolute inset-0 animate-spin rounded-full border-[3px] border-zinc-200 border-t-foreground motion-reduce:animate-none dark:border-zinc-800" />
              <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-lg">
                ✦
              </span>
            </div>
            <h2 className="mt-5 font-semibold">The AI is building your site</h2>
            <p className="mt-1 min-h-5 text-sm text-zinc-500">{current?.text ?? "Getting started"}…</p>
            <p aria-hidden="true" className="mt-3 font-mono text-2xl font-semibold tabular-nums tracking-tight">
              {clock(elapsed)}
            </p>
            {list}
            <p className="mt-3 text-xs text-zinc-400">Your homepage takes a few minutes: it&apos;s designed, then looked at on a computer and a phone and improved.</p>
            <p className="mt-2 text-xs text-zinc-400">Nothing goes live until you publish.</p>
            <div className="mt-6 flex flex-col gap-2">
              <Button className="py-2" onClick={() => setBackground(build.id)}>
                Keep working in the background
              </Button>
              <div className="flex justify-center gap-1">
                <Button variant="ghost" className="text-zinc-500" onClick={() => showSection("tools")}>
                  See the log
                </Button>
                <Button variant="ghost" className="text-zinc-500" onClick={() => void api(`/api/jobs/${build.id}/cancel`, { method: "POST", body: {} }).catch(() => {})}>
                  Stop
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
