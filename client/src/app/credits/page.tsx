import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CreditsOverview } from "@/components/CreditsOverview";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Claude credits · Twinstack" };

export default async function CreditsPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/credits");

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Claude credits</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Every request Claude makes for you uses credits, worked out from the size of the request and its answer.
      </p>
      <CreditsOverview />
    </main>
  );
}
