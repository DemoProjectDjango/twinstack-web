import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RepoList } from "@/components/RepoList";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard · Twinstack" };

export default async function DashboardPage() {
  const user = await getUser();
  if (!user) redirect("/");

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <form action="/auth/logout" method="post">
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </form>
      </header>

      <section className="mt-8 flex items-center gap-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={user.avatarUrl} alt="" width={64} height={64} className="size-16 rounded-full" />
        <div className="min-w-0">
          <p className="truncate text-lg font-medium">{user.name ?? user.login}</p>
          <a
            href={user.profileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-zinc-500 hover:underline"
          >
            @{user.login}
          </a>
          {user.email && <p className="truncate text-sm text-zinc-500">{user.email}</p>}
        </div>
      </section>

      <RepoList />
    </main>
  );
}
