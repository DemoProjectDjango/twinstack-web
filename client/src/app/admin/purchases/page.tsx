import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AdminPurchases } from "@/components/AdminPurchases";
import { AdminTabs } from "@/components/AdminTabs";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Purchases · Twinstack" };

export default async function AdminPurchasesPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/admin/purchases");
  // The API checks again on every call; this only keeps the page from other accounts.
  if (!user.admin) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <AdminTabs />
      <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Every account&apos;s credit purchases: who bought, what they paid, and what happened to the payment. Refunds and disputes are
        handled in Stripe; they show up here once Stripe reports them.
      </p>
      <div className="mt-6">
        <AdminPurchases />
      </div>
    </main>
  );
}
