"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { summarizeChanges } from "@/lib/change-labels";
import { confirmModal } from "@/lib/confirm";
import { api, workspacePath, type Job, type NavigationInfo, type Overview, type Publishing, type SiteCheck, type SiteUpdateInfo, type WorkspaceStatus } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { wasVisited } from "./HomePanel";
import type { PublishNowState, PublishingState, SiteTools, SiteUpdateState } from "./site-context";

// While a deploy runs, and for a while after anything changes (a push starts a
// run a few seconds later), GitHub is asked again every few seconds.
const FAST_POLL_MS = 8000;
const SLOW_POLL_MS = 60000;
const WATCH_AFTER_CHANGE_MS = 90000;

/** The copy's GitHub Pages state and latest deploy, polled for as long as the editor is open. */
export function usePublishing(owner: string, repo: string, version: number): PublishingState {
  const [publishing, setPublishing] = useState<Publishing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<"enable" | "deploy" | null>(null);
  // When something last changed; the poll speeds up for a while after it.
  const changedAt = useRef(0);
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

  const act = useCallback(
    async (kind: "enable" | "deploy") => {
      setWorking(kind);
      setError(null);
      try {
        setPublishing(await api<Publishing>(workspacePath(owner, repo, `/publishing/${kind}`), { method: "POST", body: {} }));
        changedAt.current = Date.now();
      } catch (err) {
        setError(err);
      } finally {
        setWorking(null);
      }
    },
    [owner, repo],
  );

  const watch = useCallback(() => {
    changedAt.current = Date.now();
  }, []);

  return { publishing, error, working, act, setPublishing, watch };
}

type ToolUpdate = { id: "publishing" | "seo" | "header-footer"; what: string };

/**
 * Copies made before a template feature lack its files. Each has an installer
 * (`POST …/install/<id>`) that copies the template's versions in as uncommitted
 * changes; this runs every one the copy needs, in one go.
 */
export function useSiteTools({
  owner,
  repo,
  version,
  overview,
  publishing,
  setStatus,
  refresh,
}: {
  owner: string;
  repo: string;
  version: number;
  overview: Overview | null;
  publishing: Publishing | null;
  setStatus: (status: WorkspaceStatus) => void;
  refresh: () => Promise<void>;
}): SiteTools {
  const [appearance, setAppearance] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [written, setWritten] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<NavigationInfo>(workspacePath(owner, repo, "/navigation"))
      .then((info) => !cancelled && setAppearance(info.supportsAppearance))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const needed: ToolUpdate[] = [];
  // Publishing first: SEO's files include build.js and check.js too, so the newest win.
  if (publishing && !publishing.workflowReady) needed.push({ id: "publishing", what: "publishing on the web" });
  if (overview?.features.seo === false || overview?.features.seoTemplate === false) needed.push({ id: "seo", what: "search settings" });
  if (appearance === false) needed.push({ id: "header-footer", what: "header and footer colours" });
  const ids = needed.map((n) => n.id).join(",");

  const update = useCallback(async () => {
    setUpdating(true);
    setError(null);
    const files: string[] = [];
    try {
      for (const id of ids.split(",").filter(Boolean)) {
        const result = await api<{ written: string[]; status: WorkspaceStatus }>(workspacePath(owner, repo, `/install/${id}`), {
          method: "POST",
          body: {},
        });
        files.push(...result.written);
        setStatus(result.status);
      }
      setWritten(files);
      await refresh();
    } catch (err) {
      setError(err);
      if (files.length) setWritten(files);
      await refresh().catch(() => {});
    } finally {
      setUpdating(false);
    }
  }, [ids, owner, repo, setStatus, refresh]);

  return { outdated: needed.map((n) => n.what), updating, error, written, update };
}

/** The error a failed job ended with: the output ends "\n\n<error>\n\nEnded: failed (exit 1).\n". */
function jobFailure(output: string) {
  const chunks = output.replace(/\r/g, "").trimEnd().split("\n\n");
  return chunks.length > 1 ? chunks[chunks.length - 2].trim() : "The update didn't finish. Your site hasn't changed.";
}

/**
 * One-click site updates (server/src/site-update.js): the template's newest release is merged
 * into the published site by a job, keeping the owner's work, and can be undone while nothing
 * has been published since.
 */
export function useSiteUpdate({
  owner,
  repo,
  version,
  runJobAt,
  run,
  setStatus,
  watch,
}: {
  owner: string;
  repo: string;
  version: number;
  runJobAt: (rest: string) => Promise<Job>;
  run: (command: string) => Promise<boolean>;
  setStatus: (status: WorkspaceStatus) => void;
  watch: () => void;
}): SiteUpdateState {
  const [info, setInfo] = useState<SiteUpdateInfo | null>(null);
  const [working, setWorking] = useState<"update" | "undo" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<SiteUpdateInfo>(workspacePath(owner, repo, "/site-update"))
      .then((next) => !cancelled && setInfo(next))
      // No update offer is better than an error on Home: the template may have no release yet.
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const update = useCallback(async () => {
    setWorking("update");
    setError(null);
    setDone(null);
    try {
      const job = await runJobAt("/site-update");
      if (job.status === "succeeded") {
        setDone("Your site is updated. It goes live in a minute or two.");
        watch();
      } else {
        setError(new Error(job.status === "cancelled" ? "The update was stopped." : jobFailure(job.output)));
      }
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }, [runJobAt, watch]);

  const undo = useCallback(async () => {
    setWorking("undo");
    setError(null);
    setDone(null);
    try {
      const result = await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/site-update/undo"), { method: "POST", body: {} });
      setStatus(result.status);
      setDone("The update is undone. Your site goes back in a minute or two.");
      watch();
      // The update may have changed the site's tools; put the earlier ones back.
      if (result.status.needsInstall) await run("install");
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }, [owner, repo, setStatus, watch, run]);

  return { info, working, error, done, update, undo };
}

/**
 * The top bar's Publish button (PublishNowState in site-context.tsx): the Publish screen's "Publish
 * now" in one press, with the same safeguards. It runs the deploy's check first when there's no
 * fresh report (the Publish screen runs it by itself while open), asks before publishing with
 * problems, and leaves a first publish and a review branch to the Publish screen.
 */
export function usePublishNow({
  owner,
  repo,
  status,
  overview,
  runAndWait,
  setStatus,
  refresh,
  watch,
  openPublishScreen,
  onError,
}: {
  owner: string;
  repo: string;
  status: WorkspaceStatus | null;
  overview: Overview | null;
  runAndWait: (command: string) => Promise<Job>;
  setStatus: (status: WorkspaceStatus) => void;
  refresh: () => Promise<void>;
  watch: () => void;
  openPublishScreen: () => void;
  onError: (err: unknown) => void;
}): PublishNowState {
  const [working, setWorking] = useState<"checking" | "publishing" | null>(null);
  const available = Boolean(status && (status.changes.length > 0 || status.ahead || !status.onDefaultBranch));

  const publish = useCallback(async () => {
    if (!status || working) return;
    // A review branch has its own choices, and a first publish asks to check the site details first.
    if (!status.onDefaultBranch || !wasVisited(owner, repo, "details")) {
      openPublishScreen();
      return;
    }
    onError(null);
    try {
      setWorking("checking");
      let check = await api<SiteCheck>(workspacePath(owner, repo, "/check"));
      if (!check.fresh) {
        await runAndWait("check");
        check = await api<SiteCheck>(workspacePath(owner, repo, "/check"));
      }
      if (
        check.fresh &&
        check.report &&
        !check.report.ok &&
        !(await confirmModal(
          "Your site still has problems that stop it from updating. If you publish now, your changes are saved, but your live site stays as it is until they're fixed. What's changed lists the problems.",
          { title: "Publish with problems?", confirmLabel: "Publish anyway", danger: true },
        ))
      ) {
        return;
      }
      setWorking("publishing");
      const message = summarizeChanges(status.changes, overview) || "Update the site";
      const committed = await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/commit"), {
        method: "POST",
        body: { message, mode: "direct" },
      });
      setStatus(committed.status);
      watch();
      await refresh();
      toast.success("Published. Your live site updates in about a minute.");
    } catch (err) {
      onError(err);
      // A failed push may still have committed locally.
      await refresh().catch(() => {});
    } finally {
      setWorking(null);
    }
  }, [owner, repo, status, overview, working, runAndWait, setStatus, refresh, watch, openPublishScreen, onError]);

  return { available, working, publish };
}
