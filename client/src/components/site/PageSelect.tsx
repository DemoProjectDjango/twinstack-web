"use client";

import { useSite } from "./site-context";
import { Field, inputClass } from "./ui";

/** Every markdown page in the site, grouped by collection. */
export function PageSelect({ value, onChange, disabled }: { value: string; onChange: (file: string) => void; disabled: boolean }) {
  const { overview } = useSite();
  const collections = overview?.collections.filter((c) => c.pages.length) ?? [];

  return (
    <>
      <Field label="Page">
        <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} disabled={disabled}>
          <option value="">Choose a page…</option>
          {collections.map((collection) => (
            <optgroup key={collection.name} label={collection.label}>
              {collection.pages.map((page) => (
                <option key={page.file} value={page.file}>
                  {page.title} — {page.file}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {overview && collections.length === 0 && (
        <p className="text-sm text-zinc-500">This site has no pages yet. Create some on the Pages or Site tree tab.</p>
      )}
    </>
  );
}
