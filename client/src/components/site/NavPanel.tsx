"use client";

import { useState } from "react";
import { useSite } from "./site-context";
import { Badge, Button, Field, Section, inputClass } from "./ui";

type Mode = "auto" | "plain" | "collection";

export function NavPanel() {
  const { overview, busy, run } = useSite();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [collection, setCollection] = useState("");
  const [limit, setLimit] = useState(8);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const input: Record<string, unknown> = { label, url };
    if (mode === "plain") input.plain = true;
    if (mode === "collection") Object.assign(input, { collection, limit });
    if (await run("nav-add", input)) {
      setLabel("");
      setUrl("");
      setCollection("");
    }
  }

  function remove(itemLabel: string) {
    if (confirm(`Remove "${itemLabel}" from the header navigation?`)) void run("nav-remove", { identifier: itemLabel });
  }

  const items = overview?.navigation.items ?? [];

  return (
    <>
      <Section title="Header navigation" description="From content/data/navigation.json. Collection menus list their pages automatically.">
        {!overview && <p className="text-sm text-zinc-500">Loading…</p>}
        {overview && items.length === 0 && <p className="text-sm text-zinc-500">No navigation items.</p>}
        {items.length > 0 && (
          <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {items.map((item) => (
              <li key={`${item.label}-${item.url}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium">{item.label}</span>
                <span className="font-mono text-xs text-zinc-500">{item.url}</span>
                {item.collection && (
                  <Badge>
                    {item.collection} menu · {item.limit ?? 8}
                  </Badge>
                )}
                <Button variant="ghost" className="ml-auto px-2 py-1 text-xs" disabled={busy} onClick={() => remove(item.label)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {overview?.navigation.cta && (
          <p className="mt-3 text-sm text-zinc-500">
            Button: {overview.navigation.cta.label} → <span className="font-mono text-xs">{overview.navigation.cta.url}</span>
          </p>
        )}
      </Section>

      <Section title="Add item">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-2">
          <Field label="Label">
            <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} className={inputClass} disabled={busy} />
          </Field>
          <Field label="URL" hint="Root-relative (/partners.html) or a full https:// link.">
            <input value={url} onChange={(e) => setUrl(e.target.value)} required maxLength={300} className={inputClass} disabled={busy} />
          </Field>
          <fieldset className="space-y-1.5 text-sm sm:col-span-2">
            <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Kind</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "auto"} onChange={() => setMode("auto")} disabled={busy} className="mt-1" />
              <span>
                Automatic <span className="text-zinc-500">(a new single-segment URL such as /events.html sets up a collection, with a layout, listing page and sample entry)</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "plain"} onChange={() => setMode("plain")} disabled={busy} className="mt-1" />
              <span>Plain link only</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "collection"} onChange={() => setMode("collection")} disabled={busy} className="mt-1" />
              <span>Menu listing a collection</span>
            </label>
          </fieldset>
          {mode === "collection" && (
            <>
              <Field label="Collection" hint="An existing collection name, or a new one to create.">
                <input
                  value={collection}
                  onChange={(e) => setCollection(e.target.value)}
                  required
                  pattern="[A-Za-z0-9\-]+"
                  list="nav-collections"
                  className={inputClass}
                  disabled={busy}
                />
                <datalist id="nav-collections">
                  {overview?.collections.map((c) => <option key={c.name} value={c.name} />)}
                </datalist>
              </Field>
              <Field label="Items shown">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                  className={inputClass}
                  disabled={busy}
                />
              </Field>
            </>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" disabled={busy || !label.trim() || !url.trim()}>
              Add to navigation
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}
