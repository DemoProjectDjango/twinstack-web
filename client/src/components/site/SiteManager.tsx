"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { claudeAccess, inEditorWords } from "@/lib/claude";
import { useCredits } from "@/lib/credits";
import { confirmModal } from "@/lib/confirm";
import { siteTitle } from "@/lib/repos";
import { ApiError, api, setBeforeChange, workspacePath, type IncomingChanges, type Job, type Overview, type PublishClash, type PublishSync, type SiteCheck, type WorkspaceStatus } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { GitHubChangesModal, wasDismissed } from "./GitHubChanges";
import { AiHelpBadge } from "./AiHelpBadge";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { AiActivity } from "./assistant/AiActivity";
import { SiteBuildActivity } from "./assistant/SiteBuildActivity";
import { DomainPanel } from "./DomainPanel";
import { FirstRunSetup } from "./FirstRunSetup";
import { AskClaude } from "./assistant/AskClaude";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { AssistantProvider, useAssistant, useOptionalAssistant } from "./assistant/AssistantProvider";
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
import { PublishClashes } from "./PublishClashes";
import { PublishNote } from "./PublishNote";
import { PublishedPages } from "./PublishedPages";
import { SchedulePanel } from "./SchedulePanel";
import { SeoPanel } from "./SeoPanel";
import { SiteContext, useSite, type PageEditMode, type SiteContextValue, type SiteSection } from "./site-context";
import { usePublishNow, usePublishing, useSiteTools, useSiteUpdate } from "./site-hooks";
import { StaticInfoPanel } from "./StaticInfoPanel";
import { StatusStrip } from "./StatusStrip";
import { FilesPanel } from "./FilesPanel";
import { ScriptsPanel } from "./ScriptsPanel";
import { StylesPanel } from "./StylesPanel";
import { TreePanel } from "./TreePanel";
import { Tour, startTour } from "./Tour";
import { FeatureGuide, LearnPanel, ProgressRing, noteFeature, noteScreen, useFeatureProgress } from "./FeatureGuide";
import { PageFinder, finderShortcut, openPageFinder } from "./PageFinder";
import { Button, ErrorText, Notice, ScreenHeader, Spinner } from "./ui";

const MAIN: { id: SiteSection; label: string; hint: string }[] = [
  { id: "home", label: "Edit site", hint: "Your site: click any words to change them" },
  { id: "pages", label: "Pages", hint: "Add, open and organise pages" },
  { id: "design", label: "Look & logo", hint: "Logo, colours, menu and footer" },
  { id: "details", label: "Business info", hint: "Name, contact details, reviews and more" },
  { id: "domain", label: "Your domain", hint: "Use your own web address, like www.yourbusiness.com" },
];

// Only for the site's creator (GET …/analytics/access): nobody else sees its visits.
const ANALYTICS = { id: "analytics" as const, label: "Visitors", hint: "Who visits your site" };

// Screens reached from elsewhere, for the small-screen menu button's label.
const OTHER: { id: SiteSection; label: string }[] = [
  { id: "publish", label: "What's changed" },
  { id: "more", label: "More tools" },
  { id: "learn", label: "Learn the features" },
  ...MORE_TOOLS,
];
const TOOL_IDS = new Set<SiteSection>(MORE_TOOLS.map((tool) => tool.id));

/** A screen's name as the menu shows it ("Edit site", "Pages", "Google & sharing"…). */
function screenLabel(id: SiteSection) {
  return [...MAIN, ANALYTICS, ...OTHER].find((s) => s.id === id)?.label ?? "Edit site";
}

// The menu's icons (24×24 stroke paths), by screen.
const NAV_ICONS: Partial<Record<SiteSection, React.ReactNode>> = {
  home: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  pages: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
    </>
  ),
  design: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="8" cy="10" r="1.2" />
      <circle cx="12" cy="7.5" r="1.2" />
      <circle cx="16" cy="10" r="1.2" />
      <path d="M12 21a3 3 0 0 1 0-6h2" />
    </>
  ),
  details: (
    <>
      <path d="M3 9 5 4h14l2 5" />
      <path d="M4 9v11h16V9" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  domain: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  analytics: (
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>
  ),
};

function NavIcon({ section }: { section: SiteSection }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[19px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {NAV_ICONS[section]}
    </svg>
  );
}

// Whether the menu is folded to its icons (on wide screens), per browser.
const NAV_KEY = "twinstack:editor-nav";

function readNavCollapsed() {
  try {
    return typeof window !== "undefined" && localStorage.getItem(NAV_KEY) === "icons";
  } catch {
    return false;
  }
}

const POLL_MS = 700;
// While the API doesn't answer (restarting, a dropped connection), the job is polled again with
// these waits before it's given up on: a Claude job runs for minutes, and one missed poll isn't its end.
const POLL_RETRY_MS = [1000, 2000, 3000, 5000];
const POLL_GIVE_UP_MS = 2 * 60_000;
const MAX_LOG_CHARS = 500_000;
// The preview rebuilds this long after the last change, so a burst of saves builds once.
const AUTO_PREVIEW_DELAY_MS = 1500;
/** Commands that never change the site's files, so they don't make the preview out of date. */
const READ_ONLY_COMMANDS = new Set(["preview", "check", "proposal-preview", "seo-audit", "changelog"]);

function runningJob(active: NonNullable<WorkspaceStatus["activeJob"]>): Job {
  return { ...active, status: "running", exitCode: null, output: "", truncated: false, next: 0 };
}

export function SiteManager({ owner, repo, account, links }: { owner: string; repo: string; account: React.ReactNode; links: React.ReactNode }) {
  const [status, setRawStatus] = useState<WorkspaceStatus | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const [incoming, setIncoming] = useState<IncomingChanges | null>(null);
  const [incomingOpen, setIncomingOpen] = useState(false);
  // Files both this browser and someone's publish changed in the same places: the owner settles them
  // before publishing (PublishClashes). `then` carries on with the publish that found them.
  const [clashes, setClashes] = useState<{ sha: string; clashes: PublishClash[]; subjects: string[]; then: () => void } | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const credits = useCredits();
  const [job, setJob] = useState<Job | null>(null);
  // The job's polls that went unanswered in a row, and since when.
  const [pollMisses, setPollMisses] = useState<{ count: number; since: number } | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [section, setSection] = useState<SiteSection>("home");
  // The screen the publish screen was opened from (What's changed, Earlier versions), for its back link.
  const [cameFrom, setCameFrom] = useState<SiteSection>("home");
  const sectionRef = useRef<SiteSection>("home");
  useEffect(() => {
    sectionRef.current = section;
  }, [section]);
  const [openPage, setOpenPage] = useState<{ file: string; mode: PageEditMode } | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{ url: string; n: number } | null>(null);
  // The page Edit site's preview shows, so "this page" means it there too.
  const [shownPage, setShownPage] = useState<string | null>(null);
  // Once opened, Pages and Design stay mounted, so a hand-written draft or unsaved menu survives visits elsewhere.
  const [pagesOpened, setPagesOpened] = useState(false);
  const [designOpened, setDesignOpened] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The editor only renders its menu once the site has loaded in the browser, so reading storage here can't break hydration.
  const [navCollapsed, setNavCollapsed] = useState(readNavCollapsed);
  const toggleNav = useCallback(() => {
    setNavCollapsed((collapsed) => {
      try {
        localStorage.setItem(NAV_KEY, collapsed ? "full" : "icons");
      } catch {
        // It just won't be remembered.
      }
      return !collapsed;
    });
  }, []);
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

  // Callers waiting for a job to finish (runAndWait), by job id.
  const waiters = useRef(new Map<string, (job: Job) => void>());
  const start = useCallback(
    async function start(command: string, input: Record<string, unknown>, quiet: boolean, retried = false): Promise<{ job: Job } | { error: unknown }> {
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
        // The copy's packages are missing or out of date (a new browser's copy, a lockfile that
        // changed): they're installed first, then what was asked for runs.
        if (err instanceof ApiError && err.code === "needs_install" && command !== "install" && !retried) {
          const installing = await start("install", {}, quiet);
          if ("job" in installing) {
            const done = await new Promise<Job>((resolve) => waiters.current.set(installing.job.id, resolve));
            if (done.status === "succeeded") return start(command, input, quiet, true);
          }
          if (!quiet) setRunError(err);
          return { error: err };
        }
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

  const runAndWait = useCallback(
    async (command: string, input: Record<string, unknown> = {}) => {
      const started = await start(command, input, false);
      if ("error" in started) throw started.error;
      return new Promise<Job>((resolve) => waiters.current.set(started.job.id, resolve));
    },
    [start],
  );

  // A job started by a route of its own rather than a command (the site update, copying a website):
  // followed like any command, and resolves with the finished job.
  const runJobAt = useCallback(
    async (rest: string, body: Record<string, unknown> = {}) => {
      setRunError(null);
      const { job: started } = await api<{ job: Job }>(workspacePath(owner, repo, rest), { method: "POST", body });
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
        if (opened.behind && opened.onDefaultBranch) {
          api<{ incoming: IncomingChanges | null }>(workspacePath(owner, repo, "/incoming"))
            .then(({ incoming: found }) => {
              if (cancelled || !found) return;
              setIncoming(found);
              const ask = () => !cancelled && setIncomingOpen(!wasDismissed(owner, repo, found.sha));
              // Brought in by themselves, so the owner never meets a clash at publish time. Saved work
              // not yet on GitHub (or a failure) still asks, since that needs publishing first.
              if (found.needsPublish || opened.activeJob) return ask();
              api<{ status: WorkspaceStatus; kept: string[] }>(workspacePath(owner, repo, "/incoming/accept"), { method: "POST", body: { sha: found.sha } })
                .then((result) => {
                  if (cancelled) return;
                  toast.info("Your site had newer changes on GitHub. They're in the editor now.");
                  void incomingAccepted(result);
                })
                .catch((err) => {
                  if (cancelled) return;
                  // Both changed the same places: nothing moved, and Publish shows both versions to choose from.
                  if (err instanceof ApiError && err.code === "incoming_clash") {
                    setIncoming(null);
                    toast.info(err.message);
                  } else ask();
                });
            })
            .catch(() => {});
        }
        if (opened.activeJob) setJob(runningJob(opened.activeJob));
        else if (opened.needsInstall) void run("install");
        // No preview yet, or one built before the latest changes (the page was left or reloaded
        // before its rebuild ran): build it again, so the latest work shows.
        else if (opened.build === "none" || opened.previewFresh === false) setPreviewStale(true);
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
    const delay = pollMisses ? POLL_RETRY_MS[Math.min(pollMisses.count - 1, POLL_RETRY_MS.length - 1)] : POLL_MS;
    const timer = setTimeout(async () => {
      try {
        const { job: update } = await api<{ job: Job }>(`/api/jobs/${job.id}?since=${job.next}`);
        if (cancelled) return;
        setPollMisses(null);
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
        // No answer from the API (the proxy's 5xx without the API's own error, or no connection):
        // the job may well still be running there, so keep asking for a while.
        const unanswered = err instanceof ApiError && (err.status === 0 || (err.status >= 500 && !err.code));
        const since = pollMisses?.since ?? Date.now();
        if (unanswered && Date.now() - since < POLL_GIVE_UP_MS) {
          setPollMisses({ count: (pollMisses?.count ?? 0) + 1, since });
          return;
        }
        setPollMisses(null);
        const message = unanswered
          ? "The server stopped answering for over two minutes (it may have restarted), so this job was lost. Try again."
          : err instanceof Error
            ? err.message
            : String(err);
        setJob((prev) => (prev ? { ...prev, status: "failed", output: `${prev.output}\n${message}\n` } : prev));
        await refresh().catch(() => {});
        finished({ ...job, status: "failed", output: `${job.output}\n${message}\n` });
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job, pollMisses, refresh, finished]);

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
      const conflict = (started: { job: Job } | { error: unknown }) => "error" in started && started.error instanceof ApiError && started.error.status === 409;
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
  // Free to install an update by itself: nothing running, and the site's tools installed.
  const canAutoUpdate = Boolean(status) && !busy && !status?.needsInstall;
  const siteUpdate = useSiteUpdate({ owner, repo, version, runJobAt, run, setStatus, watch: publishing.watch, canAutoUpdate });

  // Requests for Edit site to show a page; each one gets the next number, so the same page twice still moves it.
  const previewRequests = useRef(0);
  const showSection = useCallback((next: SiteSection) => {
    // Opening a screen from the menu shows the site from its homepage, not the last page asked for.
    setPreviewTarget(null);
    if (next === "publish" && sectionRef.current !== "publish") setCameFrom(sectionRef.current);
    setSection(next);
    noteScreen(next);
    setMenuOpen(false);
    if (next === "pages") setPagesOpened(true);
    if (next === "design") setDesignOpened(true);
    window.scrollTo({ top: 0 });
  }, []);

  const openPublishScreen = useCallback(() => showSection("publish"), [showSection]);

  /** Asks the server to bring in what others published (publish-sync.js); never changes the copy on a clash. */
  const syncForPublish = useCallback(async () => {
    const result = await api<PublishSync>(workspacePath(owner, repo, "/publish/sync"), { method: "POST", body: {} });
    setStatus(result.status);
    return result;
  }, [owner, repo, setStatus]);

  // Every publish that goes live catches up first. Resolves with the copy's status when publishing
  // can go on; null when the owner must settle clashes first (the window's "Publish now" calls `then`).
  const prepareToPublish = useCallback(
    async (then: () => void): Promise<WorkspaceStatus | null> => {
      const result = await syncForPublish();
      if (result.clashes?.length) {
        setClashes({ sha: result.sha!, clashes: result.clashes, subjects: result.subjects, then });
        return null;
      }
      if (result.subjects.length) {
        const n = result.subjects.length;
        toast.info(`${n === 1 ? "A change" : `${n} changes`} someone else published ${n === 1 ? "was" : "were"} combined with yours.`);
        await refresh();
        if (result.status.needsInstall) await runAndWait("install");
      }
      return result.status;
    },
    [syncForPublish, refresh, runAndWait],
  );
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
    prepareToPublish,
    onError: setRunError,
  });

  const showOnSite = useCallback(
    (url: string) => {
      showSection("home");
      noteFeature("page-on-site");
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
      noteFeature("page-open");
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

  /** GitHub's changes are in: reinstall if they changed the packages, then check the site (which also refreshes the preview). */
  async function incomingAccepted({ status: latest }: { status: WorkspaceStatus }) {
    setIncoming(null);
    setIncomingOpen(false);
    setStatus(latest);
    try {
      await refresh();
      if (latest.needsInstall) await runAndWait("install");
      void run("check");
    } catch (err) {
      setRunError(err);
    }
  }

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
      <Shell title={repo} account={account}>
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
      <Shell title={repo} account={account}>
        {/* In the middle of the window, below the header. */}
        <div role="status" className="flex min-h-[calc(100dvh-14rem)] flex-col items-center justify-center text-center">
          <span aria-hidden="true" className="size-10 animate-spin rounded-full border-[3px] border-zinc-200 border-t-indigo-600 motion-reduce:animate-none dark:border-zinc-800 dark:border-t-indigo-400" />
          <p className="mt-5 font-semibold">Opening your site</p>
          <p className="mt-1 text-sm text-zinc-500">The first time takes about a minute while it&apos;s set up.</p>
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
    runJobAt,
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
    prepareToPublish,
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
      <Frame>
        {/* On wide screens the screen's column takes over the page's bottom padding (-mb-24, pb-24 below), so
            the row reaches the foot of the page and the sticky column is never pushed up by its end. */}
        <div className={`grid grid-cols-[minmax(0,1fr)] gap-5 transition-[grid-template-columns] duration-300 lg:-mb-24 ${navCollapsed ? "lg:grid-cols-[4.25rem_minmax(0,1fr)]" : "lg:grid-cols-[14rem_minmax(0,1fr)]"}`}>
          {/* Wide screens: the logo, the site's name and the menu fill the window's height and stay put. */}
          <div className="min-w-0 lg:sticky lg:top-4 lg:flex lg:h-[calc(100dvh-2rem)] lg:min-h-96 lg:flex-col lg:self-start">
            {/* Wide screens: as tall as the top bar beside it (h-10) with the same gap below (the screen
                column's space-y-4), so the menu's card and the screen's card start on one line. */}
            <div className={`mb-3 lg:mb-4 lg:flex lg:h-10 lg:items-center ${navCollapsed ? "lg:justify-center" : ""}`}>
              <Brand collapsed={navCollapsed} />
              {/* Small screens: above the menu button. Wide screens: at the top of the menu's card, below. */}
              <div className="mt-3 lg:hidden">
                <BackToSites collapsed={false} />
                <h1 className="mt-0.5 line-clamp-2 text-xl font-bold tracking-tight">{siteTitle(overview?.site.name, overview?.displayName, repo)}</h1>
              </div>
            </div>
          <nav aria-label="Site editor" data-tour="menu" className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
            {/* Small screens: one button opens the list, so the menu doesn't push the page down. */}
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              className="flex w-full items-center justify-between rounded-2xl bg-background px-4 py-3 text-sm font-medium shadow-sm lg:hidden"
            >
              <span>{current?.label ?? "Menu"}</span>
              <span aria-hidden="true">{menuOpen ? "▴" : "▾"}</span>
            </button>
            <div className={`${menuOpen ? "mt-2 flex" : "hidden"} flex-col rounded-2xl bg-background p-2.5 shadow-sm lg:mt-0 lg:flex lg:min-h-0 lg:flex-1 lg:overflow-y-auto`}>
              {/* The site's name heads the menu's card on wide screens, so the menu is one block. */}
              <div className={`mb-2 hidden border-b border-zinc-100 pb-3 lg:block dark:border-zinc-800 ${navCollapsed ? "" : "px-1"}`}>
                <BackToSites collapsed={navCollapsed} />
                {!navCollapsed && <h1 className="mt-2 line-clamp-2 px-1.5 text-xl font-bold tracking-tight">{siteTitle(overview?.site.name, overview?.displayName, repo)}</h1>}
              </div>
              <div className={`mb-1 hidden items-center lg:flex ${navCollapsed ? "justify-center" : "justify-between pl-2.5"}`}>
                {!navCollapsed && <span className="text-xs font-semibold tracking-wider text-zinc-500">YOUR SITE</span>}
                <button
                  type="button"
                  onClick={toggleNav}
                  aria-label={navCollapsed ? "Show the menu" : "Hide the menu"}
                  title={navCollapsed ? "Show the menu" : "Hide the menu"}
                  aria-expanded={!navCollapsed}
                  className="grid size-9 place-items-center rounded-xl bg-zinc-100 text-zinc-700 hover:bg-zinc-200 hover:text-foreground dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="3" />
                    <path d="M9 4v16" />
                  </svg>
                </button>
              </div>
              <ul className="space-y-0.5">
                {main.map((item) => (
                  <li key={item.id} data-tour={`nav-${item.id}`}>
                    <NavButton
                      active={section === item.id}
                      // Pages again, while a page is open: back to the list.
                      onClick={() => (item.id === "pages" && section === "pages" && openPage ? closePage() : showSection(item.id))}
                      hint={navCollapsed ? item.label : item.hint}
                      icon={item.id}
                      collapsed={navCollapsed}
                    >
                      {item.label}
                    </NavButton>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                data-tour="find"
                onClick={() => {
                  setMenuOpen(false);
                  openPageFinder();
                }}
                title={`Find any page of your site (${finderShortcut()})`}
                aria-label={navCollapsed ? "Find a page" : undefined}
                className={`mt-2 flex h-10 w-full items-center gap-3 rounded-xl border border-zinc-200 px-3 text-left text-sm text-zinc-500 transition-colors hover:border-zinc-300 hover:text-foreground dark:border-zinc-800 dark:hover:border-zinc-700 ${navCollapsed ? "lg:justify-center lg:px-0" : ""}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[17px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <span className={`flex-1 ${navCollapsed ? "lg:sr-only" : ""}`}>Find a page</span>
                <kbd suppressHydrationWarning className={`rounded border border-zinc-200 px-1 text-[10px] dark:border-zinc-700 ${navCollapsed ? "lg:hidden" : ""}`}>
                  {finderShortcut()}
                </kbd>
              </button>
              <div className="mt-3 border-t border-zinc-100 pt-2 lg:mt-auto dark:border-zinc-800">
                <NavButton
                  active={section === "more" || TOOL_IDS.has(section)}
                  onClick={() => showSection("more")}
                  hint={navCollapsed ? "More tools" : "Tools most owners never need"}
                  icon="more"
                  collapsed={navCollapsed}
                  small
                >
                  More tools
                </NavButton>
                <LearnFeaturesButton collapsed={navCollapsed} isCreator={isCreator} active={section === "learn"} onClick={() => showSection("learn")} />
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    startTour();
                  }}
                  title={navCollapsed ? "Take a tour" : "A quick look at everything the builder can do"}
                  aria-label={navCollapsed ? "Take a tour" : undefined}
                  className={`flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-900 ${navCollapsed ? "lg:justify-center lg:px-0" : ""}`}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[19px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
                  </svg>
                  <span className={navCollapsed ? "lg:sr-only" : ""}>Take a tour</span>
                </button>
              </div>
            </div>
          </nav>
          </div>

          <div className="min-w-0 space-y-4 lg:pb-24">
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {links}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                <TopBar />
                <div className="flex items-center gap-3">{account}</div>
              </div>
            </header>
            {/* The screen on its white card; the AI bar floats below it on the page's grey. The AI's
                loader covers only this card, so the header and the menu stay usable while it works. */}
            <div className="relative">
            <div data-tour="screen" className="space-y-6 rounded-2xl bg-background p-4 shadow-sm sm:p-6">
              <SiteNotices onReset={resetToDefault} onShowIncoming={incoming ? () => setIncomingOpen(true) : null} />
              {incoming && incomingOpen && (
                <GitHubChangesModal owner={owner} repo={repo} incoming={incoming} onAccepted={(result) => void incomingAccepted(result)} onClose={() => setIncomingOpen(false)} />
              )}
              {clashes && (
                <PublishClashes
                  owner={owner}
                  repo={repo}
                  overview={overview}
                  sha={clashes.sha}
                  clashes={clashes.clashes}
                  subjects={clashes.subjects}
                  onMoved={async () => {
                    const then = clashes.then;
                    const result = await syncForPublish();
                    if (result.clashes?.length) setClashes({ sha: result.sha!, clashes: result.clashes, subjects: result.subjects, then });
                    else {
                      setClashes(null);
                      toast.info("Someone published again, and it combined with your changes by itself. Press Publish when you're ready.");
                    }
                  }}
                  onCombined={(latest) => {
                    setStatus(latest);
                    void refresh();
                    if (latest.needsInstall) void run("install");
                  }}
                  onPublish={() => {
                    const then = clashes.then;
                    setClashes(null);
                    then();
                  }}
                  onClose={() => setClashes(null)}
                />
              )}
              {runError instanceof ApiError && runError.code === "needs_install" ? (
                <Notice tone="warning">
                  <span className="flex flex-wrap items-center gap-3">
                    <span>Your site&apos;s tools need setting up before the preview and the AI can work. It takes a minute or two.</span>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => {
                        setRunError(null);
                        showSection("tools");
                        void run("install");
                      }}
                    >
                      Set up now
                    </Button>
                  </span>
                </Notice>
              ) : (
                <ErrorText error={runError} />
              )}
              {/* After every build, on every screen: links to pages that don't exist yet, with a way to make them. */}
              {!status.needsInstall && <MissingPages />}
              {TOOL_IDS.has(section) && (
                <button type="button" onClick={() => showSection("more")} className="text-sm text-zinc-500 hover:underline">
                  ← More tools
                </button>
              )}
              {/* What's changed and Earlier versions open from the top bar and More tools, not the menu: a way back. */}
              {section === "publish" && (
                <button type="button" onClick={() => showSection(cameFrom === "publish" ? "home" : cameFrom)} className="text-sm text-zinc-500 hover:underline">
                  ← Back to {screenLabel(cameFrom === "publish" ? "home" : cameFrom)}
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
                  <div data-tour="brand">
                    <BrandPanel />
                  </div>
                  <div data-tour="header-footer">
                    <HeaderFooterPanel />
                  </div>
                </div>
              )}
              {section === "details" && <StaticInfoPanel view="business" />}
              {section === "domain" && <DomainPanel />}
              {section === "publish" && <ChangesPanel />}
              {section === "analytics" && isCreator && <AnalyticsPanel />}
              {section === "more" && <MoreToolsPanel />}
              {section === "learn" && <LearnPanel isCreator={isCreator} />}
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
              {section === "files" && <FilesPanel />}
              {section === "styles" && (
                <div className="space-y-6">
                  <ScriptsPanel />
                  <StylesPanel />
                </div>
              )}
              {section === "models" && <ModelPanel />}
              {section === "tools" && <BuildPanel />}
            </div>
            <AiActivity />
            <SiteBuildActivity />
            </div>

            {withAiBar && (
              // Stays at the bottom of the window as the screen scrolls, with the status strip above it.
              <div className="sticky bottom-3 z-30 space-y-2 pt-2">
                <StatusStrip inline onShowLog={() => showSection("tools")} />
                <AiBar />
              </div>
            )}
          </div>
        </div>
        {!withAiBar && <StatusStrip onShowLog={() => showSection("tools")} />}
      </Frame>
      <AssistantPanel />
      <FirstRunSetup />
      <Tour active={section === "home"} />
      <FeatureGuide section={section} isCreator={isCreator} />
      <PageFinder />
      </AssistantProvider>
    </SiteContext.Provider>
  );
}

/**
 * Above every screen: where the site is, whether everything is live (which opens what's changed),
 * how much AI help is left, the conversation's show/hide button, and Publish (PublishNowState).
 */
/**
 * The AI bar under the screen, only while the chat on the right is closed: one place to write at a
 * time. It stays mounted (so what's typed in it is kept) and folds away: it fades and slides down
 * while its row's height closes (grid rows 1fr → 0fr), and comes back the same way.
 */
function AiBar() {
  const { open } = useAssistant();
  return (
    <div
      inert={open}
      aria-hidden={open}
      className={`grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
        open ? "pointer-events-none translate-y-4 grid-rows-[0fr] opacity-0" : "translate-y-0 grid-rows-[1fr] opacity-100"
      }`}
    >
      {/* Clipped only while hidden, so the bar's shadow shows when it's there. */}
      <div data-tour="ai-bar" className={`min-h-0 ${open ? "overflow-hidden" : ""}`}>
        <AskClaude />
      </div>
    </div>
  );
}

function TopBar() {
  const { owner, repo, status, busy, publishing: state, publishNow, showSection } = useSite();
  const { open: chatOpen, setOpen: setChatOpen, turn } = useAssistant();
  const aiWorking = turn?.status === "running";
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

  const { available, working, publish, asking, go, cancel, published, closePublished } = publishNow;
  // The first time a site has unpublished changes, say once that Publish is what makes them live.
  const nudgeKey = `twinstack:publish-nudge:${owner}/${repo}`;
  const [nudgeDismissed, setNudgeDismissed] = useState(() => {
    try {
      return localStorage.getItem(nudgeKey) === "1";
    } catch {
      return true;
    }
  });
  const dismissNudge = () => {
    setNudgeDismissed(true);
    try {
      localStorage.setItem(nudgeKey, "1");
    } catch {
      // Shown again next visit.
    }
  };
  const showNudge = changes > 0 && status.onDefaultBranch && !nudgeDismissed && !asking && working === null && !chatOpen;

  const label = working === "checking" ? "Checking your site…" : working === "publishing" ? "Publishing…" : status.onDefaultBranch ? "Publish" : "Add to the review";

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      {address && (
        <a href={address} target="_blank" rel="noreferrer" className="max-w-full truncate text-sm text-zinc-500 hover:text-foreground">
          {address.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
        </a>
      )}
      {/* The pill is also the way to what's changed. */}
      <button type="button" data-tour="changes" onClick={() => showSection("publish")} title="See what changed" className={`rounded-full px-3 py-1 text-xs font-medium hover:opacity-80 ${pill.tone}`}>
        {pill.text}
      </button>
      {/* <AiHelpBadge /> */}
      <button
        type="button"
        onClick={() => {
          if (!chatOpen) noteFeature("chat-panel");
          setChatOpen(!chatOpen);
        }}
        aria-pressed={chatOpen}
        data-tour="chat"
        className={`flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold transition-colors ${
          chatOpen
            ? "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200"
            : "bg-background text-foreground shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
        }`}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
        </svg>
        {chatOpen ? "Hide chat" : "Chat with the AI"}
        {aiWorking && !chatOpen && <span className="size-2 animate-pulse rounded-full bg-indigo-500 motion-reduce:animate-none" aria-label="The AI is working" />}
      </button>
      <div className="relative">
      <button
        type="button"
        data-tour="publish"
        disabled={!available || busy || working !== null}
        onClick={() => {
          dismissNudge();
          void publish();
        }}
        className="flex h-10 items-center gap-2 rounded-xl bg-indigo-700 px-5 text-sm font-bold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {working && <Spinner />}
        {label}
      </button>
      {showNudge && (
        <div role="status" className="absolute right-0 top-12 z-40 w-72 rounded-2xl bg-zinc-900 p-4 text-sm text-white shadow-xl dark:bg-zinc-100 dark:text-zinc-900">
          <span aria-hidden="true" className="absolute -top-1.5 right-8 size-3 rotate-45 bg-zinc-900 dark:bg-zinc-100" />
          <p className="font-semibold">Your changes aren&apos;t on your website yet</p>
          <p className="mt-1 opacity-80">They&apos;re saved here, but visitors only see them once you press Publish.</p>
          <button type="button" onClick={dismissNudge} className="mt-3 font-semibold underline">
            Got it
          </button>
        </div>
      )}
      </div>
      {asking && <PublishNote changes={changes} onPublish={(note) => void go(note)} onCancel={cancel} />}
      {published && <PublishedPages pages={published} siteUrl={publishing?.url ?? null} onClose={closePublished} />}
    </div>
  );
}

/** The few states that change what every screen means: an unfinished review, or newer work on GitHub. */
function SiteNotices({ onReset, onShowIncoming }: { onReset: () => void; onShowIncoming: (() => void) | null }) {
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
        {onShowIncoming ? (
          <Button variant="ghost" className="ml-1 underline" disabled={busy} onClick={onShowIncoming}>
            See what changed
          </Button>
        ) : noChanges ? (
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
  icon,
  collapsed = false,
  small = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  hint?: string;
  icon: SiteSection;
  collapsed?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-label={collapsed ? String(children) : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors ${collapsed ? "lg:justify-center lg:px-0" : ""} ${
        active
          ? "bg-indigo-50 font-semibold text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200"
          : `${small ? "" : "font-medium"} text-zinc-600 hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-900`
      }`}
    >
      <NavIcon section={icon} />
      <span className={collapsed ? "lg:sr-only" : ""}>{children}</span>
    </button>
  );
}

/**
 * The editor's page: soft grey, with the menu and screens on white cards. While the conversation
 * is open on a wide screen, it's docked on the right and the page makes room for it.
 */
/** The editor's background and page width, leaving room for the chat when it's open. */
function Frame({ children }: { children: React.ReactNode }) {
  const assistant = useOptionalAssistant();
  return (
    <div className="flex flex-1 flex-col bg-[#F6F6F3] dark:bg-zinc-950">
      <main className={`mx-auto w-full flex-1 px-4 pb-24 pt-4 transition-[padding] ${assistant?.open ? "xl:max-w-none xl:pr-[30rem]" : ""}`}>{children}</main>
    </div>
  );
}

/** The way back to the list of sites: a button with its words, or just the arrow while the menu is folded. */
function BackToSites({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      href="/dashboard"
      title="Back to your sites"
      aria-label={collapsed ? "Back to your sites" : undefined}
      className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-200 text-sm font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-foreground dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 ${
        collapsed ? "mx-auto flex w-9 justify-center" : "pl-2 pr-3"
      }`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
      {!collapsed && "Your sites"}
    </Link>
  );
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <Link href="/dashboard" title="Your sites" className="flex items-center gap-2 font-semibold tracking-tight">
      <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-foreground text-xs text-background">
        TS
      </span>
      <span className={collapsed ? "lg:sr-only" : ""}>Twinstack</span>
    </Link>
  );
}

/** While a site opens, or if it can't: the editor's layout isn't there yet. */
function Shell({ title, account, children }: { title: string; account: React.ReactNode; children: React.ReactNode }) {
  return (
    <Frame>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Brand />
        <div className="flex items-center gap-3">{account}</div>
      </div>
      <Link href="/dashboard" className="mt-4 inline-block text-sm text-zinc-500 hover:text-foreground">
        ← Your sites
      </Link>
      <h1 className="mt-1.5 truncate text-2xl font-bold tracking-tight">{title}</h1>
      {children}
    </Frame>
  );
}


/** The menu's "Learn the features" screen, with how far the owner has got. */
function LearnFeaturesButton({ collapsed, isCreator, active, onClick }: { collapsed: boolean; isCreator: boolean; active: boolean; onClick: () => void }) {
  const { done, total } = useFeatureProgress(isCreator);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Learn the features: ${done} of ${total} tried`}
      aria-label={collapsed ? "Learn the features" : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors ${collapsed ? "lg:justify-center lg:px-0" : ""} ${
        active
          ? "bg-indigo-50 font-semibold text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200"
          : "text-zinc-600 hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-900"
      }`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[19px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
      </svg>
      <span className={`min-w-0 flex-1 truncate whitespace-nowrap ${collapsed ? "lg:sr-only" : ""}`}>Learn the features</span>
      <span className={collapsed ? "lg:hidden" : ""}>
        <ProgressRing done={done} total={total} size={16} />
      </span>
      <span className="sr-only">
        ({done} of {total} tried)
      </span>
    </button>
  );
}
