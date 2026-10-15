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
      <h1 className="text-2xl font-semibold tracking-tight">Fast model</h1>
      <p className="mt-1 text-sm text-zinc-500">
        The cheaper model that does routine work for every account: page edits and new pages on a site that already has a design,
        the header and footer, search text, file edits and site details. When its work fails the site&apos;s checks, the
        account&apos;s Claude model does it again. Claude still does everything else. This is the default: each site can choose
        its own on its AI model screen.
      </p>
      <div className="mt-6">
        <FastModelSettings />
      </div>

      <h2 className="mt-12 text-2xl font-semibold tracking-tight">Image model</h2>
      <p className="mt-1 text-sm text-zinc-500">
        The OpenAI model that makes the photos and illustrations Claude adds to pages, paid for in credits. This is the default: each site
        can choose its own on its AI models screen.
      </p>
      <div className="mt-6">
        <ImageModelSettings />
      </div>
    </main>
  );
}
