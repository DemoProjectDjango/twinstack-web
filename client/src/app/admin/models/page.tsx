import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AdminTabs } from "@/components/AdminTabs";
import { FastModelSettings } from "@/components/FastModelSettings";
import { ImageModelSettings } from "@/components/ImageModelSettings";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "AI models · Twinstack" };

export default async function AdminModelsPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/admin/models");
  // The API checks again on every call; this only keeps the page from other accounts.
  if (!user.admin) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <AdminTabs />
      <h1 className="text-2xl font-semibold tracking-tight">AI models</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Claude writes and designs for everyone, on the model each account picks in Settings. Here you choose the defaults for the rest: a
        cheaper model for routine work, and the model that makes pictures. Each site can pick its own on its AI models screen; these apply to
        every site that hasn&apos;t.
      </p>
      <div className="mt-8 space-y-8">
        <FastModelSettings />
        <ImageModelSettings />
      </div>
    </main>
  );
}
