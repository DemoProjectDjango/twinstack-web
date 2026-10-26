"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { claudeAccess } from "@/lib/claude";
import { formatCredits, useCredits } from "@/lib/credits";
import { cantManage, type Repo } from "@/lib/repos";
import type { Access } from "@/lib/session";
import { CreateSite } from "./CreateSite";
import { DeleteSiteDialog, takeResumedDelete } from "./DeleteSiteDialog";
import { GitHubIcon } from "./GitHubIcon";
import { Button, EmptyState, Notice, StepList, type Step } from "./site/ui";

type Sites =
  | { status: "loading" }
  | { status: "error"; reauth: boolean }
  | { status: "ready"; repos: Repo[] };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

// The last site list per GitHub login, so a returning user sees their sites at once instead of
// the setup steps while GitHub answers. A per-browser convenience: anything wrong with it is ignored.
const cacheKey = (login: string) => `twinstack:sites:${login}`;
const noSubscription = () => () => {};

function readCache(login: string | null): string | null {
  if (!login) return null;
  try {
    return localStorage.getItem(cacheKey(login));
  } catch {
    return null;
  }
}

function parseCache(raw: string | null): Repo[] | null {
  try {
    const repos = JSON.parse(raw ?? "null");
    return Array.isArray(repos) ? repos : null;
  } catch {
    return null;
  }
}

function writeCache(login: string, repos: Repo[]) {
  try {
    localStorage.setItem(cacheKey(login), JSON.stringify(repos));
  } catch {
    // Storage full or blocked: the list just loads from GitHub next time.
  }
}

/**
 * The signed-in home: the setup steps until the first site exists (connect GitHub, get approved,
 * create the site, optionally set up Claude), then the user's sites.
 */
export function Dashboard({ githubLogin, email, access: initialAccess }: { githubLogin: string | null; email: string; access: Access }) {
  const [sites, setSites] = useState<Sites>(githubLogin ? { status: "loading" } : { status: "ready", repos: [] });
  // Read after hydration (the server has no list), shown until GitHub answers, and kept if it fails.
  const cachedRaw = useSyncExternalStore(noSubscription, () => readCache(githubLogin), () => null);
  const cached = useMemo(() => parseCache(cachedRaw), [cachedRaw]);
  const credits = useCredits();
  const claude = credits ? claudeAccess(credits) : null;
  const [creating, setCreating] = useState(false);
  const [access, setAccess] = useState(initialAccess);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ repo: Repo; title: string; deleteRepo: boolean } | null>(null);
  const approved = access.status === "approved";

  useEffect(() => {
    let cancelled = false;
    if (githubLogin) {
      // Fetched from the browser so the page renders while GitHub responds.
      fetch("/api/repos")
        .then(async (res) => {
          if (cancelled) return;
          if (!res.ok) return setSites({ status: "error", reauth: res.status === 401 });
          const data = (await res.json()) as { repos: Repo[] };
          if (cancelled) return;
          setSites({ status: "ready", repos: data.repos });
          // Back from allowing repository deletion on GitHub: ask again for the same site.
          const resumed = takeResumedDelete();
          const repo = data.repos.find((r) => r.role === "copy" && r.createdByYou && r.fullName === resumed);
          if (repo) setDeleting({ repo, title: nameFromRepo(repo.name), deleteRepo: true });
        })
        .catch(() => !cancelled && setSites({ status: "error", reauth: false }));
    }
    return () => {
      cancelled = true;
    };
  }, [githubLogin]);

  // Saves every list GitHub gives, including one with a site just created.
  useEffect(() => {
    if (githubLogin && sites.status === "ready") writeCache(githubLogin, sites.repos);
  }, [githubLogin, sites]);

  const repos = sites.status === "ready" ? sites.repos : (cached ?? []);
  const template = repos.find((r) => r.role === "template") ?? null;
  const copies = repos.filter((r) => r.role === "copy");
  const loaded = sites.status === "ready" || Boolean(cached);
  const setupDone = Boolean(githubLogin) && loaded && copies.length > 0;

  async function requestAccess() {
    setRequesting(true);
    setRequestError(null);
    try {
      const res = await fetch("/api/access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setRequestError(data.error ?? "Your request couldn't be sent. Please try again.");
      setAccess(data.access);
    } catch {
      setRequestError("Your request couldn't be sent. Check your internet connection and try again.");
    } finally {
      setRequesting(false);
    }
  }

  function added(repo: Repo) {
    setSites((s) => (s.status === "ready" ? { ...s, repos: [repo, ...s.repos] } : s));
  }

  function deleted(repo: Repo) {
    setDeleting(null);
    try {
      localStorage.removeItem(summaryKey(repo.id));
    } catch {
      // Nothing to tidy.
    }
    setSites((s) => (s.status === "ready" ? { ...s, repos: s.repos.filter((r) => r.id !== repo.id) } : s));
  }

  const createAction = template ? (
    <Button variant="primary" onClick={() => setCreating(true)}>
      Create my site
    </Button>
  ) : null;

  const steps: Step[] = [
    {
      id: "github",
      title: "Connect GitHub",
      text: (
        <>
          GitHub is a free service that stores your site and puts it on the web. No account yet? You can create one on the
          next screen.
          {credits?.freePending && (
            <span className="mt-1 block font-medium text-sky-700 dark:text-sky-300">
              Connecting it also gives you {formatCredits(credits.freeCredits)} free Claude credits.
            </span>
          )}
        </>
      ),
      done: Boolean(githubLogin),
      action: (
        // Plain <a>: a full-page navigation to the Express OAuth route.
        <a
          href="/auth/github"
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
        >
          <GitHubIcon className="size-4" />
          Connect GitHub
        </a>
      ),
    },
    {
      id: "access",
      title: "Get approved",
      text: <AccessText access={access} email={email} error={requestError} />,
      done: approved,
      action:
        access.status === "none" ? (
          <Button className="cursor-pointer" variant={githubLogin ? "primary" : "secondary"} disabled={requesting} onClick={() => void requestAccess()}>
            {requesting ? "Sending…" : "Request access"}
          </Button>
        ) : null,
    },
    {
      id: "site",
      title: "Create your site",
      text: !approved
        ? "Once you're approved, one click makes your own copy of the TwinStack website, ready to make yours."
        : !githubLogin || template
          ? "Your own copy of the TwinStack website, ready to make yours."
          : !loaded
            ? "Checking your GitHub account…"
            : "Creating sites isn't available right now. Please try again later.",
      done: copies.length > 0,
      action: githubLogin && approved && !creating ? createAction : null,
    },
    {
      id: "claude",
      title: "Set up Claude",
      optional: true,
      text: "Claude can write and improve your pages for you. You can also write everything yourself.",
      done: Boolean(claude?.ready),
      action: claude ? (
        <Link href={claude.setupHref} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          {claude.setupLabel}
        </Link>
      ) : null,
    },
  ];

  return (
    <div className="space-y-8">
      {sites.status === "error" &&
        (sites.reauth ? (
          <Notice tone="warning">
            Your GitHub connection has expired or needs a new permission.{" "}
            <a href="/auth/github" className="font-medium underline">
              Reconnect GitHub
            </a>
          </Notice>
        ) : (
          <Notice tone="warning">Your sites couldn&apos;t be loaded from GitHub. Refresh the page to try again.</Notice>
        ))}

      {sites.status === "loading" && !cached && <SitesLoading />}

      {!setupDone && loaded && sites.status !== "error" && (
        <section aria-labelledby="setup-heading" className="space-y-3">
          <h2 id="setup-heading" className="font-semibold">
            Get started in {stepsLeft(steps)}
          </h2>
          <StepList steps={steps} />
        </section>
      )}

      {creating && template && githubLogin && (
        <CreateSite template={template} login={githubLogin} onCreated={added} onCancel={() => setCreating(false)} />
      )}

      {setupDone && (
        <section aria-labelledby="sites-heading" className="space-y-3">
          <h2 id="sites-heading" className="font-semibold">
            Your sites
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {copies.map((repo) => (
              <SiteCard
                key={repo.id}
                repo={repo}
                login={githubLogin!}
                // Not while the list is the cached one: the delete must act on what GitHub says now.
                onDelete={sites.status === "ready" && repo.createdByYou ? (title) => setDeleting({ repo, title, deleteRepo: false }) : null}
              />
            ))}
            {/* There's no limit on sites: the card makes another, or says why it can't yet. */}
            {approved && template && !creating && (
              <li>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex h-full min-h-32 w-full flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center hover:border-foreground hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  <span className="font-medium">+ Create a new site</span>
                  <span className="mt-1 text-xs text-zinc-500">Start another website from the same ready-made design.</span>
                </button>
              </li>
            )}
            {!approved && (
              <li className="flex flex-col justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-sm dark:border-zinc-700">
                <p className="font-medium">Create a new site</p>
                <p className="mt-1 text-xs text-zinc-500">
                  <AccessText access={access} email={email} error={requestError} />
                </p>
                {access.status === "none" && (
                  <div className="mt-3">
                    <Button className="cursor-pointer" variant="primary" disabled={requesting} onClick={() => void requestAccess()}>
                      {requesting ? "Sending…" : "Request access"}
                    </Button>
                  </div>
                )}
              </li>
            )}
          </ul>
        </section>
      )}

      {deleting && (
        <DeleteSiteDialog
          repo={deleting.repo}
          title={deleting.title}
          initialDeleteRepo={deleting.deleteRepo}
          onDeleted={deleted}
          onClose={() => setDeleting(null)}
        />
      )}

      {githubLogin && loaded && copies.length === 0 && !template && approved && (
        <EmptyState title="No sites yet">Creating sites isn&apos;t available right now. Please try again later.</EmptyState>
      )}

      {setupDone && claude && !claude.ready && (
        <Notice>
          <span className="font-medium">Want Claude to write for you?</span> It can draft pages from your notes and improve what
          you&apos;ve written.{" "}
          <Link href={claude.setupHref} className="ml-1 underline">
            {claude.setupLabel}
          </Link>
        </Notice>
      )}
    </div>
  );
}

/** Placeholder cards while the site list loads, so neither the setup steps nor the sites flash up first. */
function SitesLoading() {
  return (
    <section aria-busy="true" aria-labelledby="sites-loading-heading" className="space-y-3">
      <h2 id="sites-loading-heading" className="font-semibold">
        Loading your sites…
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
        {[0, 1].map((i) => (
          <li key={i} className="flex flex-col rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <span className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <span className="mt-2 h-3 w-40 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
            <span className="mt-5 h-8 w-24 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEP_WORDS =["", "one more step", "two more steps", "three steps", "four steps"];

/** "two more steps": how many required steps are left. */
function stepsLeft(steps: Step[]) {
  const left = steps.filter((s) => !s.optional && !s.done).length;
  return STEP_WORDS[left] ?? `${left} steps`;
}

/** Where the account's request stands, in plain words. */
function AccessText({ access, email, error }: { access: Access; email: string; error: string | null }) {
  if (error) return <span className="text-red-600 dark:text-red-400">{error}</span>;
  if (access.status === "pending") {
    const sent = access.requestedAt ? ` on ${dateFormat.format(new Date(access.requestedAt))}` : "";
    return (
      <>
        Request sent{sent}. We&apos;ll email you at <span className="font-medium">{email}</span> as soon as you&apos;re approved.
        You can connect GitHub in the meantime.
      </>
    );
  }
  if (access.status === "denied") return <>Sorry, your account can&apos;t create new sites at the moment.</>;
  return <>We approve each new account by hand. Ask once, and we&apos;ll email you at {email} when you can start.</>;
}

type Summary = { name: string | null; status: "live" | "publishing" | "failed" | "unpublished"; url: string | null };

const STATUS: Record<Summary["status"], { label: string; dot: string }> = {
  live: { label: "Live", dot: "bg-emerald-500" },
  publishing: { label: "Publishing…", dot: "bg-amber-500 animate-pulse" },
  failed: { label: "Last publish didn't work", dot: "bg-red-500" },
  unpublished: { label: "Not published yet", dot: "bg-zinc-400" },
};

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "today", "yesterday", "6 days ago", then the date. */
function editedWhen(iso: string) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  return days >= 0 && days < 14 ? relativeTime.format(-days, "day") : `on ${dateFormat.format(new Date(iso))}`;
}

// Each card's last summary, so a reload shows the site's name and status at once instead of a
// guess while GitHub answers. A per-browser convenience like the site list's cache.
const summaryKey = (repoId: number) => `twinstack:site-summary:${repoId}`;

function readSummary(repoId: number): Summary | null {
  try {
    const summary = JSON.parse(localStorage.getItem(summaryKey(repoId)) ?? "null");
    return summary && typeof summary.status === "string" && summary.status in STATUS ? summary : null;
  } catch {
    return null;
  }
}

function writeSummary(repoId: number, summary: Summary) {
  try {
    localStorage.setItem(summaryKey(repoId), JSON.stringify(summary));
  } catch {
    // Storage full or blocked: the card just waits for GitHub next time.
  }
}

/** "new-site110" → "New site110", when the site has no name of its own (or GitHub didn't say). */
const nameFromRepo = (name: string) => name.replace(/[-_.]+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()) || name;

/** "https://ibnul.github.io/bakery/" → "ibnul.github.io/bakery" */
const shortAddress = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function SiteCard({ repo, login, onDelete }: { repo: Repo; login: string; onDelete: ((title: string) => void) | null }) {
  const reason = cantManage(repo);
  // Its name and whether it's live, from GitHub after the list (null while asking, false if it couldn't).
  // Cards only render in the browser (after the list loads), so reading storage here can't break hydration.
  const [summary, setSummary] = useState<Summary | null | false>(() => readSummary(repo.id));

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/summary`)
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as Summary) : null;
        if (data) writeSummary(repo.id, data);
        // On failure keep what the cache showed, if anything.
        if (!cancelled) setSummary((shown) => data ?? shown ?? false);
      })
      .catch(() => !cancelled && setSummary((shown) => shown ?? false));
    return () => {
      cancelled = true;
    };
  }, [repo.id, repo.owner, repo.name]);

  const loading = summary === null;
  const title = (summary && summary.name) || nameFromRepo(repo.name);
  const liveUrl = summary && summary.status !== "unpublished" ? summary.url : null;
  const status = summary ? STATUS[summary.status] : null;

  return (
    <li className="flex flex-col rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start gap-2">
        {loading ? (
          <span className="mt-1 block h-5 flex-1" aria-label="Loading site">
            <span className="block h-4 w-40 max-w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          </span>
        ) : (
          <h3 className="min-w-0 flex-1 truncate font-medium" title={title}>
            {title}
          </h3>
        )}
        <SiteMenu name={title} liveUrl={liveUrl} filesUrl={repo.htmlUrl} onDelete={onDelete && (() => onDelete(title))} />
      </div>

      <div className="mt-1 min-h-5 text-sm">
        {loading ? (
          <span className="block h-3 w-36 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" aria-hidden="true" />
        ) : status ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${status.dot}`} aria-hidden="true" />
            <span className="shrink-0">{status.label}</span>
            {liveUrl && (
              <a href={liveUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-zinc-500 hover:text-foreground hover:underline">
                {shortAddress(liveUrl)}
              </a>
            )}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-zinc-500">
        {repo.owner !== login && <>Shared with you by {repo.owner} · </>}
        Edited {editedWhen(repo.updatedAt)}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {reason ? (
          <p className="text-xs text-zinc-500">{reason}</p>
        ) : (
          <Link
            href={`/sites/${repo.owner}/${repo.name}`}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
          >
            Edit site
          </Link>
        )}
        {liveUrl && (
          <a
            href={liveUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            View site ↗
          </a>
        )}
      </div>
    </li>
  );
}

const menuItem = "flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900";

/**
 * The ⋮ button at the top right of a site card and its menu: view the live site, its files on
 * GitHub, and (for its creator) delete it. Escape or a click elsewhere closes it.
 */
function SiteMenu({
  name,
  liveUrl,
  filesUrl,
  onDelete,
}: {
  name: string;
  liveUrl: string | null;
  filesUrl: string;
  onDelete: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // Up and down move between the items, wrapping round.
        const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        event.preventDefault();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative -mr-2 -mt-1">
      <button
        ref={button}
        type="button"
        aria-label={`More options for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-900"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={`${name} options`}
          className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-zinc-200 bg-background p-1 shadow-lg dark:border-zinc-800"
        >
          {liveUrl && (
            <a href={liveUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setOpen(false)} className={menuItem}>
              View your live site ↗
            </a>
          )}
          <a href={filesUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setOpen(false)} className={`${menuItem} flex-col items-start`}>
            <span>See its files on GitHub ↗</span>
            <span className="text-xs text-zinc-500">Advanced: where your site is stored</span>
          </a>
          {onDelete && (
            <>
              <div role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onDelete();
                }}
                className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                Delete site…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
