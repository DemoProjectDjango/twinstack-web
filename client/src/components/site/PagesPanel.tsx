"use client";

import { useState } from "react";
import { useSite } from "./site-context";
import { Badge, Button, Field, Section, inputClass } from "./ui";

const TYPES = [
  { value: "page", label: "Page" },
  { value: "product", label: "Product" },
  { value: "service", label: "Service" },
  { value: "post", label: "Blog post" },
  { value: "case", label: "Case study" },
];

export function PagesPanel() {
  const { overview, busy, run, editFile } = useSite();
  const [type, setType] = useState("page");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [draft, setDraft] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const started = await run("new", { type, title, slug: slug || undefined, draft });
    if (started) {
      setTitle("");
      setSlug("");
    }
  }

  return (
    <>
      <Section
        title="New page"
        description="Creates the file with the right frontmatter. Navigation, listings, the sitemap, RSS and search pick it up on the next build."
      >
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass} disabled={busy}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} className={inputClass} disabled={busy} />
          </Field>
          <Field label="Slug (optional)" hint="Defaults to the title in lowercase with dashes.">
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9\-]+"
              maxLength={70}
              className={inputClass}
              disabled={busy}
            />
          </Field>
          <label className="flex items-center gap-2 self-center text-sm">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} />
            Draft (left out of production builds)
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
              Create
            </Button>
          </div>
        </form>
      </Section>

      <Section title="Content" description="Every markdown file in each collection. Pick one to change it with Claude.">
        {!overview && <p className="text-sm text-zinc-500">Loading…</p>}
        <div className="space-y-5">
          {overview?.collections.map((collection) => (
            <div key={collection.name}>
              <h4 className="text-sm font-medium">
                {collection.label} <span className="font-normal text-zinc-500">· {collection.dir}</span>
              </h4>
              {collection.pages.length === 0 ? (
                <p className="mt-1 text-sm text-zinc-500">No pages yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {collection.pages.map((page) => (
                    <li key={page.file} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="text-sm font-medium">{page.title}</span>
                      {page.draft && <Badge>Draft</Badge>}
                      <span className="font-mono text-xs text-zinc-500">{page.file}</span>
                      <Button variant="ghost" className="ml-auto px-2 py-1 text-xs" onClick={() => editFile(page.file)}>
                        Edit with Claude
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
