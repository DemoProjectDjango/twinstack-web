import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteManager } from "@/components/site/SiteManager";
import { getUser } from "@/lib/session";

export async function generateMetadata({ params }: PageProps<"/sites/[owner]/[repo]">): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `${owner}/${repo} · Twinstack` };
}

export default async function SitePage({ params }: PageProps<"/sites/[owner]/[repo]">) {
  const [user, { owner, repo }] = await Promise.all([getUser(), params]);
  if (!user) redirect(`/login?next=${encodeURIComponent(`/sites/${owner}/${repo}`)}`);
  // Sites live on GitHub; the dashboard is where it gets connected.
  if (!user.github) redirect("/dashboard");

  return <SiteManager owner={owner} repo={repo} />;
}
