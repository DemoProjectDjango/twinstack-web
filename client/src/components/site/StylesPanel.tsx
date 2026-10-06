"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type CssFile, type CssSource, type WorkspaceStatus } from "@/lib/site-api";
import { LiveDiff } from "./LiveDiff";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Notice, Section, inputClass } from "./ui";

const lf = (text: string) => text.replace(/\r\n/g, "\n");

const KIND_LABELS: Record<CssFile["kind"], string> = {
  site: "Site styles",
  global: "Global stylesheets",
  imported: "Converted pages",
};

/** Edit the site's stylesheets: the Tailwind source, the site tree's global stylesheets and converted pages' own CSS. */
export function StylesPanel() {
  const { owner, repo, version, overview } = useSite();
  const [files, setFiles] = useState<CssFile[] | null>(null);
  const [file, setFile] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ files: CssFile[] }>(workspacePath(owner, repo, "/css"))
      .then(({ files }) => {
        if (cancelled) return;
        setFiles(files);
        // Keep the open file; otherwise start on the first global stylesheet, which is what most edits are for.
        setFile((current) => (files.some((f) => f.file === current) ? current : (files.find((f) => f.kind === "global") ?? files[0])?.file ?? ""));
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const selected = files?.find((f) => f.file === file) ?? null;
  const globalCss = overview?.features.globalCss ?? true;

  return (
    <Section
      title="Styles"
      description={
        <>
          Edit the site&apos;s CSS. Global stylesheets are declared in the site tree as <code className="font-mono">- css/style.css</code>{" "}
          lines and are applied to every page converted with its styles kept that links them. Changes are saved to the files directly; review
          and publish them like any other change.
        </>
      }
    >
      <ErrorText error={error} />
      {!globalCss && (
        <div className="mb-3">
          <Notice tone="warning">
            This copy&apos;s <code className="font-mono">scripts/edit-page.js</code> doesn&apos;t apply global stylesheets yet.
            Update it and <code className="font-mono">scripts/lib/scaffold-tree-runner.js</code> from the template to use them.
          </Notice>
        </div>
      )}
      {files === null && !error ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : files && files.length === 0 ? (
        <p className="text-sm text-zinc-500">This site has no stylesheets to edit.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
          <nav className="space-y-3 text-sm">
            {(["site", "global", "imported"] as const).map((kind) => {
              const group = files?.filter((f) => f.kind === kind) ?? [];
              if (!group.length && kind !== "global") return null;
              return (
                <div key={kind}>
                  <h3 className="text-xs font-medium text-zinc-500">{KIND_LABELS[kind]}</h3>
                  {group.length === 0 ? (
                    <p className="mt-1 text-xs text-zinc-500">
                      None yet. Add a <code className="font-mono">- css/style.css</code> line to the site tree.
                    </p>
                  ) : (
                    <ul className="mt-1 space-y-0.5">
                      {group.map((f) => (
                        <li key={f.file}>
                          <button
                            type="button"
                            onClick={() => setFile(f.file)}
                            aria-current={f.file === file ? "true" : undefined}
                            className={`w-full truncate rounded px-2 py-1 text-left font-mono text-xs ${
                              f.file === file ? "bg-zinc-200 dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                            }`}
                            title={f.file}
                          >
                            {f.file.replace(/^styles\/global\/|^assets\/css\/imported\//, "")}
                            {!f.exists && <span className="ml-1 text-zinc-500">(new)</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </nav>
          {selected && <CssEditor key={selected.file} entry={selected} />}
        </div>
      )}
    </Section>
  );
}

function CssEditor({ entry }: { entry: CssFile }) {
  const { owner, repo, busy, version, setStatus, setUnsavedDraft, refresh } = useSite();
  const [source, setSource] = useState<CssSource | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = source !== null && text !== source.content;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
    setUnsavedDraft(dirty);
  }, [dirty, setUnsavedDraft]);
  useEffect(() => () => setUnsavedDraft(false), [setUnsavedDraft]);

  // Reload after every command (a conversion may have replaced the file) unless there are unsaved edits.
  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    api<CssSource>(workspacePath(owner, repo, `/css/source?file=${encodeURIComponent(entry.file)}`))
      .then((loaded) => {
        if (cancelled || dirtyRef.current) return;
        const content = lf(loaded.content);
        setSource({ ...loaded, content });
        setText(content);
        setLoadError(null);
      })
      .catch((err) => !cancelled && setLoadError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, entry.file, version]);

  async function save() {
    if (!source) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api<{ css: CssSource; status: WorkspaceStatus }>(workspacePath(owner, repo, "/css/source"), {
        method: "PUT",
        body: { file: entry.file, content: text, version: source.version },
      });
      const content = lf(result.css.content);
      dirtyRef.current = false;
      setSource({ ...result.css, content });
      setText(content);
      setStatus(result.status);
      setSaved(true);
      // A new global stylesheet now exists, so the convert form and this list should say so.
      if (!source.exists) void refresh();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm">{entry.file}</code>
        {entry.kind === "global" && !entry.declared && <Badge>not in the site tree</Badge>}
      </div>
      {entry.kind === "site" && (
        <Notice>
          The site&apos;s Tailwind source: theme tokens and shared components. It&apos;s compiled into{" "}
          <code className="font-mono">assets/css/main.css</code> on every build. Follow the template&apos;s
          TAILWIND-GUIDELINES.md, and run a build to check it still compiles.
        </Notice>
      )}
      {entry.kind === "global" && (
        <Notice>
          Every page converted with its styles kept that links this file (by name) gets it, scoped to that page, in the place the
          page linked it.
          Pages converted before a change keep the earlier version until they&apos;re converted again.
          {!entry.declared && " It isn't declared in the site tree, so conversions don't use it until a line for it is added there."}
        </Notice>
      )}
      {entry.kind === "imported" && (
        <Notice tone="warning">
          One converted page&apos;s own CSS, already scoped to <code className="font-mono">.imported-page</code> with its classes
          prefixed <code className="font-mono">imp-</code>. Write selectors that way. Converting the page again regenerates this
          file and replaces your edits.
        </Notice>
      )}
      <ErrorText error={loadError} />
      {source === null && !loadError ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : source ? (
        <>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            rows={26}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs leading-relaxed`}
            disabled={busy || saving}
            aria-label={`Contents of ${entry.file}`}
          />
          <LiveDiff before={source.content} after={text} label="Unsaved changes" />
          <ErrorText error={saveError} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={(!dirty && source.exists) || busy || saving} onClick={save}>
              {saving ? "Saving…" : source.exists ? "Save" : "Create file"}
            </Button>
            <Button disabled={!dirty || busy || saving} onClick={() => setText(source.content)}>
              Discard changes
            </Button>
            {saved && !dirty && <span className="text-xs text-zinc-500">Saved.</span>}
          </div>
        </>
      ) : null}
    </div>
  );
}
