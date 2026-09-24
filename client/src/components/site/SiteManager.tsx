"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, workspacePath, type Job, type Overview, type WorkspaceStatus } from "@/lib/site-api";
import { BuildPanel } from "./BuildPanel";
import { ChangesPanel } from "./ChangesPanel";
import { EditPanel } from "./EditPanel";
import { JobLog } from "./JobLog";
import { NavPanel } from "./NavPanel";
import { PagesPanel } from "./PagesPanel";
import { SchedulePanel } from "./SchedulePanel";
import { SiteContext, type SiteContextValue } from "./site-context";
import { StaticInfoPanel } from "./StaticInfoPanel";
import { TreePanel } from "./TreePanel";
import { Badge, Button, ErrorText, Notice } from "./ui";

const TABS = [
  { id: "build", label: "Build & preview" },
  { id: "pages", label: "Pages" },
  { id: "navigation", label: "Navigation" },
  { id: "info", label: "Site info" },
  { id: "edit", label: "Edit with Claude" },
  { id: "tree", label: "Site tree" },
  { id: "schedule", label: "Schedule" },
  { id: "changes", label: "Changes" },
] as const;

type Tab = (typeof TABS)[number]["id"];

const POLL_MS = 700;
const MAX_LOG_CHARS = 500_000;

function runningJob(active: NonNullable<WorkspaceStatus["activeJob"]>): Job {
  return { ...active, status: "running", exitCode: null, output: "", truncated: false, next: 0 };
}

export function SiteManager({ owner, repo }: { owner: string; repo: string }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("build");
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    const [nextStatus, nextOverview] = await Promise.all([
      api<WorkspaceStatus>(workspacePath(owner, repo)),
      api<Overview>(workspacePath(owner, repo, "/overview")).catch(() => null),
    ]);
    setStatus(nextStatus);
    setOverview(nextOverview);
    setVersion((v) => v + 1);
  }, [owner, repo]);

  const run = useCallback(
    async (command: string, input: Record<string, unknown> = {}) => {
      setRunError(null);
      try {
        const { job: started } = await api<{ job: Job }>(workspacePath(owner, repo, `/commands/${command}`), {
          method: "POST",
          body: { input },
        });
        setJob(started);
        return true;
      } catch (err) {
        setRunError(err);
        return false;
      }
    },
    [owner, repo],
  );

  // Open (clone or fetch) once, then install dependencies if the lockfile changed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [opened, settings] = await Promise.all([
          api<WorkspaceStatus>(workspacePath(owner, repo, "/open"), { method: "POST", body: {} }),
          api<{ anthropicKey: string | null }>("/api/settings"),
        ]);
        if (cancelled) return;
        setStatus(opened);
        setHasKey(Boolean(settings.anthropicKey));
        api<Overview>(workspacePath(owner, repo, "/overview"))
          .then((o) => !cancelled && setOverview(o))
          .catch(() => {});
        if (opened.activeJob) setJob(runningJob(opened.activeJob));
        else if (opened.needsInstall) void run("install");
      } catch (err) {
        if (!cancelled) setOpenError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, run]);

  // Poll the running job for new output; each update schedules the next poll.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { job: update } = await api<{ job: Job }>(`/api/jobs/${job.id}?since=${job.next}`);
        if (cancelled) return;
        setJob((prev) => {
          if (!prev || prev.id !== update.id) return prev;
          const output = prev.output + (update.truncated ? "\n[… earlier output trimmed …]\n" : "") + update.output;
          return { ...update, output: output.slice(-MAX_LOG_CHARS) };
        });
        if (update.status !== "running") await refresh().catch(() => {});
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setJob((prev) => (prev ? { ...prev, status: "failed", output: `${prev.output}\n${message}\n` } : prev));
        await refresh().catch(() => {});
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job, refresh]);

  // Busy with something this page isn't tracking (a sync or save from another
  // tab): re-check until it's free, so the buttons don't stay disabled.
  const busyElsewhere = Boolean(status?.busy) && job?.status !== "running";
  useEffect(() => {
    if (!busyElsewhere) return;
    const timer = setTimeout(() => void refresh().catch(() => {}), 1500);
    return () => clearTimeout(timer);
  }, [busyElsewhere, status, refresh]);

  const editFile = useCallback((file: string) => {
    setEditTarget(file);
    setTab("edit");
  }, []);

  async function resetToDefault() {
    setResetting(true);
    setRunError(null);
    try {
      setStatus(await api<WorkspaceStatus>(workspacePath(owner, repo, "/reset"), { method: "POST", body: {} }));
      await refresh();
    } catch (err) {
      setRunError(err);
    } finally {
      setResetting(false);
    }
  }

  if (openError) {
    return (
      <Shell owner={owner} repo={repo}>
        <div className="mt-8">
          <ErrorText error={openError} />
        </div>
      </Shell>
    );
  }

  if (!status) {
    return (
      <Shell owner={owner} repo={repo}>
        <p className="mt-8 text-sm text-zinc-500">Opening the site. The first open clones the repository…</p>
      </Shell>
    );
  }

  const busy = job?.status === "running" || Boolean(status.busy) || resetting;
  const context: SiteContextValue = {
    owner,
    repo,
    status,
    overview,
    hasKey,
    job,
    busy,
    version,
    run,
    setStatus,
    refresh,
    editFile,
    showTab: setTab,
  };

  return (
    <SiteContext.Provider value={context}>
      <Shell owner={owner} repo={repo} status={status}>
        <div className="mt-6 space-y-3">
          {!hasKey && (
            <Notice>
              Claude commands (Edit with Claude, running scheduled jobs) need your Anthropic API key.{" "}
              <Link href="/dashboard#anthropic-key" className="font-medium underline">
                Add it on the dashboard
              </Link>
            </Notice>
          )}
          {!status.onDefaultBranch && (
            <Notice>
              You&apos;re working on branch <code className="font-mono">{status.branch}</code>. New commits go to this branch
              and update its pull request.{" "}
              {status.changes.length === 0 && (
                <Button variant="ghost" className="ml-1 underline" disabled={busy} onClick={resetToDefault}>
                  Start a new change from {status.defaultBranch}
                </Button>
              )}
            </Notice>
          )}
          {status.onDefaultBranch && Boolean(status.behind) && (
            <Notice tone="warning">
              GitHub has {status.behind} newer commit{status.behind === 1 ? "" : "s"} on {status.defaultBranch}.{" "}
              {status.changes.length === 0 ? (
                <Button variant="ghost" className="ml-1 underline" disabled={busy} onClick={resetToDefault}>
                  Update to latest
                </Button>
              ) : (
                "Commit or discard your changes to update."
              )}
            </Notice>
          )}
          <ErrorText error={runError} />
        </div>

        <nav className="mt-6 flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800" aria-label="Site sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t.id
                  ? "border-foreground font-medium"
                  : "border-transparent text-zinc-500 hover:text-foreground"
              }`}
            >
              {t.label}
              {t.id === "changes" && status.changes.length > 0 && (
                <span className="ml-1.5 rounded-full bg-foreground px-1.5 text-xs text-background">
                  {status.changes.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-6">
            {tab === "build" && <BuildPanel />}
            {tab === "pages" && <PagesPanel />}
            {tab === "navigation" && <NavPanel />}
            {tab === "info" && <StaticInfoPanel />}
            {tab === "edit" && <EditPanel key={editTarget ?? ""} initialFile={editTarget} />}
            {tab === "tree" && <TreePanel />}
            {tab === "schedule" && <SchedulePanel />}
            {tab === "changes" && <ChangesPanel />}
          </div>
          <JobLog />
        </div>
      </Shell>
    </SiteContext.Provider>
  );
}

function Shell({
  owner,
  repo,
  status,
  children,
}: {
  owner: string;
  repo: string;
  status?: WorkspaceStatus;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
      <Link href="/dashboard" className="text-sm text-zinc-500 hover:underline">
        ← Dashboard
      </Link>
      <header className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{status?.fullName ?? `${owner}/${repo}`}</h1>
        {status && (
          <>
            <Badge>
              <span className="font-mono">{status.branch}</span>
            </Badge>
            {status.ahead ? <Badge>{status.ahead} unpushed</Badge> : null}
            <a href={status.htmlUrl} target="_blank" rel="noreferrer" className="ml-auto text-sm text-zinc-500 hover:underline">
              View on GitHub ↗
            </a>
          </>
        )}
      </header>
      {children}
    </main>
  );
}
