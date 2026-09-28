"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type PageSource, type WorkspaceStatus } from "@/lib/site-api";
import { ImagePicker } from "./ImagePicker";
import { LiveDiff } from "./LiveDiff";
import { PageSelect } from "./PageSelect";
import { useSite } from "./site-context";
import { Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/;
const lf = (text: string) => text.replace(/\r\n/g, "\n");

/**
 * Write a page's markdown by hand — rough copy, images, image URLs, notes to
 * Claude — then have Claude turn that draft into the finished page.
 */
export function DraftEditor({ file, onFileChange }: { file: string; onFileChange: (file: string) => void }) {
  const { overview, busy, hasKey } = useSite();
  const supportsGenerate = overview?.features.pageGenerate ?? true;

  return (
    <>
      {!supportsGenerate && (
        <Notice tone="warning">
          This site copy has an older <code className="font-mono">scripts/edit-page.js</code> without{" "}
          <code className="font-mono">--generate</code>, so Claude can&apos;t finish a draft yet. You can still edit and save the
          page here. Update <code className="font-mono">scripts/edit-page.js</code> and{" "}
          <code className="font-mono">scripts/lib/claude-writer.js</code> from the template to turn it on.
        </Notice>
      )}
      <Section
        title="Write a page, then let Claude finish it"
        description="Write what the page should say, roughly if you like: notes, pasted text, lists, images and image URLs. Claude turns it into the finished page: structured, in house style, with the layout's fields filled in and every image placed with alt text. It keeps your facts and adds none. You preview the result before anything is saved."
      >
        <div className="space-y-4">
          <PageSelect value={file} onChange={onFileChange} disabled={busy} />
          {file && <DraftForm key={file} file={file} canGenerate={supportsGenerate && hasKey} />}
        </div>
      </Section>
    </>
  );
}

function DraftForm({ file, canGenerate }: { file: string; canGenerate: boolean }) {
  const { owner, repo, busy, run, version, job, setStatus, setUnsavedDraft } = useSite();
  const [page, setPage] = useState<PageSource | null>(null);
  const [text, setText] = useState("");
  const [direction, setDirection] = useState("");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const dirty = page !== null && text !== page.content;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
    setUnsavedDraft(dirty);
  }, [dirty, setUnsavedDraft]);
  useEffect(() => () => setUnsavedDraft(false), [setUnsavedDraft]);

  // Load the page, and reload it after every command (a Claude run may have
  // rewritten it) unless there are unsaved edits to keep.
  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    api<PageSource>(workspacePath(owner, repo, `/pages/source?file=${encodeURIComponent(file)}`))
      .then((loaded) => {
        if (cancelled || dirtyRef.current) return;
        const content = lf(loaded.content);
        setPage({ ...loaded, content });
        setText(content);
        setLoadError(null);
      })
      .catch((err) => !cancelled && setLoadError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, file, version]);

  async function save() {
    if (!page) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api<{ page: PageSource; status: WorkspaceStatus }>(workspacePath(owner, repo, "/pages/source"), {
        method: "PUT",
        body: { file, content: text, version: page.version },
      });
      const content = lf(result.page.content);
      dirtyRef.current = false;
      setPage({ ...result.page, content });
      setText(content);
      setStatus(result.status);
      setSaved(true);
      return true;
    } catch (err) {
      setSaveError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function generate(dryRun: boolean) {
    if (dirty && !(await save())) return;
    setSaved(false);
    void run("page-generate", { page: file, instruction: direction.trim() || undefined, dryRun });
  }

  /** Puts ![](path) at the cursor, on its own lines, but never inside the frontmatter. */
  function insertImage(entry: string) {
    const src = /^https?:/i.test(entry) ? entry : `/${entry}`;
    const el = textRef.current;
    let start = el?.selectionStart ?? text.length;
    let end = el?.selectionEnd ?? start;
    const frontmatterEnd = FRONTMATTER.exec(text)?.[0].length ?? 0;
    if (start < frontmatterEnd) start = end = text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const newlinesToAdd = (have: string) => (have.startsWith("\n\n") ? "" : have.startsWith("\n") ? "\n" : "\n\n");
    const lead = before === "" ? "" : newlinesToAdd([...before.slice(-2)].reverse().join(""));
    const trail = after === "" ? "\n" : newlinesToAdd(after);
    const snippet = `${lead}![](${src})${trail}`;
    setText(before + snippet + after);
    setSaved(false);
    const cursor = before.length + snippet.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor, cursor);
    });
  }

  const running = job?.command === "page-generate" && job.status === "running";
  const locked = busy || saving || !page;

  if (loadError && !page) return <ErrorText error={loadError} />;
  if (!page) return <p className="text-sm text-zinc-500">Loading the page…</p>;

  return (
    <>
      <Field
        label="Draft"
        hint={
          <>
            Images: use the buttons below, or write <code className="font-mono">![](…)</code>,{" "}
            <code className="font-mono">&lt;img src=&quot;…&quot;&gt;</code> or a bare image URL. Notes to Claude go in{" "}
            <code className="font-mono">&lt;!-- … --&gt;</code> or <code className="font-mono">[note: …]</code> and are left out
            of the page. Keep the frontmatter between the <code className="font-mono">---</code> lines.
          </>
        }
      >
        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          rows={22}
          spellCheck
          aria-label={`Draft of ${file}`}
          className={`${inputClass} font-mono text-xs leading-relaxed`}
          disabled={locked}
        />
      </Field>

      <LiveDiff before={page.content} after={text} label="Unsaved changes" />

      <div>
        <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Add an image at the cursor</span>
        <div className="mt-1">
          <ImagePicker
            onAdd={insertImage}
            disabled={locked}
            hint="Uploads are saved into the site under assets/img/uploads/. Claude sees each image in the draft (up to 20) and writes alt text for it."
          />
        </div>
      </div>

      <Field label="Direction for Claude (optional)">
        <textarea
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          rows={2}
          maxLength={4000}
          placeholder="Keep it to three sections, and lead with the pricing"
          className={inputClass}
          disabled={locked}
        />
      </Field>

      <ErrorText error={saveError} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={locked || !canGenerate} onClick={() => void generate(true)}>
          {running ? "Claude is writing…" : dirty ? "Save and preview with Claude" : "Preview with Claude"}
        </Button>
        <Button disabled={locked || !canGenerate} onClick={() => void generate(false)}>
          {dirty ? "Save and apply without preview" : "Apply without preview"}
        </Button>
        <Button variant="ghost" disabled={locked || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save draft only"}
        </Button>
        <span className="text-xs text-zinc-500">
          {dirty ? "Unsaved changes." : saved ? "Draft saved." : ""} Each Claude run is one request, billed to your key.
        </span>
      </div>
    </>
  );
}
