"use client";

import { useEffect, useState } from "react";
import { api, workspacePath, type Json, type StaticSection } from "@/lib/site-api";
import { JsonForm } from "./JsonForm";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Section } from "./ui";

/** Site-wide facts (site.config.json and content/data/*.json): see them, edit them, save them. */
export function StaticInfoPanel() {
  const { owner, repo, busy, refresh } = useSite();
  const [sections, setSections] = useState<StaticSection[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Json | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ sections: StaticSection[] }>(workspacePath(owner, repo, "/static-info"))
      .then(({ sections: list }) => {
        if (cancelled) return;
        setSections(list);
        setSelected(list[0]?.id ?? null);
        setDraft(list[0]?.data ?? null);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const section = sections?.find((s) => s.id === selected) ?? null;
  const dirty = section !== null && JSON.stringify(draft) !== JSON.stringify(section.data);

  function choose(id: string) {
    if (id === selected) return;
    if (dirty && !confirm("You have unsaved changes in this section. Discard them?")) return;
    const next = sections?.find((s) => s.id === id);
    setSelected(id);
    setDraft(next?.data ?? null);
    setError(null);
    setSavedAt(null);
  }

  async function save() {
    if (!section || draft === null) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const result = await api<{ sections: StaticSection[] }>(workspacePath(owner, repo, `/static-info/${section.id}`), {
        method: "PUT",
        body: { data: draft },
      });
      setSections(result.sections);
      setDraft(result.sections.find((s) => s.id === section.id)?.data ?? draft);
      setSavedAt(section.file);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  if (!sections) {
    return (
      <Section title="Site information">
        {error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading…</p>}
      </Section>
    );
  }

  return (
    <Section
      title="Site information"
      description="Facts that appear across the whole site. Change them here once and every page that uses them updates on the next build."
    >
      {sections.length === 0 ? (
        <p className="text-sm text-zinc-500">This site has none of the usual data files (site.config.json, content/data/*.json).</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-[11rem_minmax(0,1fr)]">
          <nav aria-label="Information sections" className="flex flex-wrap gap-1 md:flex-col">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => choose(s.id)}
                aria-current={s.id === selected ? "true" : undefined}
                className={`rounded-md px-3 py-1.5 text-left text-sm ${
                  s.id === selected ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          {section && draft !== null && (
            <div className="min-w-0 space-y-4">
              <div>
                <h4 className="font-medium">{section.label}</h4>
                <p className="text-sm text-zinc-500">{section.description}</p>
                <p className="mt-1 font-mono text-xs text-zinc-500">{section.file}</p>
              </div>

              <JsonForm value={draft} shape={section.data} onChange={setDraft} disabled={saving || busy} />

              <ErrorText error={error} />
              {savedAt && !dirty && (
                <Notice tone="success">
                  Saved {savedAt}. Build a preview to see it on the site. The change is listed on the Changes tab until you publish it.
                </Notice>
              )}
              <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-zinc-200 bg-background py-3 dark:border-zinc-800">
                <Button variant="primary" disabled={!dirty || saving || busy} onClick={save}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
                <Button disabled={!dirty || saving} onClick={() => setDraft(section.data)}>
                  Undo changes
                </Button>
                {dirty && <span className="text-xs text-zinc-500">Unsaved changes</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
