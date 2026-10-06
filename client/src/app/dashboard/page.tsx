import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { Notice } from "@/components/site/ui";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Your sites · Twinstack" };

// Errors the GitHub connection redirects back with (?github_error=…).
const GITHUB_ERRORS: Record<string, string> = {
  access_denied: "You cancelled on GitHub, so nothing was connected.",
  invalid_state: "Connecting GitHub took too long. Try again.",
  github_in_use: "That GitHub account is already connected to another Twinstack account.",
};

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const [user, params] = await Promise.all([getUser(), searchParams]);
  if (!user) redirect("/login?next=/dashboard");
  const githubError = typeof params.github_error === "string" ? params.github_error : undefined;
  const firstName = user.name.trim().split(/\s+/)[0];

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{firstName ? `Hi ${firstName}` : "Your sites"}</h1>
      <p className="mt-1 text-sm text-zinc-500">Build your website step by step, then publish it with one click.</p>

      <div className="mt-6 space-y-3">
        {githubError && <Notice tone="warning">{GITHUB_ERRORS[githubError] ?? "Connecting GitHub didn't work. Try again."}</Notice>}
        {params.github === "connected" && user.github && <Notice tone="success">GitHub connected as @{user.github.login}.</Notice>}
      </div>

      <div className="mt-6">
        <Dashboard githubLogin={user.github?.login ?? null} />
      </div>
    </main>
  );
}
