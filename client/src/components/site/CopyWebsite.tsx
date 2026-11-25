"use client";

import { useEffect, useRef } from "react";
import { ApiError, api, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { COPY_BRING_IN_EVENT, COPY_DONE_EVENT, COPY_PROGRESS_EVENT, readSavedQueue, saveQueue, type CopyDone, type CopyProgress } from "@/lib/copy-website";
import { OUT_OF_CREDITS, reasonOf } from "./OriginalPages";
import { useSite } from "./site-context";

// Builds a copied website's pages into the site (server/src/copy-website.js keeps them, frozen as
// they looked, after the AI's copy_website made the prototype). It has no screen of its own: copying
// a website happens only in the AI chat, whose card shows the prototype, and "Build it" there asks
// for this (COPY_BRING_IN_EVENT). Each page goes through the kept-styles conversion like an imported
// repo's pages (OriginalPages.tsx, whose queue this follows): the page giving the site its header and
// footer first, failed pages tried again after the rest, a stop when credits or access run out, and
// a reload carrying on where it stopped. Progress goes to the card (COPY_PROGRESS_EVENT) and the
// report back to the action (COPY_DONE_EVENT). At the end, links to pages that didn't come in point
// at the old website again (POST …/copy-website/finish), so the site check never fails on them.

type CopiedPage = { id: string; address: string; broughtIn: boolean; chromeSource: boolean };
type Copy = { url: string; host: string; pages: CopiedPage[] };
type Prepared = { page: string; source: string; css: string[]; js: string[]; address: string; chromeSource?: boolean; status: WorkspaceStatus };

const MAX_PASSES = 3;
const RETRY_PAUSE_MS = 15_000;
const FREE_WAIT_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure no retry fixes (no credits, lost access): stops the whole run. */
class StopAll extends Error {}

function progress(detail: CopyProgress) {
  window.dispatchEvent(new CustomEvent(COPY_PROGRESS_EVENT, { detail }));
}

export function CopyWebsiteRunner() {
  const { owner, repo, overview, busy, claude, runAndWait, setStatus, refresh } = useSite();
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const runningRef = useRef(false);
  // Read when a run starts, so a run started from an event sees the latest of each.
  const latest = useRef({ overview, claudeReady: claude.ready, runAndWait, setStatus, refresh });
  useEffect(() => {
    latest.current = { overview, claudeReady: claude.ready, runAndWait, setStatus, refresh };
  });

  useEffect(() => {
    const load = () => api<{ copy: Copy | null }>(workspacePath(owner, repo, "/copy-website")).then((data) => data.copy);

    async function waitUntilFree() {
      const until = Date.now() + FREE_WAIT_MS;
      let waited = false;
      while (busyRef.current && Date.now() < until) {
        waited = true;
        await sleep(1000);
      }
      return waited;
    }

    async function bringInOne(id: string) {
      // What was running may have been this very page (carried on through a reload).
      if (await waitUntilFree()) {
        const now = await load().catch(() => null);
        if (now?.pages.find((p) => p.id === id)?.broughtIn) return;
      }
      const { overview: info, runAndWait: run, setStatus: set } = latest.current;
      let prepared: Prepared;
      try {
        prepared = await api<Prepared>(workspacePath(owner, repo, "/copy-website/prepare"), { method: "POST", body: { id } });
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw new StopAll(err.message);
        throw err;
      }
      set(prepared.status);
      const chrome = prepared.chromeSource && info?.features.pageConvertChrome;
      let job;
      try {
        job = await run("page-convert", {
          page: prepared.page,
          source: prepared.source,
          keepStyles: true,
          css: prepared.css,
          js: prepared.js,
          ...(chrome ? { withHeader: true, withFooter: true } : {}),
          ...(info?.features.pageConvertSidebars ? { keepSidebars: true } : {}),
          dryRun: false,
        });
      } catch (err) {
        if (err instanceof ApiError && (err.status === 402 || err.status === 401 || err.status === 403)) throw new StopAll(err.message);
        throw err;
      }
      if (job.status === "succeeded") return;
      if (OUT_OF_CREDITS.test(job.output)) throw new StopAll("You've used all your AI help. Buy more credits, then ask the AI to build the rest.");
      throw new Error(reasonOf(job.output));
    }

    async function run(chosen: string[]) {
      if (runningRef.current) return;
      runningRef.current = true;
      let done = 0;
      let missing: string[] = [];
      let stopped: string | null = null;
      const failed: Record<string, string> = {};
      let total = 0;
      try {
        const copy = await load();
        const byId = new Map((copy?.pages ?? []).map((p) => [p.id, p]));
        const source = copy?.pages.find((p) => p.chromeSource && !p.broughtIn);
        let ids = (source && !chosen.includes(source.id) ? [source.id, ...chosen] : chosen).filter((id) => byId.has(id));
        total = ids.length;
        progress({ done, total, working: null, retryPass: null });
        for (let pass = 1; pass <= MAX_PASSES && ids.length && !stopped; pass++) {
          if (pass > 1) {
            progress({ done, total, working: null, retryPass: pass });
            await sleep(RETRY_PAUSE_MS);
          }
          const failedNow: string[] = [];
          for (const [index, id] of ids.entries()) {
            saveQueue(owner, repo, [id, ...ids.slice(index + 1), ...failedNow]);
            progress({ done, total, working: byId.get(id)?.address ?? id, retryPass: null });
            try {
              await bringInOne(id);
              delete failed[id];
              done++;
            } catch (err) {
              failed[id] = err instanceof Error ? err.message : String(err);
              if (err instanceof StopAll) {
                stopped = err.message;
                break;
              }
              failedNow.push(id);
            }
          }
          ids = failedNow;
        }
        if (!stopped) {
          const finished = await api<{ missing: string[]; status: WorkspaceStatus }>(workspacePath(owner, repo, "/copy-website/finish"), { method: "POST", body: {} }).catch(() => null);
          if (finished) {
            missing = finished.missing;
            latest.current.setStatus(finished.status);
          }
        }
      } catch (err) {
        stopped = err instanceof Error ? err.message : String(err);
      } finally {
        saveQueue(owner, repo, []);
        await latest.current.refresh().catch(() => {});
        runningRef.current = false;
        const reasons = Object.values(failed).slice(0, 3);
        const detail: CopyDone = { broughtIn: done, total, missing, stopped: stopped ?? (reasons.length ? `Some pages didn't work: ${reasons.join(" | ").slice(0, 500)}` : null) };
        window.dispatchEvent(new CustomEvent(COPY_DONE_EVENT, { detail }));
      }
    }

    // "Build it" on the prototype card saves the queue and asks for it here.
    const onBringIn = () => {
      void (async () => {
        if (runningRef.current) return;
        const fresh = await load().catch(() => null);
        const waiting = new Set((fresh?.pages ?? []).filter((p) => !p.broughtIn).map((p) => p.id));
        const ids = readSavedQueue(owner, repo).filter((id) => waiting.has(id));
        if (ids.length) await run(ids);
        else window.dispatchEvent(new CustomEvent(COPY_DONE_EVENT, { detail: { broughtIn: 0, total: 0, missing: [], stopped: "Nothing was waiting to be built." } satisfies CopyDone }));
      })();
    };
    window.addEventListener(COPY_BRING_IN_EVENT, onBringIn);

    // A build cut short by a reload carries on by itself, once the site is open and the AI ready.
    const resume = setTimeout(() => {
      if (!readSavedQueue(owner, repo).length || !latest.current.claudeReady) return;
      onBringIn();
    }, 4000);

    return () => {
      window.removeEventListener(COPY_BRING_IN_EVENT, onBringIn);
      clearTimeout(resume);
    };
  }, [owner, repo]);

  return null;
}
