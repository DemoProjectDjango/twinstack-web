"use client";

import { useEffect, useRef, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { toast } from "@/lib/toast";
import { api, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Section } from "./ui";

type Version = { sha: string; date: string; author: string; kind: "publish" | "update"; title: string; note: string | null; live: boolean };

// Set by a link elsewhere (More tools' "Earlier versions"): the next PreviousVersions to mount opens
// its list and scrolls to it. What's changed mounts afresh each time it's shown.
let openOnMount = false;

/** Shows What's changed with the earlier versions open and in view. */
export function showEarlierVersions(showSection: (section: "publish") => void) {
  openOnMount = true;
  showSection("publish");
}

function when(date: string) {
  return new Date(date).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The live version and the last few published before it. Restoring one puts its pages, pictures and
 * settings back as unpublished changes, so the owner sees them here and publishes them as usual.
 */
export function PreviousVersions() {
  const { owner, repo, status, busy, setStatus, refresh, version } = useSite();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [max, setMax] = useState(5);
  const [error, setError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [open, setOpen] = useState(() => openOnMount);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openOnMount) return;
    openOnMount = false;
    // After the screen has laid out.
    requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ versions: Version[]; max: number }>(workspacePath(owner, repo, "/versions"))
      .then((r) => {
        if (cancelled) return;
        setError(null);
        setVersions(r.versions);
        setMax(r.max);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version, open]);

  async function restore(v: Version) {
    const ok = await confirmModal(
      `Your site's pages, pictures and settings go back to how they were on ${when(v.date)}. Nothing changes on your live site until you publish, and you can restore today's version again later.`,
      { title: "Restore this version?", confirmLabel: "Restore" },
    );
    if (!ok) return;
    setRestoring(v.sha);
    setError(null);
    try {
      const result = await api<{ changed: number; status: WorkspaceStatus }>(workspacePath(owner, repo, "/versions/restore"), { method: "POST", body: { sha: v.sha } });
      setStatus(result.status);
      await refresh();
      toast.success(result.changed ? "Version restored. Check the changes above, then publish to put it live." : "That version is the same as your live site.");
    } catch (err) {
      setError(err);
    } finally {
      setRestoring(null);
    }
  }

  const hasChanges = status.changes.length > 0;
  const earlier = versions?.filter((v) => !v.live) ?? [];
  const live = versions?.find((v) => v.live);

  return (
    <div ref={ref} id="earlier-versions" className="scroll-mt-4">
    <Section title="Earlier versions" description={`Go back to one of the last ${max} versions you published. It comes back as changes you can check, then publish.`}>
      {!open ? (
        <Button onClick={() => setOpen(true)}>Show earlier versions</Button>
      ) : (
        <div className="space-y-3">
          {error != null && <ErrorText error={error} />}
          {!status.onDefaultBranch && <p className="text-sm text-zinc-500">You&apos;re working on a review copy. Go back to your live site to restore a version.</p>}
          {hasChanges && <p className="text-sm text-amber-700 dark:text-amber-400">Publish or undo your current changes first, then you can restore a version.</p>}
          {versions === null && error == null && <p className="text-sm text-zinc-500">Loading…</p>}
          {live && (
            <p className="text-sm text-zinc-500">
              Live now: <span className="text-zinc-800 dark:text-zinc-200">{live.title}</span>, {when(live.date)}
            </p>
          )}
          {versions !== null && earlier.length === 0 && <p className="text-sm text-zinc-500">There are no earlier versions yet.</p>}
          {earlier.length > 0 && (
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {earlier.map((v) => (
                <li key={v.sha} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{v.title}</span>
                      {v.kind === "update" && <Badge>Site update</Badge>}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {when(v.date)}
                      {v.note ? ` · ${v.note.split("\n")[0]}` : ""}
                    </p>
                  </div>
                  <Button disabled={busy || hasChanges || !status.onDefaultBranch || restoring !== null} onClick={() => void restore(v)}>
                    {restoring === v.sha ? "Restoring…" : "Restore this version"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-zinc-500">Restoring keeps your site&apos;s tools as they are, and doesn&apos;t touch visitor numbers or messages.</p>
        </div>
      )}
    </Section>
    </div>
  );
}
