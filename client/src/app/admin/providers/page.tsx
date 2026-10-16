import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AdminProviders } from "@/components/AdminProviders";
import { AdminTabs } from "@/components/AdminTabs";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "AI providers · Twinstack" };

export default async function AdminProvidersPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/admin/providers");
  // The API checks again on every call; this only keeps the page from other accounts.
  if (!user.admin) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <AdminTabs />
      <h1 className="text-2xl font-semibold tracking-tight">AI providers</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Everyone&apos;s Claude, DeepSeek and OpenAI requests run on the app&apos;s own keys. This shows whether each one has the
        balance to keep going, and emails the admins before it runs out.
      </p>
      <div className="mt-6">
        <AdminProviders />
      </div>
    </main>
  );
}
