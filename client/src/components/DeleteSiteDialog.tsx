"use client";

import { useEffect, useRef, useState } from "react";
import type { Repo } from "@/lib/repos";
import { inputClass } from "./site/ui";

// Set before sending the owner to GitHub for the `delete_repo` permission, so the dashboard
// reopens this dialog for the same site when they come back. Per tab; anything wrong is ignored.
const RESUME_KEY = "twinstack:delete-site";

/** The site (`owner/name`) whose deletion was waiting on GitHub's permission, read once. */
export function takeResumedDelete(): string | null {
  try {
    const fullName = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return fullName;
  } catch {
    return null;
  }
}

type Failure = { message: string; needsPermission: boolean };

/**
 * Asks before deleting a site (`DELETE /api/repos/:owner/:repo`). It always removes the site from
 * Twinstack; ticking the box also deletes the repository on GitHub, after typing the site's name
 * (`title`, as its card shows it).
 */
export function DeleteSiteDialog({
  repo,
  title,
  initialDeleteRepo = false,
  onDeleted,
  onClose,
}: {
  repo: Repo;
  title: string;
  initialDeleteRepo?: boolean;
  onDeleted: (repo: Repo) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [deleteRepo, setDeleteRepo] = useState(initialDeleteRepo);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // showModal() traps focus and dims the page; focus starts on Cancel so a stray Enter can't delete.
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    cancelButton.current?.focus();
  }, []);

  const confirmed = !deleteRepo || typed.trim().toLowerCase() === title.trim().toLowerCase();

  function close() {
    if (!busy) onClose();
  }

  async function remove() {
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteRepo }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return onDeleted(repo);
      if (data.error === "delete_permission_required") {
        return setFailure({ message: "GitHub asks you to allow this once. You'll come straight back here.", needsPermission: true });
      }
      if (data.error === "reauth_required") {
        return setFailure({ message: "Your GitHub connection has expired. Reconnect GitHub, then try again.", needsPermission: true });
      }
      setFailure({ message: data.error ?? "The site couldn't be deleted. Please try again.", needsPermission: false });
    } catch {
      setFailure({ message: "The site couldn't be deleted. Check your internet connection and try again.", needsPermission: false });
    } finally {
      setBusy(false);
    }
  }

  function allowOnGithub() {
    try {
      sessionStorage.setItem(RESUME_KEY, repo.fullName);
    } catch {
      // The dialog just won't reopen by itself.
    }
    // A full-page navigation to the Express OAuth route, which comes back to the dashboard.
    window.location.href = deleteRepo ? "/auth/github?allow=delete_repo" : "/auth/github";
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="delete-site-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800"
    >
      <form
        className="p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmed && !busy) void remove();
        }}
      >
        <h2 id="delete-site-title" className="text-lg font-semibold">
          Delete “{title}”?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          It disappears from your sites here, along with changes you haven&apos;t published, your Ask Claude chats and the
          site&apos;s visitor numbers. This can&apos;t be undone.
        </p>

        <label className="mt-4 flex gap-3 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <input
            type="checkbox"
            checked={deleteRepo}
            disabled={busy}
            onChange={(e) => {
              setDeleteRepo(e.target.checked);
              setFailure(null);
            }}
            className="mt-0.5 size-4 shrink-0 accent-red-600"
          />
          <span>
            <span className="font-medium">Also take it off the internet</span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              {deleteRepo ? (
                <>Your published site goes offline for good, and its files on GitHub ({repo.fullName}) are deleted too.</>
              ) : (
                <>Leave this off to keep your published site online as it is now. You won&apos;t be able to edit it here again.</>
              )}
            </span>
          </span>
        </label>

        {deleteRepo && (
          <label className="mt-4 block text-sm">
            Type <span className="font-bold">{title}</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} mt-1`}
            />
          </label>
        )}

        {failure && (
          <div role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {failure.message}
            {failure.needsPermission && (
              <button type="button" onClick={allowOnGithub} className="mt-2 block font-medium underline">
                {deleteRepo ? "Allow it on GitHub" : "Reconnect GitHub"}
              </button>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelButton}
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!confirmed || busy}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete site"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
