import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AnthropicKey } from "@/components/AnthropicKey";
import { GithubConnection } from "@/components/GithubConnection";
import { RepoList } from "@/components/RepoList";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard · Twinstack" };

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const [user, params] = await Promise.all([getUser(), searchParams]);
  if (!user) redirect("/login?next=/dashboard");
  const githubError = typeof params.github_error === "string" ? params.github_error : undefined;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Link href="/#guide" className="text-sm text-zinc-500 hover:underline">
          How this works
        </Link>
      </header>

      <section className="mt-8 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Account</h2>
        <p className="mt-1 truncate font-medium">{user.name}</p>
        <p className="truncate text-sm text-zinc-500">{user.email}</p>
      </section>

      <GithubConnection github={user.github} error={githubError} justConnected={params.github === "connected"} />

      <AnthropicKey />

      {user.github ? (
        <RepoList />
      ) : (
        <section id="repositories" className="mt-10">
          <h2 className="text-lg font-semibold">Site repositories</h2>
          <p className="mt-1 text-sm text-zinc-500">Connect GitHub above to see the TwinStack site template and your copies of it.</p>
        </section>
      )}
    </main>
  );
}
