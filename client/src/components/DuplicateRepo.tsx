"use client";

import { useId, useState } from "react";
import type { Repo } from "./RepoList";

type Props = {
  repo: Repo;
  onDuplicated: (repo: Repo) => void;
};

type Status =
  | { state: "idle" }
  | { state: "working" }
  | { state: "error"; message: string; reauth?: boolean }
  | { state: "done"; repo: Repo };

export function DuplicateRepo({ repo, onDuplicated }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${repo.name}-copy`);
  const [isPrivate, setIsPrivate] = useState(true);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const nameId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ state: "working" });
    try {
      const res = await fetch(`/api/repos/${repo.owner}/${repo.name}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), private: isPrivate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reauth = data.error === "reauth_required";
        return setStatus({
          state: "error",
          reauth,
          message: reauth
            ? (data.message ?? "Your GitHub access has expired.")
            : (data.error ?? "Duplicating failed."),
        });
      }
      setStatus({ state: "done", repo: data.repo });
      onDuplicated(data.repo);
    } catch {
      setStatus({ state: "error", message: "Network error. The copy may still finish; refresh to check." });
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Duplicate
      </button>
    );
  }

  if (status.state === "done") {
    return (
      <p className="w-full text-sm text-green-700 dark:text-green-400">
        ✓ Copied to{" "}
        <a href={status.repo.htmlUrl} target="_blank" rel="noreferrer" className="font-medium underline">
          {status.repo.fullName}
        </a>
      </p>
    );
  }

  const working = status.state === "working";
  return (
    <form onSubmit={submit} className="mt-3 w-full rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
      <label htmlFor={nameId} className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
        New repository name
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={working}
          required
          pattern="[A-Za-z0-9._\-]{1,100}"
          title="Letters, numbers, '.', '-' or '_'"
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-background px-2.5 py-1.5 text-sm dark:border-zinc-700"
        />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} disabled={working} />
          Private
        </label>
      </div>

      {status.state === "error" && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {status.message}{" "}
          {status.reauth && (
            <a href="/auth/github" className="font-medium underline">
              Reconnect GitHub
            </a>
          )}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={working}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
        >
          {working ? "Cloning and pushing…" : "Create & push"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setStatus({ state: "idle" });
          }}
          disabled={working}
          className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
      {working && <p className="mt-2 text-xs text-zinc-500">Copying all branches, tags and history. Large repos can take a minute.</p>}
    </form>
  );
}
