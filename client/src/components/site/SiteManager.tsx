"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { claudeAccess } from "@/lib/claude";
import { confirmModal } from "@/lib/confirm";
import { ApiError, api, setBeforeChange, workspacePath, type Job, type Overview, type SiteCheck, type WorkspaceStatus } from "@/lib/site-api";
import { AskClaude } from "./assistant/AskClaude";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { AssistantProvider, useAssistant, useOptionalAssistant } from "./assistant/AssistantProvider";
import { BrandPanel } from "./BrandPanel";
import { BuildPanel } from "./BuildPanel";
import { ChangesPanel } from "./ChangesPanel";
import { HeaderFooterPanel } from "./HeaderFooterPanel";
import { HomePanel } from "./HomePanel";
import { MemoryPanel } from "./MemoryPanel";
import { PagesPanel } from "./PagesPanel";
import { SchedulePanel } from "./SchedulePanel";
import { SeoPanel } from "./SeoPanel";
import { SiteContext, useSite, type PageEditMode, type SiteContextValue, type SiteSection } from "./site-context";
import { usePublishing, useSiteTools } from "./site-hooks";
import { StaticInfoPanel } from "./StaticInfoPanel";
import { StatusStrip } from "./StatusStrip";
import { StylesPanel } from "./StylesPanel";
import { TreePanel } from "./TreePanel";
import { Button, ErrorText, Notice, ScreenHeader, Spinner } from "./ui";

const MAIN: { id: SiteSection; label: string; hint: string }[] = [
  { id: "home", label: "Home", hint: "Your site at a glance" },
  { id: "pages", label: "Pages", hint: "Add and write pages" },
  { id: "design", label: "Design", hint: "Logo, menu and footer" },
  { id: "details", label: "Site details", hint: "Name, contact details and more" },
  { id: "publish", label: "Publish", hint: "Put your changes live" },
];

const ADVANCED: { id: SiteSection; label: string }[] = [
  { id: "seo", label: "Search overview" },
  { id: "tree", label: "Site plan" },
  { id: "schedule", label: "Scheduled pages" },
  { id: "memory", label: "What Claude remembers" },
  { id: "styles", label: "Styles (CSS)" },
  { id: "tools", label: "Build tools and log" },
];

const POLL_MS = 700;
const MAX_LOG_CHARS = 500_000;
// The preview rebuilds this long after the last change, so a burst of saves builds once.
const AUTO_PREVIEW_DELAY_MS = 1500;
/** Commands that never change the site's files, so they don't make the preview out of date. */
const READ_ONLY_COMMANDS = new Set(["preview", "check", "proposal-preview", "seo-audit", "changelog"]);

function runningJob(active: NonNullable<WorkspaceStatus["activeJob"]>): Job {
  return { ...active, status: "running", exitCode: null, output: "", truncated: false, next: 0 };
}

export function SiteManager({ owner, repo }: { owner: string; repo: string }) {
  const [status, setRawStatus] = useState<WorkspaceStatus | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [anthropicKey, setAnthropicKey] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [section, setSection] = useState<SiteSection>("home");
  const [openPage, setOpenPage] = useState<{ file: string; mode: PageEditMode } | null>(null);
  // Once opened, Pages and Design stay mounted, so a hand-written draft or unsaved menu survives visits elsewhere.
  const [pagesOpened, setPagesOpened] = useState(false);
  const [designOpened, setDesignOpened] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const unsavedDraft = useRef(false);
  const [resetting, setResetting] = useState(false);
  // Something changed the site's files since the preview was last built.
  const [previewStale, setPreviewStale] = useState(false);
  // The deploy's own check (SiteProblems), loaded while the Publish screen is open and run by itself
  // once after each change: `changeTick` counts changes to the site's files, `checkedTick` is the
  // one the last automatic check started after. `version` and `tick` say what the report was loaded for.
  const [siteCheck, setSiteCheck] = useState<SiteCheck & { version: number; tick: number }>({ report: null, fresh: false, version: -1, tick: -1 });
  const [changeTick, setChangeTick] = useState(0);
  const [checkedTick, setCheckedTick] = useState(-1);
  // Whether the running job was a dry run (a Claude preview), which changes nothing.
  const dryRunJob = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, nextOverview] = await Promise.all([
      api<WorkspaceStatus>(workspacePath(owner, repo)),
      api<Overview>(workspacePath(owner, repo, "/overview")).catch(() => null),
    ]);
    setRawStatus(nextStatus);
    setOverview(nextOverview);
    setVersion((v) => v + 1);
  }, [owner, repo]);

  // The editor's own preview rebuild, if one is running: it never makes the editor busy, and
  // gives way to anything the user starts. The ref is for callbacks, the state for rendering.
  const autoJob = useRef<string | null>(null);
  const [autoJobId, setAutoJobId] = useState<string | null>(null);
  const currentJob = useRef<Job | null>(null);
  useEffect(() => {
    currentJob.current = job;
  }, [job]);

  const start = useCallback(
    async (command: string, input: Record<string, unknown>, quiet: boolean) => {
      if (!quiet) setRunError(null);
      try {
        const { job: started } = await api<{ job: Job }>(workspacePath(owner, repo, `/commands/${command}`), {
          method: "POST",
          body: { input },
        });
        dryRunJob.current = input.dryRun ? started.id : null;
        autoJob.current = quiet ? started.id : null;
        setAutoJobId(autoJob.current);
        setJob(started);
        return { job: started };
      } catch (err) {
        if (!quiet) setRunError(err);
        return { error: err };
      }
    },
    [owner, repo],
  );

  /** Stops the editor's own preview rebuild (or check) so a command the user asked for can start; it runs again afterwards. */
  const stopAutoPreview = useCallback(async () => {
    const id = autoJob.current;
    if (!id || currentJob.current?.id !== id || currentJob.current.status !== "running") return;
    const wasCheck = currentJob.current.command === "check";
    await api(`/api/jobs/${id}/cancel`, { method: "POST", body: {} }).catch(() => {});
    for (let i = 0; i < 40; i++) {
      const latest = await api<{ job: Job }>(`/api/jobs/${id}`).catch(() => null);
      if (!latest || latest.job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    setPreviewStale(true);
    if (wasCheck) setCheckedTick(-1);
  }, []);

  // Every change the user makes (a command, a save, a publish) goes first.
  useEffect(() => {
    setBeforeChange(stopAutoPreview);
    return () => setBeforeChange(null);
  }, [stopAutoPreview]);

  const run = useCallback(
    async (command: string, input: Record<string, unknown> = {}) => "job" in (await start(command, input, false)),
    [start],
  );

  // Callers waiting for a job to finish (runAndWait), by job id.
  const waiters = useRef(new Map<string, (job: Job) => void>());
  const runAndWait = useCallback(
    async (command: string, input: Record<string, unknown> = {}) => {
      const started = await start(command, input, false);
      if ("error" in started) throw started.error;
      return new Promise<Job>((resolve) => waiters.current.set(started.job.id, resolve));
    },
    [start],
  );

  // A change made outside a command (a save, a discard) hands back the new status, or asks for a
  // refresh. Panels only do either after changing files, so both mark the preview out of date.
  const setStatus = useCallback((next: WorkspaceStatus) => {
    setRawStatus(next);
    setPreviewStale(true);
    setChangeTick((t) => t + 1);
  }, []);
  const refreshAfterChange = useCallback(async () => {
    setPreviewStale(true);
    setChangeTick((t) => t + 1);
    await refresh();
  }, [refresh]);

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
        setRawStatus(opened);
        setAnthropicKey(settings.anthropicKey);
        api<Overview>(workspacePath(owner, repo, "/overview"))
          .then((o) => !cancelled && setOverview(o))
          .catch(() => {});
        if (opened.activeJob) setJob(runningJob(opened.activeJob));
        else if (opened.needsInstall) void run("install");
        else if (opened.build === "none") setPreviewStale(true);
      } catch (err) {
        if (!cancelled) setOpenError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, run]);

  const finished = useCallback((done: Job) => {
    const waiter = waiters.current.get(done.id);
    waiters.current.delete(done.id);
    waiter?.(done);
  }, []);

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
        if (update.status !== "running") {
          // Even a failed command may have changed files first.
          const changed = !READ_ONLY_COMMANDS.has(update.command) && dryRunJob.current !== update.id;
          if (changed) setChangeTick((t) => t + 1);
          // A check builds the site without its hidden pages, over the preview.
          if ((update.status === "succeeded" && changed) || update.command === "check") setPreviewStale(true);
          await refresh().catch(() => {});
          finished({ ...update, output: (job.output + update.output).slice(-MAX_LOG_CHARS) });
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setJob((prev) => (prev ? { ...prev, status: "failed", output: `${prev.output}\n${message}\n` } : prev));
        await refresh().catch(() => {});
        finished({ ...job, status: "failed", output: `${job.output}\n${message}\n` });
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job, refresh, finished]);

  // Busy with something this page isn't tracking (a sync or save from another
  // tab): re-check until it's free, so the buttons don't stay disabled.
  const busyElsewhere = Boolean(status?.busy) && job?.status !== "running";
  useEffect(() => {
    if (!busyElsewhere) return;
    const timer = setTimeout(() => void refresh().catch(() => {}), 1500);
    return () => clearTimeout(timer);
  }, [busyElsewhere, status, refresh]);

  const autoRunning = job?.status === "running" && job.id === autoJobId;
  const busy = (job?.status === "running" && !autoRunning) || (Boolean(status?.busy) && !autoRunning) || resetting;

  // The latest check, while the Publish screen is open: again after every change or command.
  useEffect(() => {
    if (section !== "publish") return;
    let cancelled = false;
    api<SiteCheck>(workspacePath(owner, repo, "/check"))
      .then((next) => !cancelled && setSiteCheck({ ...next, version, tick: changeTick }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, section, version, changeTick]);
  const checkFresh = siteCheck.fresh && siteCheck.tick === changeTick;
  const checkLoaded = siteCheck.version === version && siteCheck.tick === changeTick;
  // On the Publish screen, check the site once after each change, as the deploy will.
  const checkDue = section === "publish" && !checkFresh && checkedTick !== changeTick && !status?.needsInstall;

  // Rebuild the preview (or run that check, first) by itself once the workspace is free, so nobody
  // has to press Build. If another command got there first it waits for the next free moment; any
  // other failure is left for the status strip and the Build tools screen.
  const wantCheck = checkDue && checkLoaded;
  const canAutoRun = (previewStale || wantCheck) && !busy && !autoRunning && Boolean(status) && !status?.needsInstall;
  useEffect(() => {
    if (!canAutoRun) return;
    const timer = setTimeout(async () => {
      const conflict = (started: { error?: unknown }) => started.error instanceof ApiError && started.error.status === 409;
      if (wantCheck) {
        setCheckedTick(changeTick);
        if (conflict(await start("check", {}, true))) setCheckedTick(-1);
        return;
      }
      setPreviewStale(false);
      if (conflict(await start("preview", {}, true))) setPreviewStale(true);
    }, AUTO_PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [canAutoRun, wantCheck, changeTick, start]);

  const publishing = usePublishing(owner, repo, version);
  // Where the owner is, for Claude: the screen, and the page when one is open.
  const assistantContext = useMemo(
    () => ({ screen: section, page: section === "pages" ? (openPage?.file ?? null) : null }),
    [section, openPage],
  );
  const tools = useSiteTools({ owner, repo, version, overview, publishing: publishing.publishing, setStatus, refresh: refreshAfterChange });

  const showSection = useCallback((next: SiteSection) => {
    setSection(next);
    setMenuOpen(false);
    if (next === "pages") setPagesOpened(true);
    if (next === "design") setDesignOpened(true);
    window.scrollTo({ top: 0 });
  }, []);

  const setUnsavedDraft = useCallback((unsaved: boolean) => {
    unsavedDraft.current = unsaved;
  }, []);

  const confirmDiscardDraft = useCallback(
    async () =>
      !unsavedDraft.current ||
      (await confirmModal("You have unsaved changes. Leave without saving?", { confirmLabel: "Leave without saving", danger: true })),
    [],
  );

  // Closing or reloading the browser tab would lose the draft too.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (unsavedDraft.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const editFile = useCallback(
    async (file: string, mode: PageEditMode = "edit") => {
      if (!(await confirmDiscardDraft())) return;
      unsavedDraft.current = false;
      setOpenPage({ file, mode });
      showSection("pages");
    },
    [confirmDiscardDraft, showSection],
  );

  const closePage = useCallback(async () => {
    if (!(await confirmDiscardDraft())) return;
    unsavedDraft.current = false;
    setOpenPage(null);
  }, [confirmDiscardDraft]);

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
      <Shell title={repo}>
        <div className="mt-8 space-y-3">
          <ErrorText error={openError} />
          <Link href="/dashboard" className="text-sm underline">
            Back to your sites
          </Link>
        </div>
      </Shell>
    );
  }

  if (!status) {
    return (
      <Shell title={repo}>
        <div className="mt-10 flex items-center gap-3 text-sm text-zinc-500">
          <Spinner />
          Opening your site. The first time takes about a minute while it&apos;s set up.
        </div>
      </Shell>
    );
  }

  const context: SiteContextValue = {
    owner,
    repo,
    status,
    overview,
    claude: claudeAccess({ anthropicKey }),
    job,
    busy,
    version,
    run,
    runAndWait,
    setStatus,
    refresh: refreshAfterChange,
    editFile,
    setUnsavedDraft,
    confirmDiscardDraft,
    showSection,
    publishing,
    tools,
    siteCheck: {
      report: siteCheck.report,
      fresh: checkFresh,
      checking: (job?.status === "running" && job.command === "check") || checkDue,
      checkNow: () => {
        setCheckedTick(changeTick);
        void run("check");
      },
    },
  };

  const liveUrl = publishing.publishing?.enabled ? publishing.publishing.url : null;
  const changes = status.changes.length;
  const current = [...MAIN, ...ADVANCED].find((s) => s.id === section);

  return (
    <SiteContext.Provider value={context}>
      <AssistantProvider context={assistantContext}>
      <Shell
        title={overview?.site.name || repo}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {liveUrl && (
              <a
                href={liveUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                View live site ↗
              </a>
            )}
            <AskClaudeButton />
          </span>
        }
      >
        <div className="mt-6 grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <nav aria-label="Site editor" className="lg:sticky lg:top-20 lg:self-start">
            {/* Small screens: one button opens the list, so the menu doesn't push the page down. */}
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              className="flex w-full items-center justify-between rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium lg:hidden dark:border-zinc-700"
            >
              <span>{current?.label ?? "Menu"}</span>
              <span aria-hidden="true">{menuOpen ? "▴" : "▾"}</span>
            </button>
            <div className={`${menuOpen ? "mt-2 block" : "hidden"} rounded-lg border border-zinc-200 p-2 lg:mt-0 lg:block lg:border-0 lg:p-0 dark:border-zinc-800`}>
              <ul className="space-y-0.5">
                {MAIN.map((item) => (
                  <li key={item.id}>
                    <NavButton
                      active={section === item.id}
                      // Pages again, while a page is open: back to the list.
                      onClick={() => (item.id === "pages" && section === "pages" && openPage ? closePage() : showSection(item.id))}
                      hint={item.hint}
                    >
                      {item.label}
                      {item.id === "publish" && changes > 0 && (
                        <span className="ml-auto rounded-full bg-foreground px-1.5 text-xs text-background" title={`${changes} unpublished change${changes === 1 ? "" : "s"}`}>
                          {changes}
                        </span>
                      )}
                    </NavButton>
                  </li>
                ))}
              </ul>
              <p className="mb-1 mt-5 px-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Advanced</p>
              <ul className="space-y-0.5">
                {ADVANCED.map((item) => (
                  <li key={item.id}>
                    <NavButton active={section === item.id} onClick={() => showSection(item.id)} small>
                      {item.label}
                    </NavButton>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <div className="min-w-0 space-y-6">
            <SiteNotices onReset={resetToDefault} />
            <ErrorText error={runError} />
            {section !== "tools" && <AskClaude />}

            {section === "home" && <HomePanel />}
            {pagesOpened && (
              <div hidden={section !== "pages"}>
                <PagesPanel openPage={openPage} onClose={closePage} />
              </div>
            )}
            {designOpened && (
              <div hidden={section !== "design"} className="space-y-6">
                <ScreenHeader title="Design" description="Your logo, colours, menu and footer. They appear on every page of your site." />
                <BrandPanel />
                <HeaderFooterPanel />
              </div>
            )}
            {section === "details" && <StaticInfoPanel />}
            {section === "publish" && <ChangesPanel />}
            {section === "seo" && <SeoPanel />}
            {section === "tree" && <TreePanel />}
            {section === "schedule" && <SchedulePanel />}
            {section === "memory" && <MemoryPanel />}
            {section === "styles" && <StylesPanel />}
            {section === "tools" && <BuildPanel />}
          </div>
        </div>
        <StatusStrip onShowLog={() => showSection("tools")} />
      </Shell>
      <AssistantPanel />
      </AssistantProvider>
    </SiteContext.Provider>
  );
}

/** The few states that change what every screen means: an unfinished review, or newer work on GitHub. */
function SiteNotices({ onReset }: { onReset: () => void }) {
  const { status, busy } = useSite();
  const noChanges = status.changes.length === 0;

  if (!status.onDefaultBranch) {
    return (
      <Notice>
        You&apos;re working on changes that were sent for review. Publishing adds to that review instead of going straight live.{" "}
        {noChanges && (
          <Button variant="ghost" className="ml-1 underline" disabled={busy} onClick={onReset}>
            Go back to the live version
          </Button>
        )}
      </Notice>
    );
  }
  if (status.behind) {
    return (
      <Notice tone="warning">
        Your site was changed somewhere else since you opened it.{" "}
        {noChanges ? (
          <Button variant="ghost" className="ml-1 underline" disabled={busy} onClick={onReset}>
            Get the latest version
          </Button>
        ) : (
          "Publish or undo your changes to get the latest version."
        )}
      </Notice>
    );
  }
  return null;
}

function NavButton({
  active,
  onClick,
  hint,
  small = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  hint?: string;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-3 text-left ${small ? "py-1.5 text-sm" : "py-2 text-sm font-medium"} ${
        active ? "bg-zinc-100 text-foreground dark:bg-zinc-900" : "text-zinc-600 hover:bg-zinc-50 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-900"
      }`}
    >
      {children}
    </button>
  );
}

/** Opens and closes the conversation with Claude. */
function AskClaudeButton() {
  const { open, setOpen, turn } = useAssistant();
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
    >
      <span aria-hidden="true">✦</span> Ask Claude
      {turn?.status === "running" && <span className="ml-1 size-2 animate-pulse rounded-full bg-background" aria-label="Claude is working" />}
    </button>
  );
}

/** The editor's page; while the conversation panel is open on a wide screen, the page makes room for it. */
function Shell({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const assistant = useOptionalAssistant();
  return (
    <main className={`mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-8 ${assistant?.open ? "xl:max-w-none xl:pr-114" : ""}`}>
      <Link href="/dashboard" className="text-sm text-zinc-500 hover:underline">
        ← Your sites
      </Link>
      <header className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="ml-auto">{actions}</div>
      </header>
      {children}
    </main>
  );
}

