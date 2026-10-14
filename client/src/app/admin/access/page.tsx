import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AccessRequests } from "@/components/AccessRequests";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Access requests · Twinstack" };

export default async function AdminAccessPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/admin/access");
  // The API checks again on every call; this only keeps the page from other accounts.
  if (!user.admin) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Access requests</h1>
      <p className="mt-1 text-sm text-zinc-500">
        People who asked to create websites. Approving or denying sends them an email.
      </p>
      <div className="mt-6">
        <AccessRequests />
      </div>
    </main>
  );
}
