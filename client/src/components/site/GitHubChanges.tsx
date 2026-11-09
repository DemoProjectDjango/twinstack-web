"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api, workspacePath, type IncomingChanges, type WorkspaceStatus } from "@/lib/site-api";
import { Button, ErrorText, Notice } from "./ui";

const when = (date: string) => new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const STATUS_WORD = { added: "Added", removed: "Removed", changed: "Changed" };
const dismissedKey = (owner: string, repo: string) => `twinstack-github-dismissed:${owner}/${repo}`;

/** Whether the owner already said "Not now" to exactly these changes. */
export function wasDismissed(owner: string, repo: string, sha: string) {
  try {
    return localStorage.getItem(dismissedKey(owner, repo)) === sha;
  } catch {
    return false;
  }
}

function dismiss(owner: string, repo: string, sha: string) {
  try {
    localStorage.setItem(dismissedKey(owner, repo), sha);
  } catch {
    // Then it asks again next time.
  }
}

/** Shows what changed on GitHub outside the editor, and lets the owner bring it in now or later. */
export function GitHubChangesModal({
  owner,
  repo,
  incoming,
  onAccepted,
  onClose,
}: {
  owner: string;
  repo: string;
  incoming: IncomingChanges;
  onAccepted: (result: { status: WorkspaceStatus; kept: string[] }) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  function notNow() {
    if (working) return;
    dismiss(owner, repo, incoming.sha);
    onClose();
  }

  async function accept() {
    setWorking(true);
    setError(null);
    try {
      onAccepted(await api<{ status: WorkspaceStatus; kept: string[] }>(workspacePath(owner, repo, "/incoming/accept"), { method: "POST", body: { sha: incoming.sha } }));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err : new Error("The changes couldn't be brought in."));
      setWorking(false);
    }
  }

  const fileCount = incoming.files.length + incoming.moreFiles;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="github-changes-title"
      onCancel={(e) => {
        e.preventDefault();
        notNow();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-lg border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800"
    >
      <div className="space-y-4 p-6">
        <div>
          <h2 id="github-changes-title" className="text-lg font-semibold">
            Your site was changed outside the editor
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">These changes are on GitHub and already on your live site. The editor doesn&apos;t have them yet.</p>
        </div>

        <section>
          <h3 className="text-sm font-medium">What was done</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {incoming.commits.map((commit) => (
              <li key={commit.sha} className="break-words">
                {commit.subject}
                <span className="block text-xs text-zinc-500">
                  {commit.author}, {when(commit.date)}
                </span>
              </li>
            ))}
          </ul>
          {incoming.moreCommits > 0 && <p className="mt-1 text-xs text-zinc-500">And {incoming.moreCommits} more.</p>}
        </section>

        <section>
          <h3 className="text-sm font-medium">
            {fileCount} file{fileCount === 1 ? "" : "s"} changed
          </h3>
          <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto text-xs">
            {incoming.files.map((file) => (
              <li key={file.path} className="flex flex-wrap gap-x-2">
                <span className="text-zinc-500">
                  {STATUS_WORD[file.status]} · {file.kind}
                </span>
                <span className="min-w-0 break-all">{file.path}</span>
              </li>
            ))}
          </ul>
          {incoming.moreFiles > 0 && <p className="mt-1 text-xs text-zinc-500">And {incoming.moreFiles} more.</p>}
        </section>

        {incoming.overlap.length > 0 && (
          <Notice tone="warning">
            You also have unpublished changes to {incoming.overlap.join(", ")}. They&apos;ll be combined with these. If both changed the same lines, your unpublished version stays.
          </Notice>
        )}
        {incoming.needsPublish && <Notice tone="warning">You have saved work that hasn&apos;t reached GitHub yet. Publish it first, and these changes will be brought in with it.</Notice>}
        <ErrorText error={error} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={working} onClick={notNow}>
            Not now
          </Button>
          <Button variant="primary" disabled={working || incoming.needsPublish} onClick={() => void accept()}>
            {working ? "Getting them…" : "Get these changes"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
