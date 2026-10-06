"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type PageSource, type WorkspaceStatus } from "@/lib/site-api";
import { ImagePicker } from "./ImagePicker";
import { LiveDiff } from "./LiveDiff";
import { useSite } from "./site-context";
import { Button, Details, ErrorText, Field, Notice, Section, inputClass } from "./ui";

const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/;
const lf = (text: string) => text.replace(/\r\n/g, "\n");

/** A page's file as its settings block (the frontmatter, "" if none) and the text people write. */
function split(content: string) {
  const settings = FRONTMATTER.exec(content)?.[0] ?? "";
  return { settings, body: content.slice(settings.length) };
}

/** A loaded page with LF line endings, split for the two editors. */
function normalized(loaded: PageSource) {
  const content = lf(loaded.content);
  return { page: { ...loaded, content }, ...split(content) };
}

/**
 * Write a page's text by hand — rough copy, images, image URLs, notes to Claude —
 * save it as it is, or have Claude turn that draft into the finished page.
 */
export function DraftEditor({ file }: { file: string }) {
  const { overview, claude } = useSite();
  const supportsGenerate = overview?.features.pageGenerate ?? true;

  return (
    <>
      {!supportsGenerate && (
        <Notice tone="warning">
          Your site&apos;s tools are too old for Claude to finish a draft. You can still write and save the page here.
          <span className="mt-1 block text-xs opacity-80">
            Technical: update scripts/edit-page.js and scripts/lib/claude-writer.js from the template.
          </span>
        </Notice>
      )}
      <Section
        title="Write the page"
        description={
          claude.ready && supportsGenerate
            ? "Type what the page should say. It can be rough: notes, pasted text, lists and photos. Save it as it is, or let Claude turn it into a polished page. Claude keeps your facts and doesn't make any up."
            : "Type what the page should say, then save it."
        }
      >
        <DraftForm key={file} file={file} canGenerate={supportsGenerate && claude.ready} />
      </Section>
    </>
  );
}

function DraftForm({ file, canGenerate }: { file: string; canGenerate: boolean }) {
  const { owner, repo, busy, run, version, job, setStatus, setUnsavedDraft, claude } = useSite();
  const [page, setPage] = useState<PageSource | null>(null);
  // The file is edited as two parts, so the settings block can't be broken by typing in the text.
  const [settings, setSettings] = useState("");
  const [body, setBody] = useState("");
  const [direction, setDirection] = useState("");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const text = settings + body;
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
        const shown = normalized(loaded);
        setPage(shown.page);
        setSettings(shown.settings);
        setBody(shown.body);
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
      dirtyRef.current = false;
      const shown = normalized(result.page);
      setPage(shown.page);
      setSettings(shown.settings);
      setBody(shown.body);
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

  /** Puts ![](path) at the cursor in the text, on its own lines. */
  function insertImage(entry: string) {
    const src = /^https?:/i.test(entry) ? entry : `/${entry}`;
    const el = textRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? start;
    const before = body.slice(0, start);
    const after = body.slice(end);
    const newlinesToAdd = (have: string) => (have.startsWith("\n\n") ? "" : have.startsWith("\n") ? "\n" : "\n\n");
    const lead = before.trim() === "" ? "" : newlinesToAdd([...before.slice(-2)].reverse().join(""));
    const trail = after === "" ? "\n" : newlinesToAdd(after);
    const snippet = `${lead}![](${src})${trail}`;
    setBody(before + snippet + after);
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
    <div className="space-y-4">
      <Field
        label="Text"
        hint={
          <>
            Add photos with the button below. Notes for Claude go in <code className="font-mono">[note: …]</code> and never
            appear on the page.
          </>
        }
      >
        <textarea
          ref={textRef}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setSaved(false);
          }}
          rows={20}
          spellCheck
          aria-label={`Text of ${file}`}
          className={`${inputClass} text-sm leading-relaxed`}
          disabled={locked}
        />
      </Field>

      <div>
        <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Add a photo where the cursor is</span>
        <div className="mt-1">
          <ImagePicker
            onAdd={insertImage}
            disabled={locked}
            hint={canGenerate ? "Claude looks at each photo in the text (up to 20) and describes it for people who can't see it." : undefined}
          />
        </div>
      </div>

      {canGenerate && (
        <Field label="Anything else Claude should know? (optional)">
          <textarea
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder="Keep it to three sections, and lead with the prices"
            className={inputClass}
            disabled={locked}
          />
        </Field>
      )}

      <ErrorText error={saveError} />
      <div className="flex flex-wrap items-center gap-2">
        {canGenerate && (
          <Button variant="primary" disabled={locked} onClick={() => void generate(true)}>
            {running ? "Claude is writing…" : "Let Claude polish it"}
          </Button>
        )}
        <Button variant={canGenerate ? "secondary" : "primary"} disabled={locked || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : canGenerate ? "Save my text as it is" : "Save"}
        </Button>
        {canGenerate && (
          <Button variant="ghost" disabled={locked} onClick={() => void generate(false)}>
            Polish without showing me first
          </Button>
        )}
        <span className="text-xs text-zinc-500">
          {dirty ? "Unsaved changes." : saved ? "Saved. It's in your list of changes to publish." : ""}
          {canGenerate && ` ${claude.costNote}`}
        </span>
      </div>

      <Details summary="Page settings (technical)">
        <p className="mb-2 text-xs text-zinc-500">
          The block between the <code className="font-mono">---</code> lines: the page&apos;s title, address, layout and other
          settings. Change it only if you know what each line does.
        </p>
        <textarea
          value={settings}
          onChange={(e) => {
            setSettings(e.target.value);
            setSaved(false);
          }}
          rows={Math.min(16, Math.max(4, settings.split("\n").length + 1))}
          spellCheck={false}
          aria-label={`Settings of ${file}`}
          className={`${inputClass} font-mono text-xs leading-relaxed`}
          disabled={locked}
        />
      </Details>

      {dirty && (
        <Details summary="Show what you've changed since the last save">
          <LiveDiff before={page.content} after={text} label="Unsaved changes" />
        </Details>
      )}
    </div>
  );
}
