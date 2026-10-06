"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { claudeAccess, type ClaudeAccess } from "@/lib/claude";
import { cantManage, type Repo } from "@/lib/repos";
import { CreateSite } from "./CreateSite";
import { GitHubIcon } from "./GitHubIcon";
import { Button, EmptyState, Notice, StepList, type Step } from "./site/ui";

type Sites =
  | { status: "loading" }
  | { status: "error"; reauth: boolean }
  | { status: "ready"; repos: Repo[] };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The signed-in home: the setup steps until the first site exists (connect GitHub, create the
 * site, optionally set up Claude), then the user's sites.
 */
export function Dashboard({ githubLogin }: { githubLogin: string | null }) {
  const [sites, setSites] = useState<Sites>(githubLogin ? { status: "loading" } : { status: "ready", repos: [] });
  const [claude, setClaude] = useState<ClaudeAccess | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : { anthropicKey: null }))
      .then((s: { anthropicKey: string | null }) => !cancelled && setClaude(claudeAccess(s)))
      .catch(() => !cancelled && setClaude(claudeAccess({ anthropicKey: null })));
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
      id: "site",
      title: "Create your site",
      text: !githubLogin
        ? "Your own copy of the TwinStack website, ready to make yours."
        : !loaded
          ? "Checking your GitHub account…"
          : template
            ? "Your own copy of the TwinStack website, ready to make yours."
            : `Your GitHub account (@${githubLogin}) can't see the TwinStack template yet. Ask its owner to give you access, then refresh this page.`,
      done: copies.length > 0,
      action: githubLogin && !creating ? createAction : null,
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
            Get started in {githubLogin ? "two more steps" : "three steps"}
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

      {githubLogin && loaded && copies.length === 0 && !template && (
        <EmptyState title="No sites yet">
          Once the TwinStack template is shared with @{githubLogin}, you can create your site here.
        </EmptyState>
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
