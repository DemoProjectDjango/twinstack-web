"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { ApiError, api, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { COPY_BRING_IN_EVENT, COPY_DONE_EVENT, readSavedQueue, saveQueue, type CopyDone } from "@/lib/copy-website";
import { toast } from "@/lib/toast";
import { useAssistant } from "./assistant/AssistantProvider";
import { OUT_OF_CREDITS, reasonOf } from "./OriginalPages";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Notice, Spinner, inputClass } from "./ui";

// "Copy a website" (server/src/copy-website.js): the owner gives a website's address, a job opens
// its pages in a browser on the server and keeps each one as it looks (pictures, fonts and styles
// downloaded into the site), and then each page is brought in with the kept-styles conversion,
// like the pages of an imported repository (OriginalPages.tsx, whose queue this follows). The
// first page also gives the site its header and footer. Once they're in, the AI can improve them.

type CopiedPage = {
  id: string;
  url: string;
  address: string;
  title: string | null;
  shots: string[];
  page: string | null;
  broughtIn: boolean;
  chromeSource: boolean;
  replaces?: boolean;
};
type Copy = {
  url: string;
  host: string;
  copiedAt: string;
  pages: CopiedPage[];
  skipped: { url: string; reason: string }[];
  notes: string[];
  assets: { files: number; bytes: number };
};
type Prepared = { page: string; source: string; css: string[]; js: string[]; address: string; chromeSource?: boolean; status: WorkspaceStatus };

const MAX_PASSES = 3;
const RETRY_PAUSE_MS = 15_000;
const FREE_WAIT_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure no retry fixes (no credits, lost access): stops the whole run. */
class StopAll extends Error {}

const IMPROVE_IDEAS = [
  "Suggest the five improvements that would help this site most (design, wording, mobile layout, speed), then ask me which to do.",
  "Make the design more modern and clean while keeping the same content and colours.",
  "Improve how every page looks and works on phones.",
];

export function CopyWebsite() {
  const { owner, repo, version, overview, busy, claude, runAndWait, runJobAt, setStatus, refresh, showOnSite } = useSite();
  const { send, setOpen, turn } = useAssistant();
  const [copy, setCopy] = useState<Copy | null>(null);
  const [limits, setLimits] = useState({ pages: 8, maxPages: 25 });
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(8);
  const [permission, setPermission] = useState(false);
  const [copying, setCopying] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [retryPass, setRetryPass] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [idea, setIdea] = useState("");
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const resumed = useRef(false);
  // The latest copy and bringIn, for runs started from an event (the AI's copy_website) rather than a render.
  const copyRef = useRef<Copy | null>(null);
  useEffect(() => {
    copyRef.current = copy;
  }, [copy]);
  const runningRef = useRef(false);

  async function load() {
    const data = await api<{ copy: Copy | null; limits?: { pages: number; maxPages: number } }>(workspacePath(owner, repo, "/copy-website"));
    copyRef.current = data.copy;
    setCopy(data.copy);
    if (data.limits) setLimits(data.limits);
    setLoaded(true);
    return data.copy;
  }

  useEffect(() => {
    let cancelled = false;
    api<{ copy: Copy | null; limits?: { pages: number; maxPages: number } }>(workspacePath(owner, repo, "/copy-website"))
      .then((data) => {
        if (cancelled) return;
        setCopy(data.copy);
        if (data.limits) {
          setLimits(data.limits);
          setMaxPages((n) => Math.min(n, data.limits!.maxPages));
        }
        setLoaded(true);
      })
      // An older server without the feature: the card doesn't show.
      .catch(() => !cancelled && setLoaded(false));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const canConvert = Boolean(overview?.features.pageConvert && overview.features.pageConvertStyles);
  const left = (copy?.pages ?? []).filter((p) => !p.broughtIn);
  const running = Boolean(progress) || copying;

  async function startCopy(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (copy && left.length < copy.pages.length) {
      const ok = await confirmModal(
        "The pages already brought in stay in your site. The list here will show the new website instead, and pages it shares addresses with will be replaced when you bring them in.",
        { title: "Copy another website?", confirmLabel: "Copy it" },
      );
      if (!ok) return;
    }
    setCopying(true);
    try {
      const job = await runJobAt("/copy-website", { url, maxPages, permission });
      if (job.status !== "succeeded") throw new Error(reasonOf(job.output));
      const next = await load();
      setShowForm(false);
      saveQueue(owner, repo, []);
      setFailed({});
      if (next) toast.success(`Copied ${next.pages.length} ${next.pages.length === 1 ? "page" : "pages"} of ${next.host}. Bring them into your site next.`);
    } catch (err) {
      setError(err);
    } finally {
      setCopying(false);
    }
  }

  async function waitUntilFree() {
    const until = Date.now() + FREE_WAIT_MS;
    let waited = false;
    while (busyRef.current && Date.now() < until && !stopRef.current) {
      waited = true;
      await sleep(1000);
    }
    return waited;
  }

  /** Brings one copied page in; throws why it didn't work. */
  async function bringInOne(id: string) {
    if (await waitUntilFree()) {
      const latest = await api<{ copy: Copy | null }>(workspacePath(owner, repo, "/copy-website")).catch(() => null);
      if (latest?.copy?.pages.find((p) => p.id === id)?.broughtIn) return;
    }
    let prepared: Prepared;
    try {
      prepared = await api<Prepared>(workspacePath(owner, repo, "/copy-website/prepare"), { method: "POST", body: { id } });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw new StopAll(err.message);
      throw err;
    }
    setStatus(prepared.status);
    const chrome = prepared.chromeSource && overview?.features.pageConvertChrome;
    let job;
    try {
      job = await runAndWait("page-convert", {
        page: prepared.page,
        source: prepared.source,
        keepStyles: true,
        css: prepared.css,
        js: prepared.js,
        ...(chrome ? { withHeader: true, withFooter: true } : {}),
        ...(overview?.features.pageConvertSidebars ? { keepSidebars: true } : {}),
        dryRun: false,
      });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 402 || err.status === 401 || err.status === 403)) throw new StopAll(err.message);
      throw err;
    }
    if (job.status === "succeeded") return;
    if (OUT_OF_CREDITS.test(job.output)) throw new StopAll("You've used all your AI help. Buy more credits, then bring in the rest.");
    throw new Error(reasonOf(job.output));
  }

  // Like OriginalPages: the page giving the header and footer goes first, failed pages are tried
  // again after the rest, and at the end links to pages that didn't come in go to the old website.
  async function bringIn(chosen: string[]) {
    if (runningRef.current) return;
    runningRef.current = true;
    const source = copyRef.current?.pages.find((p) => p.chromeSource && !p.broughtIn);
    let ids = source && !chosen.includes(source.id) ? [source.id, ...chosen] : chosen;
    const total = ids.length;
    let done = 0;
    let missing: string[] = [];
    let stopped: string | null = null;
    const reasons: Record<string, string> = {};
    stopRef.current = false;
    setStopping(false);
    setError(null);
    setFailed((now) => Object.fromEntries(Object.entries(now).filter(([id]) => !ids.includes(id))));
    setProgress({ done, total });
    try {
      for (let pass = 1; pass <= MAX_PASSES && ids.length && !stopRef.current; pass++) {
        if (pass > 1) {
          setWorking(null);
          setRetryPass(pass);
          setQueue(ids);
          await sleep(RETRY_PAUSE_MS);
          setRetryPass(null);
        }
        const failedNow: string[] = [];
        for (const [index, id] of ids.entries()) {
          if (stopRef.current) break;
          const rest = ids.slice(index + 1);
          setWorking(id);
          setQueue([...rest, ...failedNow]);
          saveQueue(owner, repo, [id, ...rest, ...failedNow]);
          try {
            await bringInOne(id);
            delete reasons[id];
            setProgress({ done: ++done, total });
          } catch (err) {
            reasons[id] = err instanceof Error ? err.message : String(err);
            if (err instanceof StopAll) {
              stopRef.current = true;
              stopped = err.message;
              setError(err);
              break;
            }
            failedNow.push(id);
          }
        }
        ids = failedNow;
      }
      // Pages still missing: links to them go back to the old website, so the site check passes.
      if (!stopRef.current) {
        const finished = await api<{ relinked: number; missing: string[]; status: WorkspaceStatus }>(workspacePath(owner, repo, "/copy-website/finish"), { method: "POST", body: {} }).catch(() => null);
        if (finished) {
          missing = finished.missing;
          setStatus(finished.status);
          if (finished.missing.length) {
            toast.info(`${finished.missing.length} ${finished.missing.length === 1 ? "page" : "pages"} didn't come in, so links to ${finished.missing.length === 1 ? "it" : "them"} go to the old website. Try again any time.`);
          }
        }
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
      runningRef.current = false;
      if (stopRef.current && !stopped) stopped = "The owner stopped it.";
      const detail: CopyDone = { broughtIn: done, total, missing, stopped };
      window.dispatchEvent(new CustomEvent(COPY_DONE_EVENT, { detail }));
    }
  }
  const bringInRef = useRef(bringIn);
  useEffect(() => {
    bringInRef.current = bringIn;
  });

  // The AI's copy_website: once it has copied a website, it saves the queue and asks for it here.
  useEffect(() => {
    const onBringIn = () => {
      void (async () => {
        if (runningRef.current) return;
        const fresh = await load().catch(() => null);
        const waiting = new Set((fresh?.pages ?? []).filter((p) => !p.broughtIn).map((p) => p.id));
        const ids = readSavedQueue(owner, repo).filter((id) => waiting.has(id));
        if (ids.length) await bringInRef.current(ids);
        else window.dispatchEvent(new CustomEvent(COPY_DONE_EVENT, { detail: { broughtIn: 0, total: 0, missing: [], stopped: "Nothing was waiting to be brought in." } satisfies CopyDone }));
      })();
    };
    window.addEventListener(COPY_BRING_IN_EVENT, onBringIn);
    return () => window.removeEventListener(COPY_BRING_IN_EVENT, onBringIn);
    // load reads owner and repo only; a new listener per site is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo]);

  // A "Bring in" cut short by a reload carries on by itself.
  useEffect(() => {
    if (resumed.current || !copy || !canConvert || !claude.ready) return;
    const timer = setTimeout(() => {
      resumed.current = true;
      const waiting = new Set(copy.pages.filter((p) => !p.broughtIn).map((p) => p.id));
      const rest = readSavedQueue(owner, repo).filter((id) => waiting.has(id));
      if (rest.length) void bringIn(rest);
      else saveQueue(owner, repo, []);
    }, 0);
    return () => clearTimeout(timer);
    // bringIn is a new function on every render; this only runs once, when the copy first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy, canConvert, claude.ready, owner, repo]);

  async function improve(text: string) {
    if (!text.trim() || !copy) return;
    setOpen(true);
    const sent = await send(
      `I copied ${copy.url} into this site (${copy.pages.filter((p) => p.broughtIn).length} pages). ${text.trim()}`,
    );
    if (sent) setIdea("");
  }

  if (!loaded) return null;
  const formOpen = showForm || !copy;
  const allIn = Boolean(copy) && left.length === 0;
  const claudeBusy = turn?.status === "running";

  return (
    <section aria-label="Copy a website" className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">Copy a website</h3>
          <p className="mt-0.5 text-sm text-zinc-500">
            {copy
              ? `${copy.pages.length} ${copy.pages.length === 1 ? "page" : "pages"} copied from ${copy.host}, with ${copy.assets.files} pictures and fonts. ${left.length ? `${left.length} still need bringing in.` : "All of them are in your site."}`
              : "Give the address of a website and its pages come into your site looking the same, with their pictures, fonts and styles. Then the AI can improve them."}
          </p>
        </div>
        {copy && !formOpen && !running && (
          <Button variant="ghost" onClick={() => setShowForm(true)}>
            Copy another website
          </Button>
        )}
      </div>

      {formOpen && (
        <form onSubmit={(e) => void startCopy(e)} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[16rem] flex-1 text-sm">
              <span className="font-medium">Website address</span>
              <input
                type="text"
                inputMode="url"
                required
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={copying}
                className={`mt-1 ${inputClass}`}
              />
            </label>
            <label className="w-32 text-sm">
              <span className="font-medium">Pages, at most</span>
              <input
                type="number"
                min={1}
                max={limits.maxPages}
                value={maxPages}
                onChange={(e) => setMaxPages(Math.min(limits.maxPages, Math.max(1, Number(e.target.value) || 1)))}
                disabled={copying}
                className={`mt-1 ${inputClass}`}
              />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={permission} onChange={(e) => setPermission(e.target.checked)} disabled={copying} className="mt-0.5" />
            <span>This website is mine, or I have permission to copy its design, words and pictures.</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={copying || busy || !url.trim() || !permission}>
              {copying ? "Copying…" : "Copy it"}
            </Button>
            {copy && !copying && (
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            )}
            {copying && (
              <span role="status" className="flex items-center gap-2 text-sm text-zinc-500">
                <Spinner /> Opening its pages in a browser, about 15 seconds a page. You can watch the progress below.
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500">
            The start page goes first, then the pages its menus lead to on the same website. Sign-in, cart and account pages are left out.
          </p>
        </form>
      )}

      {copy && !formOpen && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {progress ? (
              <Button variant="ghost" disabled={stopping} onClick={() => { stopRef.current = true; setStopping(true); }} title="The page being brought in now finishes first.">
                {stopping ? "Stopping after this page…" : "Stop"}
              </Button>
            ) : (
              left.length > 0 &&
              canConvert && (
                <Button variant="primary" disabled={busy || !claude.ready} onClick={() => void bringIn(left.map((p) => p.id))}>
                  {`Bring in ${left.length === 1 ? "the page" : `all ${left.length}`}`}
                </Button>
              )
            )}
            {progress && (
              <span role="status" className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <Spinner />
                {retryPass
                  ? `Trying the pages that didn't work again in a moment (try ${retryPass} of ${MAX_PASSES})…`
                  : `Brought in ${progress.done} of ${progress.total}. You can go to other screens or reload: it carries on.`}
              </span>
            )}
          </div>

          {!canConvert && <Notice tone="warning">This site&apos;s tools are too old to bring pages in. Update the site tools on Edit site first.</Notice>}
          {canConvert && !claude.ready && left.length > 0 && (
            <Notice tone="warning">
              {claude.reason}{" "}
              <Link href={claude.setupHref} className="font-medium underline">
                {claude.setupLabel}
              </Link>
            </Notice>
          )}

          <ul className="max-h-[26rem] divide-y divide-zinc-200 overflow-y-auto rounded-md border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
            {copy.pages.map((page) => (
              <li key={page.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                {page.shots.includes("computer") ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a private API image, not a static asset
                  <img
                    src={workspacePath(owner, repo, `/copy-website/shots/${page.id}/computer`)}
                    alt=""
                    loading="lazy"
                    className="h-12 w-20 shrink-0 rounded border border-zinc-200 object-cover object-top dark:border-zinc-800"
                  />
                ) : (
                  <span className="h-12 w-20 shrink-0 rounded border border-zinc-200 dark:border-zinc-800" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{page.title ?? page.address}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {page.address}
                    {page.chromeSource ? " · gives the site its header and footer" : ""}
                    {page.replaces && !page.broughtIn ? " · replaces your page at this address" : ""}
                  </span>
                </span>
                {working === page.id ? (
                  <span className="flex items-center gap-2 text-zinc-500">
                    <Spinner /> Bringing it in (a minute or two)…
                  </span>
                ) : queue.includes(page.id) ? (
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
                    <Button disabled={busy || running || !claude.ready} onClick={() => void bringIn([page.id])}>
                      {failed[page.id] ? "Try again" : "Bring in"}
                    </Button>
                  )
                )}
                {failed[page.id] && working !== page.id && (
                  <p role="alert" className="basis-full whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">
                    Couldn&apos;t bring it in. {failed[page.id]}
                  </p>
                )}
              </li>
            ))}
          </ul>

          {copy.skipped.length > 0 && (
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer">
                {copy.skipped.length} {copy.skipped.length === 1 ? "page" : "pages"} couldn&apos;t be copied
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {copy.skipped.map((s) => (
                  <li key={s.url}>
                    {s.url}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {allIn && claude.ready && (
            <div className="space-y-2 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="text-sm font-medium">Improve it with the AI</p>
              <div className="flex flex-wrap gap-2">
                {IMPROVE_IDEAS.map((text) => (
                  <Button key={text} variant="ghost" disabled={claudeBusy || running} onClick={() => void improve(text)}>
                    {text.split(/[,(]/)[0]}
                  </Button>
                ))}
              </div>
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void improve(idea);
                }}
              >
                <input
                  type="text"
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="Or say how: a bolder hero, our own colours, shorter text…"
                  className={`min-w-[14rem] flex-1 ${inputClass}`}
                />
                <Button type="submit" disabled={!idea.trim() || claudeBusy || running}>
                  Ask the AI
                </Button>
              </form>
            </div>
          )}
        </>
      )}

      <ErrorText error={error} />
    </section>
  );
}
