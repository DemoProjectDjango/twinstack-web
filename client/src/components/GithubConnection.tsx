"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GithubAccount } from "@/lib/session";
import { GitHubIcon } from "./GitHubIcon";

const ERRORS: Record<string, string> = {
  access_denied: "You cancelled on GitHub, so nothing was connected.",
  invalid_state: "The GitHub connection timed out. Try again.",
  github_in_use: "That GitHub account is already connected to another Twinstack account.",
};

/** Connect or disconnect the GitHub account the site features act as. */
export function GithubConnection({ github, error, justConnected }: { github: GithubAccount | null; error?: string; justConnected: boolean }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  async function disconnect() {
    if (!confirm("Disconnect GitHub? You can connect it again at any time.")) return;
    setWorking(true);
    setFailed(false);
    const res = await fetch("/auth/github/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => null);
    setWorking(false);
    if (res?.ok) router.refresh();
    else setFailed(true);
  }

  return (
    <section id="github" className="mt-6 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">GitHub</h2>

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {ERRORS[error] ?? "Connecting GitHub failed. Try again."}
        </p>
      )}
      {justConnected && github && (
        <p className="mt-3 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-800 dark:text-green-300">
          GitHub connected as @{github.login}.
        </p>
      )}

      {github ? (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={github.avatarUrl} alt="" width={48} height={48} className="size-12 rounded-full" />
          <div className="min-w-0">
            <p className="truncate font-medium">{github.name ?? github.login}</p>
            <a href={github.profileUrl} target="_blank" rel="noreferrer" className="text-sm text-zinc-500 hover:underline">
              @{github.login}
            </a>
          </div>
          <button
            type="button"
            onClick={disconnect}
            disabled={working}
            className="ml-auto rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {working ? "Disconnecting…" : "Disconnect"}
          </button>
          {failed && <p className="basis-full text-sm text-red-600 dark:text-red-400">Couldn&apos;t disconnect. Try again.</p>}
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-zinc-500">
            Connect GitHub to copy the TwinStack site into your account and manage it. GitHub will ask you to allow access to
            your profile, email, repositories and Actions workflows.
          </p>
          {/* Plain <a>: a full-page navigation to the Express OAuth route. */}
          <a
            href="/auth/github"
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
          >
            <GitHubIcon className="size-4" />
            Connect GitHub
          </a>
        </>
      )}
    </section>
  );
}
