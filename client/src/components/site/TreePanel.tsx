"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath } from "@/lib/site-api";
import { LiveDiff } from "./LiveDiff";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Section, inputClass } from "./ui";

type DataFile = { content: string; exists: boolean; path: string };

export function TreePanel() {
  const { owner, repo, busy, run, version } = useSite();
  const [saved, setSaved] = useState<string | null>(null);
  const savedRef = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [force, setForce] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<DataFile>(workspacePath(owner, repo, "/files/site-tree"))
      .then(({ content }) => {
        if (cancelled) return;
        // Keep unsaved edits; only follow the file when the editor matches what was saved.
        const previous = savedRef.current;
        setDraft((current) => (previous === null || current === previous ? content : current));
        savedRef.current = content;
        setSaved(content);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
    // Scheduled jobs append to the tree, so reload after commands too.
  }, [owner, repo, version]);

  const dirty = saved !== null && draft !== saved;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const file = await api<DataFile>(workspacePath(owner, repo, "/files/site-tree"), { method: "PUT", body: { content: draft } });
      savedRef.current = file.content;
      setSaved(file.content);
      setDraft(file.content);
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Unsaved edits are saved first, so the command always sees what's on screen.
  async function scaffold(dryRun: boolean) {
    if (dirty && !(await save())) return;
    if (!dryRun && force && !confirm("Overwrite every existing page listed in the tree with a fresh skeleton?")) return;
    await run("scaffold", { dryRun, force });
  }

  return (
    <Section
      title="Site plan"
      description={
        <>
          The list of every page your site should have. &quot;Create missing pages&quot; adds the ones that don&apos;t exist
          yet. Technical: scripts/site-tree.md lists every page the site should have, one path per bullet. Anything after &quot; — &quot; is the
          instruction for that page. Scaffolding creates only the pages that are missing, using
          scripts/site-tree-content/&lt;path&gt;.md verbatim when one exists. A bullet ending in .css (- css/style.css)
          declares a global stylesheet: it&apos;s scaffolded to styles/global/&lt;path&gt;, and every page converted with
          its styles kept that links it gets it.
        </>
      }
    >
      <ErrorText error={error} />
      {saved === null && !error ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={22}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs leading-relaxed`}
            disabled={busy || saving}
          />
          {saved !== null && (
            <div className="mt-3">
              <LiveDiff before={saved} after={draft} label="Unsaved changes" />
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button disabled={!dirty || busy || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button disabled={busy || saving} onClick={() => scaffold(true)}>
              Show what it would do
            </Button>
            <Button variant="primary" disabled={busy || saving} onClick={() => scaffold(false)}>
              Create missing pages
            </Button>
            <label className="ml-2 flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={busy || saving} />
              Also overwrite existing pages
            </label>
          </div>
          {force && (
            <div className="mt-3">
              <Notice tone="warning">Overwriting replaces the existing files&apos; content with skeletons. You can still undo it on the Publish screen before publishing.</Notice>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
