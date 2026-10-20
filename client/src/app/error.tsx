"use client";

import Link from "next/link";
import { useEffect } from "react";

// What a page shows when it couldn't load: usually Twinstack's server is restarting or can't reach its
// database for a moment (getUser's SessionUnavailableError), so the owner stays signed in and tries again.
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">This page couldn&apos;t load</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Twinstack&apos;s server didn&apos;t answer in time. You&apos;re still signed in and nothing was lost. Try again in a moment.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Try again
        </button>
        <Link href="/dashboard" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
          Your sites
        </Link>
      </div>
    </main>
  );
}
