"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type Publishing, type WorkspaceStatus } from "@/lib/site-api";
import { DomainSettings } from "./DomainSettings";
import { useSite } from "./site-context";
import { Button, ErrorText } from "./ui";

// While a deploy runs, and for a while after anything changes (a push starts a
// run a few seconds later), GitHub is asked again every few seconds.
const FAST_POLL_MS = 8000;
const SLOW_POLL_MS = 60000;
const WATCH_AFTER_CHANGE_MS = 90000;

type DeployState = { label: string; tone: string };

function deployState(p: Publishing): DeployState | null {
  const run = p.run;
  if (!run) return null;
  if (run.status !== "completed") return { label: run.status === "in_progress" ? "Deploying…" : "Deploy queued…", tone: "text-sky-700 dark:text-sky-400" };
  if (run.conclusion === "success") return { label: "Live", tone: "text-green-700 dark:text-green-400" };
  if (run.conclusion === "cancelled") return { label: "Last deploy cancelled", tone: "text-zinc-500" };
  return { label: "Last deploy failed", tone: "text-red-700 dark:text-red-400" };
}

/** The copy's live GitHub Pages URL and deploy status, shown above the site manager's tabs. */
export function PublishBar() {
  const { owner, repo, busy, version, setStatus, refresh } = useSite();
  const [publishing, setPublishing] = useState<Publishing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<"enable" | "deploy" | "update" | null>(null);
  // When something last changed; the poll speeds up for a while after it.
  const changedAt = useRef(0);
  const [updated, setUpdated] = useState(false);

  // Bumped by the poll timer to fetch again.
  const [tick, setTick] = useState(0);

  // Anything that may have pushed (a commit, a reset) bumps `version`.
  useEffect(() => {
    changedAt.current = Date.now();
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    api<Publishing>(workspacePath(owner, repo, "/publishing"))
      .then((next) => {
        if (cancelled) return;
        setPublishing(next);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version, tick]);

  const running = publishing?.run ? publishing.run.status !== "completed" : false;
  useEffect(() => {
    // Re-armed after every fetch, since each one sets `publishing` or `error`.
    const fast = running || Date.now() - changedAt.current < WATCH_AFTER_CHANGE_MS;
    const timer = setTimeout(() => setTick((t) => t + 1), fast ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => clearTimeout(timer);
  }, [publishing, error, running]);

  async function act(kind: "enable" | "deploy" | "update") {
    setWorking(kind);
    setError(null);
    try {
      if (kind === "update") {
        const result = await api<{ written: string[]; status: WorkspaceStatus }>(
          workspacePath(owner, repo, "/install/publishing"),
          { method: "POST", body: {} },
        );
        setStatus(result.status);
        setUpdated(true);
        await refresh();
      } else {
        setPublishing(
          await api<Publishing>(workspacePath(owner, repo, `/publishing/${kind}`), { method: "POST", body: {} }),
        );
        changedAt.current = Date.now();
      }
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  if (!publishing) {
    return error ? <ErrorText error={error} /> : null;
  }

  const state = deployState(publishing);
  const locked = busy || working !== null;

  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">Live site</span>
        {publishing.enabled && publishing.url ? (
          <a href={publishing.url} target="_blank" rel="noreferrer" className="break-all font-mono text-xs underline">
            {publishing.url}
          </a>
        ) : (
          <span className="text-zinc-500">Not published yet</span>
        )}
        {publishing.enabled && state && (
          <a href={publishing.run!.url} target="_blank" rel="noreferrer" className={`text-xs hover:underline ${state.tone}`}>
            {state.label}
            {publishing.run!.commit && <span className="text-zinc-500"> · {publishing.run!.commit}</span>}
          </a>
        )}
        <span className="ml-auto flex flex-wrap gap-2">
          {(!publishing.enabled || !publishing.usesActions) && publishing.canConfigure && (
            <Button variant="primary" className="text-xs" disabled={locked} onClick={() => void act("enable")}>
              {working === "enable" ? "Turning on…" : "Turn on publishing"}
            </Button>
          )}
          {publishing.enabled && publishing.workflowReady && !running && (
            <Button className="text-xs" disabled={locked} onClick={() => void act("deploy")}>
              {working === "deploy" ? "Starting…" : "Deploy again"}
            </Button>
          )}
        </span>
      </div>

      {!publishing.workflowReady && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          {updated ? (
            <>
              Publishing files updated. Commit and push them to <code className="font-mono">{publishing.defaultBranch}</code> on
              the Changes tab, and the site deploys.
            </>
          ) : (
            <>
              This copy was made before sites could publish on github.io, so its links would break there.{" "}
              <Button variant="ghost" className="px-1 py-0 text-xs underline" disabled={locked} onClick={() => void act("update")}>
                {working === "update" ? "Updating…" : "Update publishing files from the template"}
              </Button>{" "}
              replaces <code className="font-mono">.github/workflows/deploy.yml</code>,{" "}
              <code className="font-mono">scripts/build.js</code>, <code className="font-mono">scripts/check.js</code> and{" "}
              <code className="font-mono">scripts/lib/content.js</code> with the template&apos;s versions, as changes you review
              and push on the Changes tab.
            </>
          )}
        </p>
      )}
      {publishing.enabled && publishing.workflowReady && (
        <p className="mt-1 text-xs text-zinc-500">
          Every push to <code className="font-mono">{publishing.defaultBranch}</code> deploys the site. A pull request deploys once
          it&apos;s merged.
        </p>
      )}
      {!publishing.enabled && publishing.private && (
        <p className="mt-1 text-xs text-zinc-500">
          GitHub Pages for a private repository needs a paid GitHub plan. If turning it on fails, make the repository public or
          upgrade the plan.
        </p>
      )}
      <ErrorText error={error} />
      {publishing.enabled && publishing.canConfigure && (
        <DomainSettings
          publishing={publishing}
          onChange={(next) => {
            setPublishing(next);
            // A domain change starts a redeploy: watch it closely.
            changedAt.current = Date.now();
          }}
        />
      )}
    </div>
  );
}
