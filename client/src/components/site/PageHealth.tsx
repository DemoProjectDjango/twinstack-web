"use client";

import { useEffect, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { toast } from "@/lib/toast";
import { api, workspacePath, type MissingPages, type ScannedPage, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText } from "./ui";

const quoted = (title: string) => `“${title}”`;

const keptKey = (owner: string, repo: string) => `twinstack:unlinked-kept:${owner}/${repo}`;
function readKept(owner: string, repo: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(keptKey(owner, repo)) ?? "[]");
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The last build's link scan (server/src/missing-pages.js): the pages nothing links to and the
 * pages that share an address, current only while nothing changed since. Reloaded after every
 * change, like the rest of the editor. `kept` are the unlinked pages the owner chose to keep.
 */
export function usePageHealth() {
  const { owner, repo, version } = useSite();
  const [scan, setScan] = useState<MissingPages | null>(null);
  const [kept, setKept] = useState<string[]>(() => readKept(owner, repo));

  useEffect(() => {
    let cancelled = false;
    api<MissingPages>(workspacePath(owner, repo, "/missing-pages"))
      .then((next) => !cancelled && setScan(next))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const report = scan?.fresh ? scan.report : null;
  const unlinked = (report?.unlinked ?? []).filter((p) => !kept.includes(p.file));
  const duplicates = report?.duplicates ?? [];

  function keep(file: string) {
    const next = [...new Set([...kept, file])];
    setKept(next);
    try {
      localStorage.setItem(keptKey(owner, repo), JSON.stringify(next.slice(-500)));
    } catch {
      // Private mode: kept for this visit only.
    }
  }

  return { unlinked, duplicates, keep };
}

/**
 * Above the page list: pages that share one address (only one of them shows on the site) and
 * pages nothing links to (visitors reach them only by typing the address or from a search
 * engine), each with what to do about it. Deleting can be undone on the Publish screen until
 * it's published.
 */
export function PageHealth({ health, onOpen }: { health: ReturnType<typeof usePageHealth>; onOpen: (file: string) => void }) {
  const { owner, repo, overview, busy, setStatus, refresh } = useSite();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { unlinked, duplicates, keep } = health;
  const canAddToMenu = overview?.features.pageMenus === true;
  const locked = busy || working !== null;

  if (!unlinked.length && !duplicates.length) return null;

  async function act(label: string, work: () => Promise<{ status: WorkspaceStatus }>, done: string) {
    setWorking(label);
    setError(null);
    try {
      const { status } = await work();
      setStatus(status);
      await refresh();
      toast.success(done);
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  async function remove(page: ScannedPage) {
    const ok = await confirmModal(
      `Delete ${quoted(page.title)} (${page.url})? You can still undo it on the Publish screen until you publish.`,
      { confirmLabel: "Delete page", danger: true },
    );
    if (!ok) return;
    await act(
      `delete:${page.file}`,
      () => api(`${workspacePath(owner, repo, "/pages/source")}?file=${encodeURIComponent(page.file)}`, { method: "DELETE" }),
      `${quoted(page.title)} deleted.`,
    );
  }

  const addToMenu = (page: ScannedPage) =>
    act(
      `menu:${page.file}`,
      () => api(workspacePath(owner, repo, "/navigation/page-menu"), { method: "PUT", body: { file: page.file, menu: "header" } }),
      `${quoted(page.title)} is now in the menu.`,
    );

  return (
    <div className="space-y-3">
      {duplicates.map((group) => (
        <div
          key={group.map((p) => p.file).join("|")}
          role="status"
          className="rounded-md border border-red-300 bg-red-50 p-4 text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
        >
          <p className="font-medium">
            {group.length} pages share the address <code className="font-mono">{group[0].url.replace(/\/?$/, "/")}</code>, so only one of them shows.
          </p>
          <p className="mt-1 text-sm opacity-80">Keep the one you want and delete the other, or give it its own address.</p>
          <ul className="mt-3 space-y-2">
            {group.map((page) => (
              <li key={page.file} className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-background p-3 text-sm text-foreground dark:border-red-900">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{page.title}</span>{" "}
                  <span className="font-mono text-xs text-zinc-500">{page.file}</span>
                </span>
                <Button className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => onOpen(page.file)}>
                  Open
                </Button>
                <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => void remove(page)}>
                  {working === `delete:${page.file}` ? "Deleting…" : "Delete"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {unlinked.length > 0 && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">
            {unlinked.length === 1 ? "1 page isn't" : `${unlinked.length} pages aren't`} linked from anywhere on your site.
          </p>
          <p className="mt-1 text-sm opacity-80">
            No menu, footer or other page leads to {unlinked.length === 1 ? "it" : "them"}, so visitors only find{" "}
            {unlinked.length === 1 ? "it" : "them"} by typing the address or through a search engine.{" "}
            {canAddToMenu ? "Add them to the menu, delete the ones you don't need, or keep them as they are." : "Delete the ones you don't need, or keep them as they are."}
          </p>
          <ul className="mt-3 space-y-2">
            {unlinked.map((page) => (
              <li key={page.file} className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-background p-3 text-sm text-foreground dark:border-amber-900">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{page.title}</span> <span className="font-mono text-xs text-zinc-500">{page.url}</span>
                </span>
                <Button className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => onOpen(page.file)}>
                  Open
                </Button>
                {canAddToMenu && (
                  <Button className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => void addToMenu(page)}>
                    {working === `menu:${page.file}` ? "Adding…" : "Add to menu"}
                  </Button>
                )}
                <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => void remove(page)}>
                  {working === `delete:${page.file}` ? "Deleting…" : "Delete"}
                </Button>
                <Button variant="ghost" className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => keep(page.file)}>
                  Keep
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error ? <ErrorText error={error} /> : null}
    </div>
  );
}
