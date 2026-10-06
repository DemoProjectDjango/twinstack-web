"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, workspacePath, type NavigationInfo, type Overview, type Publishing, type WorkspaceStatus } from "@/lib/site-api";
import type { PublishingState, SiteTools } from "./site-context";

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
