"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DuplicateRepo } from "./DuplicateRepo";

export type Repo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  stars: number;
  updatedAt: string;
  permission: "admin" | "write" | "read";
  /** The API only returns the site template and copies of it. */
  role: "template" | "copy";
};

type Filter = "all" | "private" | "public";

type State =
  | { status: "loading" }
  | { status: "error"; reauth: boolean }
  | { status: "ready"; repos: Repo[] };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function RepoList() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    // Fetched from the browser (not a server component) so that a refreshed
    // session cookie set by the API actually reaches the browser.
    fetch("/api/repos")
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setState({ status: "error", reauth: res.status === 401 });
        const data = (await res.json()) as { repos: Repo[] };
        if (!cancelled) setState({ status: "ready", repos: data.repos });
      })
      .catch(() => !cancelled && setState({ status: "error", reauth: false }));
    return () => {
      cancelled = true;
    };
  }, []);

  function addRepo(repo: Repo) {
    setState((s) => (s.status === "ready" ? { ...s, repos: [repo, ...s.repos] } : s));
  }

  const repos = useMemo(() => (state.status === "ready" ? state.repos : []), [state]);
  const counts = useMemo(
    () => ({
      all: repos.length,
      private: repos.filter((r) => r.private).length,
      public: repos.filter((r) => !r.private).length,
    }),
    [repos],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter(
      (r) =>
        (filter === "all" || (filter === "private") === r.private) &&
        (!q || r.fullName.toLowerCase().includes(q)),
    );
  }, [repos, filter, query]);

  return (
    <section id="repositories" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Site repositories</h2>
          <p className="text-sm text-zinc-500">The TwinStack site template and your copies of it.</p>
        </div>
        <div className="flex rounded-md border border-zinc-300 p-0.5 text-sm dark:border-zinc-700">
          {(["private", "public", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`rounded px-3 py-1 capitalize ${
                filter === f ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
            >
              {f}
              {state.status === "ready" && <span className="ml-1 opacity-60">{counts[f]}</span>}
            </button>
          ))}
        </div>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by name…"
        aria-label="Filter repositories by name"
        className="mt-4 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
      />

      <div className="mt-4">
        {state.status === "loading" && <p className="text-sm text-zinc-500">Loading repositories…</p>}

        {state.status === "error" &&
          (state.reauth ? (
            <p className="text-sm">
              Your GitHub access has expired or needs new permissions.{" "}
              <a href="/auth/github" className="font-medium underline">
                Sign in again
              </a>
            </p>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">Couldn&apos;t load repositories from GitHub.</p>
          ))}

        {state.status === "ready" && visible.length === 0 && (
          <p className="text-sm text-zinc-500">
            {query
              ? "No repositories match that filter."
              : filter === "all"
                ? "You don't have access to the TwinStack site template or any copies of it. Ask its owner to add you."
                : `No ${filter} site repositories.`}
          </p>
        )}

        {visible.length > 0 && (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {visible.map((repo) => (
              <li key={repo.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={repo.htmlUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {repo.fullName}
                  </a>
                  <Badge>{repo.private ? "Private" : "Public"}</Badge>
                  {repo.fork && <Badge>Fork</Badge>}
                  {repo.archived && <Badge>Archived</Badge>}
                  {repo.role === "template" && <Badge>Template</Badge>}
                  <div className="ml-auto flex items-center gap-2 has-[form]:ml-0 has-[form]:basis-full has-[p]:ml-0 has-[p]:basis-full">
                    <ManageSite repo={repo} />
                    {repo.role === "template" && <DuplicateRepo repo={repo} onDuplicated={addRepo} />}
                  </div>
                </div>
                {repo.description && <p className="mt-1 text-sm text-zinc-500">{repo.description}</p>}
                <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                  {repo.language && <span>{repo.language}</span>}
                  <span>★ {repo.stars}</span>
                  <span className="capitalize">{repo.permission} access</span>
                  <span>Updated {dateFormat.format(new Date(repo.updatedAt))}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const actionClass = "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium dark:border-zinc-700";

/** Copies are managed here; the template never is (changes belong in a copy). */
function ManageSite({ repo }: { repo: Repo }) {
  const reason =
    repo.role === "template"
      ? "This is the site template. Duplicate it, then manage your copy."
      : repo.permission === "read"
        ? "You need write access to manage this site."
        : repo.archived
          ? "Archived repositories can't be changed."
          : null;

  if (reason) {
    return (
      <button type="button" disabled title={reason} aria-label={`Manage site (unavailable: ${reason})`} className={`${actionClass} cursor-not-allowed opacity-50`}>
        Manage site
      </button>
    );
  }
  return (
    <Link href={`/sites/${repo.owner}/${repo.name}`} className={`${actionClass} hover:bg-zinc-100 dark:hover:bg-zinc-900`}>
      Manage site
    </Link>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </span>
  );
}
