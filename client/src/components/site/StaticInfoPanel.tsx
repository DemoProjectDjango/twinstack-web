"use client";

import { useEffect, useState } from "react";
import { api, workspacePath, type Json, type StaticSection } from "@/lib/site-api";
import { confirmModal } from "@/lib/confirm";
import { markVisited } from "./HomePanel";
import { JsonForm } from "./JsonForm";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, ScreenHeader, Section } from "./ui";

// Site-wide facts (site.config.json and content/data/*.json, server/src/static-info.js): see them,
// edit them, save them. The files are grouped by what the owner thinks of, not by file: Business info
// splits site.config.json into About, Contact and Social media next to the reviews, questions and
// highlights files; More tools has the search settings, old web addresses and homepage sections.
// A tab shows part of a section (`keys`, or the object at `path`); saving always sends the whole
// section, so the server's shape check is unchanged.

type JsonObject = { [key: string]: Json };
type Tab = {
  id: string;
  label: string;
  /** The static-info section it edits. */
  section: string;
  /** Only these top-level fields… */
  keys?: string[];
  /** …or only the object under this one (the tab is left out when the file doesn't have it). */
  path?: string;
  description: string;
  labels?: Record<string, string>;
};

export type StaticInfoView = "business" | "search" | "redirects" | "sections";

const VIEWS: Record<StaticInfoView, { title: string; description?: string; tabs: Tab[] }> = {
  business: {
    title: "Business info",
    description: "Fill these in once. Every page that mentions them updates by itself.",
    tabs: [
      {
        id: "about",
        label: "About",
        section: "site",
        keys: ["name", "shortName", "tagline", "footerTagline", "description"],
        description: "Your business's name and what it does. They appear at the top of every page, in the footer and in search results.",
        labels: {
          name: "Business name",
          shortName: "Short name (where the full name doesn't fit)",
          footerTagline: "Line at the bottom of every page",
          description: "What your business does",
        },
      },
      {
        id: "contact",
        label: "Contact",
        section: "site",
        path: "contact",
        description: "How customers reach you. The footer and your pages show them. Leave out anything you don't want shown.",
        labels: {
          hours: "Opening hours",
          whatsapp: "WhatsApp number",
          whatsappUrl: "WhatsApp link (https://wa.me/…)",
          bookingUrl: "Booking button goes to (a web address)",
          bookingLabel: "Booking button words",
          responseTime: "How fast you reply",
        },
      },
      {
        id: "social",
        label: "Social media",
        section: "site",
        path: "social",
        description: "Your pages elsewhere, as web addresses. Fill in the ones you have and leave the rest empty.",
        labels: { x: "X (Twitter)", linkedin: "LinkedIn", youtube: "YouTube", github: "GitHub" },
      },
      {
        id: "reviews",
        label: "Customer reviews",
        section: "testimonials",
        description: "What customers say about you, shown on pages that include reviews. Use real reviews only.",
        labels: { items: "Reviews", quote: "What they said", meta: "Who said it", industry: "Kind of customer (optional)" },
      },
      {
        id: "faq",
        label: "Questions & answers",
        section: "faq",
        description: "Questions customers often ask. Pages can show all of them, or the ones on one topic.",
        labels: { items: "Questions", topic: "Topic (optional)" },
      },
      {
        id: "highlights",
        label: "Highlights",
        section: "company",
        description: "Short facts and steps shown on several pages, like \"10 years baking\".",
        labels: { stats: "Numbers to be proud of", value: "Number or fact", label: "What it means", process: "How it works, step by step", title: "Step", body: "What happens" },
      },
    ],
  },
  search: {
    title: "Search settings for the whole site",
    tabs: [
      {
        id: "search",
        label: "Search settings",
        section: "site",
        path: "seo",
        description: "The format of every page's title in search results, and the codes Google and Bing give you to prove the site is yours.",
        labels: {
          titleTemplate: "Title format ({title}, {site}, {name}, {tagline})",
          homeTitle: "Homepage title",
          twitterHandle: "X handle",
          googleVerification: "Google verification code",
          bingVerification: "Bing verification code",
        },
      },
    ],
  },
  redirects: {
    title: "Old web addresses",
    description: "Addresses from your old site, and the page each one should now open, so old links and search results keep working.",
    tabs: [{ id: "redirects", label: "Old web addresses", section: "redirects", description: "", labels: { from: "Old address", to: "New address" } }],
  },
  sections: {
    title: "Homepage sections",
    description: "Older sites only: which sections the homepage shows, in order, and their headings and text.",
    tabs: [{ id: "home", label: "Homepage sections", section: "home", description: "" }],
  },
};

/** `drafts` without one section's edits. */
function without(drafts: Record<string, Json>, id: string) {
  const rest = { ...drafts };
  delete rest[id];
  return rest;
}

const isObject = (value: Json | undefined): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

function partOf(tab: Tab, data: Json): Json {
  if (!isObject(data)) return data;
  if (tab.path) return data[tab.path] ?? {};
  if (tab.keys) return Object.fromEntries(tab.keys.filter((k) => k in data).map((k) => [k, data[k]]));
  return data;
}

function withPart(tab: Tab, data: Json, part: Json): Json {
  if (!isObject(data)) return part;
  if (tab.path) return { ...data, [tab.path]: part };
  if (tab.keys && isObject(part)) return { ...data, ...part };
  return part;
}

/** A tab the site's files can fill: its section exists, and so does the object it shows. */
function available(tab: Tab, sections: StaticSection[]) {
  const section = sections.find((s) => s.id === tab.section);
  if (!section) return false;
  return !tab.path || (isObject(section.data) && isObject(section.data[tab.path]));
}

export function StaticInfoPanel({ view }: { view: StaticInfoView }) {
  const { owner, repo, busy, refresh, showSection, siteUpdate } = useSite();
  const { title, description, tabs: allTabs } = VIEWS[view];
  const [sections, setSections] = useState<StaticSection[] | null>(null);
  useEffect(() => {
    if (view === "business") markVisited(owner, repo, "details");
  }, [owner, repo, view]);
  const [selected, setSelected] = useState<string | null>(null);
  // Unsaved edits, by section: tabs of one section share them.
  const [drafts, setDrafts] = useState<Record<string, Json>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ sections: StaticSection[] }>(workspacePath(owner, repo, "/static-info"))
      .then(({ sections: list }) => !cancelled && setSections(list))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const tabs = sections ? allTabs.filter((t) => available(t, sections)) : [];
  const tab = tabs.find((t) => t.id === selected) ?? tabs[0] ?? null;
  const section = tab ? (sections?.find((s) => s.id === tab.section) ?? null) : null;
  const draft = section ? (drafts[section.id] ?? section.data) : null;
  const dirty = (id: string) => {
    const original = sections?.find((s) => s.id === id)?.data;
    return id in drafts && JSON.stringify(drafts[id]) !== JSON.stringify(original);
  };

  async function choose(next: Tab) {
    if (!tab || next.id === tab.id) return;
    // Another file: unsaved edits to this one would be lost on the way.
    if (next.section !== tab.section && dirty(tab.section)) {
      if (!(await confirmModal("You have unsaved changes on this tab. Discard them?", { confirmLabel: "Discard", danger: true }))) return;
      setDrafts((prev) => without(prev, tab.section));
    }
    setSelected(next.id);
    setError(null);
    setSaved(false);
  }

  async function save() {
    if (!section || draft === null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api<{ sections: StaticSection[] }>(workspacePath(owner, repo, `/static-info/${section.id}`), {
        method: "PUT",
        body: { data: draft },
      });
      setSections(result.sections);
      setDrafts((prev) => without(prev, section.id));
      setSaved(true);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  // The search settings sit under Google & sharing, and only on sites whose config has them.
  if (view === "search" && sections && !tabs.length) return null;

  if (!sections) {
    return (
      <Section title={title}>
        {error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading…</p>}
      </Section>
    );
  }

  const header = view === "search" ? <h3 className="font-semibold">{title}</h3> : <ScreenHeader title={title} description={description} />;
  if (!tab || !section || draft === null) {
    return (
      <div className="space-y-6">
        {header}
        <p className="text-sm text-zinc-500">This site doesn&apos;t have this information.</p>
      </div>
    );
  }

  const isDirty = dirty(section.id);
  const contact = tab.id === "contact" && isObject(draft) && isObject(draft.contact) ? draft.contact : null;
  const missingContact = contact ? ["phone", "address", "hours"].filter((k) => !(k in contact)) : [];

  return (
    <div className="space-y-6">
      {header}

      {tabs.length > 1 && (
        <div role="tablist" aria-label={title} className="flex flex-wrap gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab.id}
              onClick={() => void choose(t)}
              className={`rounded-full border px-3 py-1 text-sm ${
                t.id === tab.id
                  ? "border-foreground bg-foreground text-background"
                  : "border-zinc-300 text-zinc-600 hover:border-zinc-500 hover:text-foreground dark:border-zinc-700 dark:text-zinc-400"
              }`}
            >
              {t.label}
              {dirty(t.section) && t.id !== tab.id && <span className="ml-1" aria-label="unsaved changes">•</span>}
            </button>
          ))}
        </div>
      )}

      <div role={tabs.length > 1 ? "tabpanel" : undefined} className="min-w-0 space-y-4">
        {tab.description && <p className="text-sm text-zinc-600 dark:text-zinc-400">{tab.description}</p>}

        {missingContact.length > 0 && (
          <Notice>
            Phone, address and opening hours come with the latest version of your site.{" "}
            {siteUpdate.info?.available ? (
              <Button variant="ghost" className="ml-1 underline" onClick={() => showSection("home")}>
                Update it on Edit site
              </Button>
            ) : (
              "They appear here after its next update."
            )}
          </Notice>
        )}

        {/* Pinned under the app's header as the form scrolls (the AI bar has the bottom of the window). */}
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-background py-3 dark:border-zinc-800">
          <Button variant="primary" disabled={!isDirty || saving || busy} onClick={save}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button disabled={!isDirty || saving} onClick={() => setDrafts((prev) => without(prev, section.id))}>
            Undo changes
          </Button>
          {isDirty && <span className="text-xs text-zinc-500">Unsaved changes</span>}
        </div>

        <JsonForm
          value={partOf(tab, draft)}
          shape={partOf(tab, section.shape ?? section.data)}
          onChange={(part) => setDrafts((prev) => ({ ...prev, [section.id]: withPart(tab, draft, part) }))}
          disabled={saving || busy}
          labels={tab.labels}
        />

        <ErrorText error={error} />
        {saved && !isDirty && <Notice tone="success">Saved. Edit site shows it in a moment, and it goes live when you publish.</Notice>}
      </div>
    </div>
  );
}
