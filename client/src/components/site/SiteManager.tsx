"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { claudeAccess, inEditorWords } from "@/lib/claude";
import { useCredits } from "@/lib/credits";
import { confirmModal } from "@/lib/confirm";
import { siteTitle } from "@/lib/repos";
import { ApiError, api, setBeforeChange, workspacePath, type Job, type Overview, type SiteCheck, type WorkspaceStatus } from "@/lib/site-api";
import { AiHelpBadge } from "./AiHelpBadge";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { AskClaude } from "./assistant/AskClaude";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { AssistantProvider, useOptionalAssistant } from "./assistant/AssistantProvider";
import { BrandPanel } from "./BrandPanel";
import { BuildPanel } from "./BuildPanel";
import { ChangesPanel } from "./ChangesPanel";
import { HeaderFooterPanel } from "./HeaderFooterPanel";
import { HomePanel } from "./HomePanel";
import { MemoryPanel } from "./MemoryPanel";
import { MissingPages } from "./MissingPages";
import { ModelPanel } from "./ModelPanel";
import { MORE_TOOLS, MoreToolsPanel } from "./MoreToolsPanel";
import { PagesPanel } from "./PagesPanel";
import { SchedulePanel } from "./SchedulePanel";
import { SeoPanel } from "./SeoPanel";
import { SiteContext, useSite, type PageEditMode, type SiteContextValue, type SiteSection } from "./site-context";
import { usePublishNow, usePublishing, useSiteTools, useSiteUpdate } from "./site-hooks";
import { StaticInfoPanel } from "./StaticInfoPanel";
import { StatusStrip } from "./StatusStrip";
import { StylesPanel } from "./StylesPanel";
import { TreePanel } from "./TreePanel";
import { Button, ErrorText, Notice, ScreenHeader, Spinner } from "./ui";

const MAIN: { id: SiteSection; label: string; hint: string }[] = [
  { id: "home", label: "Edit site", hint: "Your site: click any words to change them" },
  { id: "pages", label: "Pages", hint: "Add, open and organise pages" },
  { id: "design", label: "Look & logo", hint: "Logo, colours, menu and footer" },
  { id: "details", label: "Business info", hint: "Name, contact details, reviews and more" },
];

// Only for the site's creator (GET …/analytics/access): nobody else sees its visits.
const ANALYTICS = { id: "analytics" as const, label: "Visitors", hint: "Who visits your site" };

// Screens reached from elsewhere, for the small-screen menu button's label.
const OTHER: { id: SiteSection; label: string }[] = [{ id: "publish", label: "What's changed" }, { id: "more", label: "More tools" }, ...MORE_TOOLS];
const TOOL_IDS = new Set<SiteSection>(MORE_TOOLS.map((tool) => tool.id));

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
  const credits = useCredits();
  const [job, setJob] = useState<Job | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [section, setSection] = useState<SiteSection>("home");
  const [openPage, setOpenPage] = useState<{ file: string; mode: PageEditMode } | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{ url: string; n: number } | null>(null);
  // The page Edit site's preview shows, so "this page" means it there too.
  const [shownPage, setShownPage] = useState<string | null>(null);
  // Once opened, Pages and Design stay mounted, so a hand-written draft or unsaved menu survives visits elsewhere.
  const [pagesOpened, setPagesOpened] = useState(false);
  const [designOpened, setDesignOpened] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isCreator, setIsCreator] = useState(false);
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

  // A job started by a route of its own rather than a command (the site update): followed like
  // any command, and resolves with the finished job.
  const runJobAt = useCallback(
    async (rest: string) => {
      setRunError(null);
      const { job: started } = await api<{ job: Job }>(workspacePath(owner, repo, rest), { method: "POST", body: {} });
      dryRunJob.current = null;
      autoJob.current = null;
      setAutoJobId(null);
      setJob(started);
      return new Promise<Job>((resolve) => waiters.current.set(started.id, resolve));
    },
    [owner, repo],
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
        const opened = await api<WorkspaceStatus>(workspacePath(owner, repo, "/open"), { method: "POST", body: {} });
        if (cancelled) return;
        setRawStatus(opened);
        api<Overview>(workspacePath(owner, repo, "/overview"))
          .then((o) => !cancelled && setOverview(o))
          .catch(() => {});
        api<{ creator: boolean }>(workspacePath(owner, repo, "/analytics/access"))
          .then((a) => !cancelled && setIsCreator(a.creator))
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
  // Where the owner is, for the AI: the screen, and the page open in the page editor or shown on Edit site.
  const assistantContext = useMemo(
    () => ({ screen: section, page: section === "pages" ? (openPage?.file ?? null) : section === "home" ? shownPage : null }),
    [section, openPage, shownPage],
  );
  const tools = useSiteTools({ owner, repo, version, overview, publishing: publishing.publishing, setStatus, refresh: refreshAfterChange });
  const siteUpdate = useSiteUpdate({ owner, repo, version, runJobAt, run, setStatus, watch: publishing.watch });

  // Requests for Edit site to show a page; each one gets the next number, so the same page twice still moves it.
  const previewRequests = useRef(0);
  const showSection = useCallback((next: SiteSection) => {
    // Opening a screen from the menu shows the site from its homepage, not the last page asked for.
    setPreviewTarget(null);
    setSection(next);
    setMenuOpen(false);
    if (next === "pages") setPagesOpened(true);
    if (next === "design") setDesignOpened(true);
    window.scrollTo({ top: 0 });
  }, []);

  const openPublishScreen = useCallback(() => showSection("publish"), [showSection]);
  const publishNow = usePublishNow({
    owner,
    repo,
    status,
    overview,
    runAndWait,
    setStatus,
    refresh: refreshAfterChange,
    watch: publishing.watch,
    openPublishScreen,
    onError: setRunError,
  });

  const showOnSite = useCallback(
    (url: string) => {
      showSection("home");
      setPreviewTarget({ url, n: ++previewRequests.current });
    },
    [showSection],
  );

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
    claude: inEditorWords(claudeAccess(credits)),
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
    showOnSite,
    previewTarget,
    setShownPage,
    publishNow,
    publishing,
    tools,
    siteUpdate,
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

  const main = isCreator ? [...MAIN, ANALYTICS] : MAIN;
  const current = [...main, ...OTHER].find((s) => s.id === section);
  // The AI bar is on every screen but the technical log, which keeps the status strip to itself.
  const withAiBar = section !== "tools";

  return (
    <SiteContext.Provider value={context}>
      <AssistantProvider context={assistantContext}>
      <Shell title={siteTitle(overview?.site.name, overview?.displayName, repo)} actions={<TopBar />}>
        <div className="mt-6 grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
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
                {main.map((item) => (
                  <li key={item.id}>
                    <NavButton
                      active={section === item.id}
                      // Pages again, while a page is open: back to the list.
                      onClick={() => (item.id === "pages" && section === "pages" && openPage ? closePage() : showSection(item.id))}
                      hint={item.hint}
                    >
                      {item.label}
                    </NavButton>
                  </li>
                ))}
              </ul>
              <div className="mt-5 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <NavButton active={section === "more" || TOOL_IDS.has(section)} onClick={() => showSection("more")} hint="Tools most owners never need" small>
                  More tools <span aria-hidden="true">→</span>
                </NavButton>
              </div>
            </div>
          </nav>

          <div className="min-w-0 space-y-6">
            <SiteNotices onReset={resetToDefault} />
            <ErrorText error={runError} />
            {/* After every build, on every screen: links to pages that don't exist yet, with a way to make them. */}
            {!status.needsInstall && <MissingPages />}
            {TOOL_IDS.has(section) && (
              <button type="button" onClick={() => showSection("more")} className="text-sm text-zinc-500 hover:underline">
                ← More tools
              </button>
            )}

            {section === "home" && <HomePanel />}
            {pagesOpened && (
              <div hidden={section !== "pages"}>
                <PagesPanel openPage={openPage} onClose={closePage} />
              </div>
            )}
            {designOpened && (
              <div hidden={section !== "design"} className="space-y-6">
                <ScreenHeader title="Look & logo" description="Your logo, colours, menu and footer. They appear on every page of your site." />
                <BrandPanel />
                <HeaderFooterPanel />
              </div>
            )}
            {section === "details" && <StaticInfoPanel view="business" />}
            {section === "publish" && <ChangesPanel />}
            {section === "analytics" && isCreator && <AnalyticsPanel />}
            {section === "more" && <MoreToolsPanel />}
            {section === "seo" && (
              <>
                <SeoPanel />
                <StaticInfoPanel view="search" />
              </>
            )}
            {section === "redirects" && <StaticInfoPanel view="redirects" />}
            {section === "sections" && <StaticInfoPanel view="sections" />}
            {section === "tree" && <TreePanel />}
            {section === "schedule" && <SchedulePanel />}
            {section === "memory" && <MemoryPanel />}
            {section === "styles" && <StylesPanel />}
            {section === "models" && <ModelPanel />}
            {section === "tools" && <BuildPanel />}

            {withAiBar && (
              // Stays at the bottom of the window as the screen scrolls, with the status strip above it.
              <div className="sticky bottom-3 z-30 space-y-2 pt-2">
                <StatusStrip inline onShowLog={() => showSection("tools")} />
                <AskClaude />
              </div>
            )}
          </div>
        </div>
        {!withAiBar && <StatusStrip onShowLog={() => showSection("tools")} />}
      </Shell>
      <AssistantPanel />
      </AssistantProvider>
    </SiteContext.Provider>
  );
}

/**
 * Above every screen: where the site is, whether everything is live, what's changed, how much AI
 * help is left, and the Publish button (PublishNowState).
 */
function TopBar() {
  const { status, busy, publishing: state, publishNow, showSection } = useSite();
  const publishing = state.publishing;
  const changes = status.changes.length;
  const run = publishing?.run;
  const address = publishing?.enabled && publishing.url ? publishing.url : null;

  const warn = "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  let pill: { text: string; tone: string };
  if (changes > 0) {
    pill = { text: `${changes} ${changes === 1 ? "change" : "changes"} not live yet`, tone: warn };
  } else if (status.ahead) {
    pill = { text: "Your last publish didn't finish", tone: warn };
  } else if (!publishing?.enabled) {
    pill = { text: "Not on the web yet", tone: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300" };
  } else if (run && run.status !== "completed") {
    pill = { text: "Updating your live site…", tone: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" };
  } else if (run && run.conclusion !== "success" && run.conclusion !== "cancelled") {
    pill = { text: "The last update didn't go live", tone: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" };
  } else {
    pill = { text: "✓ Everything is live", tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" };
  }

  const { available, working, publish } = publishNow;
  const label = working === "checking" ? "Checking your site…" : working === "publishing" ? "Publishing…" : status.onDefaultBranch ? "Publish" : "Add to the review";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {address && (
        <a href={address} target="_blank" rel="noreferrer" className="max-w-full truncate text-sm text-zinc-500 hover:underline">
          {address.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
        </a>
      )}
      <button type="button" onClick={() => showSection("publish")} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${pill.tone}`}>
        {pill.text}
      </button>
      <button type="button" onClick={() => showSection("publish")} className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
        See what changed
      </button>
      <AiHelpBadge />
      <Button variant="primary" className="flex items-center gap-2 px-4" disabled={!available || busy || working !== null} onClick={() => void publish()}>
        {working && <Spinner />}
        {label}
      </Button>
    </div>
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

/** The editor's page; while the conversation panel is open on a wide screen, the page makes room for it. */
function Shell({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const assistant = useOptionalAssistant();
  return (
    <main className={`mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-8 ${assistant?.open ? "xl:max-w-none xl:pr-114" : ""}`}>
      <Link href="/dashboard" className="text-sm text-zinc-500 hover:underline">
        ← Your sites
      </Link>
      <header className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="sm:ml-auto">{actions}</div>
      </header>
      {children}
    </main>
  );
}

