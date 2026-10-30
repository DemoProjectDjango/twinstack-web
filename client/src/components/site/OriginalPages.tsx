"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { ApiError, api, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Notice, Spinner } from "./ui";

// A repo that had the site tools added (Create a new site → "Use a repo I already have") keeps its
// own .html pages where they were. GET …/original-pages lists them, and each is brought in with the
// kept-styles conversion (page-convert) at its own address, so it looks the same and every screen
// can change it. While GitHub Pages still publishes the repo as it was, the old site stays live
// until "Switch your live site" (install the deploy workflow, switch Pages, publish).

// chromeSource: the page the site's header and footer are copied from (the one most pages share).
type OriginalPage = { file: string; address: string; title: string | null; page: string | null; broughtIn: boolean; chromeSource?: boolean };
type Prepared = { page: string; source: string; css: string[]; js: string[]; address: string; chromeSource?: boolean; status: WorkspaceStatus };

// A page that fails is tried again once the others are done, up to MAX_PASSES times in all. Most
// failures pass: Claude busy or rate-limited after many pages in a row, the server restarting, or a
// check a second conversion passes. Bringing in 87 pages used to leave a third of them failed.
const MAX_PASSES = 3;
const RETRY_PAUSE_MS = 15_000;
// How long to wait for a command still running (from before a reload, or another tab) to finish.
const FREE_WAIT_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What's left of a "Bring in", per site and tab, so a reload or a visit to another page carries on
// where it stopped instead of leaving the rest undone.
const queueKey = (owner: string, repo: string) => `twinstack:original-pages-queue:${owner}/${repo}`;
function readSavedQueue(owner: string, repo: string): string[] {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(queueKey(owner, repo)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((file): file is string => typeof file === "string") : [];
  } catch {
    return [];
  }
}
function saveQueue(owner: string, repo: string, files: string[]) {
  try {
    if (files.length) window.sessionStorage.setItem(queueKey(owner, repo), JSON.stringify(files));
    else window.sessionStorage.removeItem(queueKey(owner, repo));
  } catch {
    // It just won't carry on after a reload.
  }
}

/** A failure no retry fixes: out of credits, or Claude or GitHub access gone. Stops the whole run. */
class StopAll extends Error {}
const OUT_OF_CREDITS = /used all your Claude credits|billing_error/i;

/** What the conversion said went wrong: its "Refused to write" list when there is one, else its last lines. */
function reasonOf(output: string) {
  const refused = output.match(/Refused to write[^\n]*\n((?:\s+- .*\n?)+)/);
  if (refused) return `It looked wrong, so nothing was written: ${refused[1].trim().split("\n").map((line) => line.trim().replace(/^- /, "")).join("; ")}`;
  return output.trim().split("\n").slice(-6).join("\n") || "It stopped without saying why.";
}

export function OriginalPages() {
  const { owner, repo, version, overview, busy, claude, runAndWait, setStatus, refresh, showOnSite, publishing, publishNow } = useSite();
  const [pages, setPages] = useState<OriginalPage[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  // Why a page couldn't be brought in, by file: shown on its row until it's tried again.
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [switching, setSwitching] = useState(false);
  // Waiting before trying the failed pages again: which try is next.
  const [retryPass, setRetryPass] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  // The editor's busy state, for the loop (which outlives renders).
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const resumed = useRef(false);
  // The page being brought in stays in view in the scrolling list (only the list scrolls, not the page).
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = working ? [...(list?.children ?? [])].find((el) => (el as HTMLElement).dataset.file === working) : null;
    if (!list || !(row instanceof HTMLElement)) return;
    const top = row.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: top - (list.clientHeight - row.offsetHeight) / 2, behavior: "smooth" });
    }
  }, [working]);

  useEffect(() => {
    let cancelled = false;
    api<{ pages: OriginalPage[] }>(workspacePath(owner, repo, "/original-pages"))
      .then((data) => !cancelled && setPages(data.pages))
      // Older servers, or a site with no pages of its own: nothing to show.
      .catch(() => !cancelled && setPages([]));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const left = (pages ?? []).filter((p) => !p.broughtIn);
  const canConvert = Boolean(overview?.features.pageConvert && overview.features.pageConvertStyles);

  /** Waits while another command holds the site (one still running from before a reload, say); whether it had to. */
  async function waitUntilFree() {
    const until = Date.now() + FREE_WAIT_MS;
    let waited = false;
    while (busyRef.current && Date.now() < until && !stopRef.current) {
      waited = true;
      await sleep(1000);
    }
    return waited;
  }

  /** Brings one page in; throws why it didn't work. */
  async function bringInOne(file: string) {
    // What was running may have been this very page (its conversion carried on while the page
    // reloaded): then it's in already, and converting it again would only spend credits.
    if (await waitUntilFree()) {
      const latest = await api<{ pages: OriginalPage[] }>(workspacePath(owner, repo, "/original-pages")).catch(() => null);
      if (latest?.pages.find((p) => p.file === file)?.broughtIn) return;
    }
    let prepared: Prepared;
    try {
      prepared = await api<Prepared>(workspacePath(owner, repo, "/original-pages/prepare"), { method: "POST", body: { file } });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw new StopAll(err.message);
      throw err;
    }
    setStatus(prepared.status);
    // The header and footer most pages share become the site's (older servers: the homepage's).
    // A page with different ones keeps its own, so every page looks as it did.
    const chrome = (prepared.chromeSource ?? prepared.address === "/") && overview?.features.pageConvertChrome;
    let job;
    try {
      job = await runAndWait("page-convert", {
        page: prepared.page,
        source: prepared.source,
        keepStyles: true,
        css: prepared.css,
        js: prepared.js,
        ...(chrome ? { withHeader: true, withFooter: true } : {}),
        dryRun: false,
      });
    } catch (err) {
      // Claude can't be used (no credits, no key): every other page would fail the same way.
      if (err instanceof ApiError && (err.status === 402 || err.status === 401 || err.status === 403)) throw new StopAll(err.message);
      throw err;
    }
    if (job.status === "succeeded") return;
    if (OUT_OF_CREDITS.test(job.output)) throw new StopAll("You've used all your Claude credits. Buy more credits, then bring in the rest.");
    throw new Error(reasonOf(job.output));
  }

  // One page failing doesn't stop the others: the failed ones are tried again after the rest, and
  // a reason stays on a row only once every try has failed. The page the site's header and footer
  // come from goes first: the others are compared with what it gives the site.
  async function bringIn(chosen: string[]) {
    const source = pages?.find((p) => p.chromeSource && !p.broughtIn);
    let files = source && !chosen.includes(source.file) ? [source.file, ...chosen] : chosen;
    const total = files.length;
    let done = 0;
    const reasons: Record<string, string> = {};
    stopRef.current = false;
    setStopping(false);
    setError(null);
    setFailed((now) => Object.fromEntries(Object.entries(now).filter(([file]) => !files.includes(file))));
    setProgress({ done, total });
    try {
      for (let pass = 1; pass <= MAX_PASSES && files.length && !stopRef.current; pass++) {
        if (pass > 1) {
          setWorking(null);
          setRetryPass(pass);
          setQueue(files);
          await sleep(RETRY_PAUSE_MS);
          setRetryPass(null);
        }
        const failedNow: string[] = [];
        for (const [index, file] of files.entries()) {
          if (stopRef.current) break;
          const rest = files.slice(index + 1);
          setWorking(file);
          setQueue([...rest, ...failedNow]);
          saveQueue(owner, repo, [file, ...rest, ...failedNow]);
          try {
            await bringInOne(file);
            delete reasons[file];
            setProgress({ done: ++done, total });
          } catch (err) {
            reasons[file] = err instanceof Error ? err.message : String(err);
            if (err instanceof StopAll) {
              stopRef.current = true;
              setError(err);
              break;
            }
            failedNow.push(file);
          }
        }
        files = failedNow;
      }
    } finally {
      setFailed((now) => ({ ...now, ...reasons }));
      setWorking(null);
      setQueue([]);
      setRetryPass(null);
      setProgress(null);
      setStopping(false);
      saveQueue(owner, repo, []);
      await refresh().catch(() => {});
    }
  }

  function stop() {
    stopRef.current = true;
    setStopping(true);
  }

  // A "Bring in" cut short by a reload or a visit to another page carries on by itself.
  useEffect(() => {
    if (resumed.current || !pages || !canConvert || !claude.ready) return;
    // In a timer, so an effect run twice (development) resumes once.
    const timer = setTimeout(() => {
      resumed.current = true;
      const waiting = new Set(pages.filter((p) => !p.broughtIn).map((p) => p.file));
      const rest = readSavedQueue(owner, repo).filter((file) => waiting.has(file));
      if (rest.length) void bringIn(rest);
      else saveQueue(owner, repo, []);
    }, 0);
    return () => clearTimeout(timer);
    // bringIn is a new function on every render; this only runs once, when the list first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, canConvert, claude.ready, owner, repo]);

  if (!pages?.length) return null;
  const oldSiteLive = publishing.publishing ? publishing.publishing.enabled && !publishing.publishing.usesActions : false;

  async function switchLive() {
    const missing = left.length
      ? ` ${left.length} of your pages ${left.length === 1 ? "isn't" : "aren't"} brought in yet and won't be on the new site.`
      : "";
    const ok = await confirmModal(
      `Your live address will show the new site, built from the pages here, instead of the files GitHub publishes now.${missing} Your original files stay in the repository.`,
      { title: "Switch your live site?", confirmLabel: "Switch it", danger: left.length > 0 },
    );
    if (!ok) return;
    setSwitching(true);
    setError(null);
    try {
      if (!publishing.publishing?.workflowReady) {
        const result = await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/install/publishing"), { method: "POST", body: {} });
        setStatus(result.status);
      }
      await publishing.act("enable");
      // The push starts the first deploy of the new site.
      await publishNow.publish();
    } catch (err) {
      setError(err);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <section aria-label="Your existing pages" className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">Your existing pages</h3>
          <p className="mt-0.5 text-sm text-zinc-500">
            {left.length
              ? `${left.length} of ${pages.length} pages from your repository still need bringing in. Each keeps its look and can then be changed on every screen.`
              : "Every page from your repository is in your site."}
          </p>
        </div>
        {progress ? (
          <Button variant="ghost" disabled={stopping} onClick={stop} title="The page being brought in now finishes first.">
            {stopping ? "Stopping after this page…" : "Stop"}
          </Button>
        ) : (
          left.length > 0 &&
          canConvert && (
            <Button variant="primary" disabled={busy || !claude.ready} onClick={() => void bringIn(left.map((p) => p.file))}>
              {`Bring in ${left.length === 1 ? "the page" : `all ${left.length}`}`}
            </Button>
          )
        )}
      </div>

      {progress && progress.total > 1 && (
        <p role="status" className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <Spinner />
          {retryPass
            ? `Trying the pages that didn't work again in a moment (try ${retryPass} of ${MAX_PASSES})…`
            : `Brought in ${progress.done} of ${progress.total}. You can go to other screens or reload the page: it carries on.`}
        </p>
      )}

      {!canConvert && (
        <Notice tone="warning">This site&apos;s tools are too old to bring pages in. Update the site tools on Edit site first.</Notice>
      )}
      {canConvert && !claude.ready && left.length > 0 && (
        <Notice tone="warning">
          {claude.reason}{" "}
          <Link href={claude.setupHref} className="font-medium underline">
            {claude.setupLabel}
          </Link>
        </Notice>
      )}

      {/* A fixed height that scrolls inside, so a site with many pages doesn't push the rest of the screen down. */}
      <ul ref={listRef} className="relative max-h-[22rem] divide-y divide-zinc-200 overflow-y-auto rounded-md border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {pages.map((page) => (
          <li key={page.file} data-file={page.file} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{page.title ?? page.file}</span> <span className="text-zinc-500">{page.address}</span>
            </span>
            {working === page.file ? (
              <span className="flex items-center gap-2 text-zinc-500">
                <Spinner /> Bringing it in (a minute or two)…
              </span>
            ) : queue.includes(page.file) ? (
              <Badge>Waiting</Badge>
            ) : page.broughtIn ? (
              <>
                <Badge>In your site</Badge>
                <Button variant="ghost" onClick={() => showOnSite(page.address)}>
                  See it
                </Button>
              </>
            ) : (
              canConvert && (
                <Button disabled={busy || Boolean(progress) || !claude.ready} onClick={() => void bringIn([page.file])}>
                  {failed[page.file] ? "Try again" : "Bring in"}
                </Button>
              )
            )}
            {failed[page.file] && working !== page.file && (
              <p role="alert" className="basis-full whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">
                Couldn&apos;t bring it in. {failed[page.file]}
              </p>
            )}
          </li>
        ))}
      </ul>

      <ErrorText error={error} />

      {oldSiteLive && (
        <Notice tone={left.length ? "info" : "success"}>
          <span className="font-medium">Your old site is still the live one.</span> Changes here don&apos;t reach your visitors until you switch.{" "}
          {left.length ? "Bring your pages in first, then switch." : "All your pages are in, so you can switch now."}{" "}
          <Button variant={left.length ? "ghost" : "primary"} className="ml-1" disabled={busy || switching || Boolean(progress)} onClick={() => void switchLive()}>
            {switching ? "Switching…" : "Switch your live site"}
          </Button>
        </Notice>
      )}
    </section>
  );
}
