"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { claudeAccess } from "@/lib/claude";
import { useCredits } from "@/lib/credits";
import { cantManage, type Repo } from "@/lib/repos";
import type { Access } from "@/lib/session";
import { CreateSite } from "./CreateSite";
import { GitHubIcon } from "./GitHubIcon";
import { Button, EmptyState, Notice, StepList, type Step } from "./site/ui";

type Sites =
  | { status: "loading" }
  | { status: "error"; reauth: boolean }
  | { status: "ready"; repos: Repo[] };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The signed-in home: the setup steps until the first site exists (connect GitHub, get approved,
 * create the site, optionally set up Claude), then the user's sites.
 */
export function Dashboard({ githubLogin, email, access: initialAccess }: { githubLogin: string | null; email: string; access: Access }) {
  const [sites, setSites] = useState<Sites>(githubLogin ? { status: "loading" } : { status: "ready", repos: [] });
  const credits = useCredits();
  const claude = credits ? claudeAccess(credits) : null;
  const [creating, setCreating] = useState(false);
  const [access, setAccess] = useState(initialAccess);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
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
          if (!cancelled) setSites({ status: "ready", repos: data.repos });
        })
        .catch(() => !cancelled && setSites({ status: "error", reauth: false }));
    }
    return () => {
      cancelled = true;
    };
  }, [githubLogin]);

  const repos = sites.status === "ready" ? sites.repos : [];
  const template = repos.find((r) => r.role === "template") ?? null;
  const copies = repos.filter((r) => r.role === "copy");
  const loaded = sites.status === "ready";
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
          <Button variant={githubLogin ? "primary" : "secondary"} disabled={requesting} onClick={() => void requestAccess()}>
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

      {!setupDone && sites.status !== "error" && (
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
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="sites-heading" className="font-semibold">
              Your sites
            </h2>
            {template && !creating && (
              <Button className="ml-auto" onClick={() => setCreating(true)}>
                + Create another site
              </Button>
            )}
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {copies.map((repo) => (
              <SiteCard key={repo.id} repo={repo} login={githubLogin!} />
            ))}
          </ul>
        </section>
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

const STEP_WORDS = ["", "one more step", "two more steps", "three steps", "four steps"];

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
  if (access.status === "denied") return <>Sorry, your account can&apos;t create sites at the moment.</>;
  return <>We approve each new account by hand. Ask once, and we&apos;ll email you at {email} when you can start.</>;
}

function SiteCard({ repo, login }: { repo: Repo; login: string }) {
  const reason = cantManage(repo);
  return (
    <li className="flex flex-col rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="truncate font-medium">{repo.name}</p>
      <p className="mt-0.5 text-xs text-zinc-500">
        {repo.owner !== login && <>Shared by @{repo.owner} · </>}
        Last changed {dateFormat.format(new Date(repo.updatedAt))}
      </p>
      {repo.description && <p className="mt-2 line-clamp-2 text-sm text-zinc-500">{repo.description}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {reason ? (
          <p className="text-xs text-zinc-500">{reason}</p>
        ) : (
          <Link
            href={`/sites/${repo.owner}/${repo.name}`}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
          >
            Open editor
          </Link>
        )}
        <a href={repo.htmlUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs text-zinc-500 hover:underline">
          On GitHub ↗
        </a>
      </div>
    </li>
  );
}
