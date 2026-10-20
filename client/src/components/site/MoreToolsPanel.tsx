"use client";

import { useEffect, useState } from "react";
import { api, workspacePath, type StaticSection } from "@/lib/site-api";
import { useSite, type SiteSection } from "./site-context";
import { ScreenHeader } from "./ui";

/** The tools most owners never need, each one click from the menu's "More tools". */
export const MORE_TOOLS: { id: SiteSection; label: string; text: string }[] = [
  { id: "seo", label: "Google & sharing", text: "How your pages look in Google and when shared, plus site-wide search settings" },
  { id: "redirects", label: "Old web addresses", text: "Send visitors from your old site's addresses to the new pages" },
  { id: "sections", label: "Homepage sections", text: "Older sites only: which sections the homepage shows, in order" },
  { id: "tree", label: "Page plan", text: "A list of the pages your site should have" },
  { id: "schedule", label: "Planned posts", text: "Pages and posts the AI writes on the dates you choose" },
  { id: "memory", label: "AI notes about your site", text: "What the AI remembers from earlier work, and your standing notes" },
  { id: "styles", label: "Custom code", text: "Extra styling (CSS) for people who know it" },
  { id: "models", label: "AI settings", text: "Which AI models write your pages and pictures" },
  { id: "tools", label: "Technical log", text: "What happened when something didn't work, and site updates" },
];

// Business info's files that only some sites have: their tools show only then.
const NEEDS_SECTION: Partial<Record<SiteSection, string>> = { redirects: "redirects", sections: "home" };

export function MoreToolsPanel() {
  const { owner, repo, showSection } = useSite();
  const [sections, setSections] = useState<StaticSection[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ sections: StaticSection[] }>(workspacePath(owner, repo, "/static-info"))
      .then((info) => !cancelled && setSections(info.sections))
      .catch(() => !cancelled && setSections([]));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const tools = MORE_TOOLS.filter((tool) => {
    const needs = NEEDS_SECTION[tool.id];
    return !needs || sections?.some((s) => s.id === needs);
  });

  return (
    <div className="space-y-6">
      <ScreenHeader title="More tools" description="Most owners never need these. Nothing here is required, and each one has a link back here." />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => (
          <li key={tool.id}>
            <button
              type="button"
              onClick={() => showSection(tool.id)}
              className="h-full w-full rounded-lg border border-zinc-200 p-4 text-left transition hover:border-zinc-400 hover:shadow-sm dark:border-zinc-800 dark:hover:border-zinc-600"
            >
              <span className="block font-medium">{tool.label}</span>
              <span className="mt-1 block text-sm text-zinc-600 dark:text-zinc-400">{tool.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
