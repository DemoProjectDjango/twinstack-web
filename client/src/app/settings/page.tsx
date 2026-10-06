import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AnthropicKey } from "@/components/AnthropicKey";
import { GithubConnection } from "@/components/GithubConnection";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Settings · Twinstack" };

export default async function SettingsPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/settings");

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-8 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Your account</h2>
        <p className="mt-1 truncate font-medium">{user.name}</p>
        <p className="truncate text-sm text-zinc-500">{user.email}</p>
      </section>

      <GithubConnection github={user.github} />

      <AnthropicKey />
    </main>
  );
}
