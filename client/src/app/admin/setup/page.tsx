import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AdminSetupStats } from "@/components/AdminSetupStats";
import { AdminTabs } from "@/components/AdminTabs";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Site setup · Twinstack" };

export default async function AdminSetupPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/admin/setup");
  // The API checks again on every call; this only keeps the page from other accounts.
  if (!user.admin) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <AdminTabs />
      <h1 className="text-2xl font-semibold tracking-tight">Site setup</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        How new sites&apos; setup questions went, for each site type: which answers owners picked, typed or skipped, and what they did in
        their site&apos;s first week. Questions skipped or answered in their own words a lot, and sites that need many fixes, show where a
        site type&apos;s questions and plan need changing.
      </p>
      <div className="mt-8">
        <AdminSetupStats />
      </div>
    </main>
  );
}
