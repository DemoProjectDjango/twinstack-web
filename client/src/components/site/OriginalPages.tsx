"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { api, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
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

  if (!pages?.length) return null;
  const left = pages.filter((p) => !p.broughtIn);
  const oldSiteLive = publishing.publishing ? publishing.publishing.enabled && !publishing.publishing.usesActions : false;
  const canConvert = Boolean(overview?.features.pageConvert && overview.features.pageConvertStyles);

  // One page failing doesn't stop the others: its reason stays on its row. The page the site's
  // header and footer come from goes first: the others are compared with what it gives the site.
  async function bringIn(chosen: string[]) {
    const source = pages?.find((p) => p.chromeSource && !p.broughtIn);
    const files = source && !chosen.includes(source.file) ? [source.file, ...chosen] : chosen;
    setError(null);
    setFailed((now) => Object.fromEntries(Object.entries(now).filter(([file]) => !files.includes(file))));
    for (const [index, file] of files.entries()) {
      setWorking(file);
      setQueue(files.slice(index + 1));
      try {
        const prepared = await api<Prepared>(workspacePath(owner, repo, "/original-pages/prepare"), { method: "POST", body: { file } });
        setStatus(prepared.status);
        // The header and footer most pages share become the site's (older servers: the homepage's).
        // A page with different ones keeps its own, so every page looks as it did.
        const chrome = (prepared.chromeSource ?? prepared.address === "/") && overview?.features.pageConvertChrome;
        const job = await runAndWait("page-convert", {
          page: prepared.page,
          source: prepared.source,
          keepStyles: true,
          css: prepared.css,
          js: prepared.js,
          ...(chrome ? { withHeader: true, withFooter: true } : {}),
          dryRun: false,
        });
        if (job.status !== "succeeded") throw new Error(reasonOf(job.output));
      } catch (err) {
        setFailed((now) => ({ ...now, [file]: err instanceof Error ? err.message : String(err) }));
      }
    }
    setWorking(null);
    setQueue([]);
    await refresh();
  }

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
        {left.length > 0 && canConvert && (
          <Button variant="primary" disabled={busy || Boolean(working) || !claude.ready} onClick={() => void bringIn(left.map((p) => p.file))}>
            {working ? "Bringing them in…" : `Bring in ${left.length === 1 ? "the page" : `all ${left.length}`}`}
          </Button>
        )}
      </div>

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

      <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {pages.map((page) => (
          <li key={page.file} className="flex flex-wrap items-center gap-2 px-3 py-2">
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
                <Button disabled={busy || Boolean(working) || !claude.ready} onClick={() => void bringIn([page.file])}>
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
          <Button variant={left.length ? "ghost" : "primary"} className="ml-1" disabled={busy || switching || Boolean(working)} onClick={() => void switchLive()}>
            {switching ? "Switching…" : "Switch your live site"}
          </Button>
        </Notice>
      )}
    </section>
  );
}
