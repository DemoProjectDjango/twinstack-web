"use client";

import { useState } from "react";
import { api, workspaceImageUrl, workspacePath, type EditMode, type HtmlSource, type WorkspaceStatus } from "@/lib/site-api";
import { DraftEditor } from "./DraftEditor";
import { ImagePicker } from "./ImagePicker";
import { PageSelect } from "./PageSelect";
import { ProposalReview } from "./ProposalReview";
import { useSite } from "./site-context";
import { Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

const MAX_IMAGES = 6;
// The site script's own limit.
const MAX_HTML_BYTES = 2 * 1024 * 1024;

/**
 * The page modes, "convert" for turning an existing HTML page into a page, and
 * "markdown" for files outside content/ (site tree, schedule, docs).
 */
type PanelMode = EditMode | "convert" | "markdown";

const MODES: { id: PanelMode; label: string }[] = [
  { id: "generate", label: "Write & generate" },
  { id: "edit", label: "Edit by instruction" },
  { id: "convert", label: "Convert HTML" },
  { id: "markdown", label: "Other markdown" },
];

export function EditPanel({ initialFile, initialMode }: { initialFile: string | null; initialMode: EditMode | null }) {
  const { hasKey, overview, confirmDiscardDraft } = useSite();
  const [mode, setMode] = useState<PanelMode>(initialMode ?? "generate");
  const [file, setFile] = useState(initialFile?.endsWith(".md") ? initialFile : "");

  // Before the overview loads it isn't known whether the copy can edit other markdown.
  const modes = MODES.filter((m) => m.id !== "markdown" || overview);

  // Both leave the draft editor, which may hold unsaved text.
  function changeMode(next: PanelMode) {
    if (next !== mode && (mode !== "generate" || confirmDiscardDraft())) setMode(next);
  }
  function changeFile(next: string) {
    if (next !== file && (mode !== "generate" || confirmDiscardDraft())) setFile(next);
  }

  return (
    <>
      {!hasKey && <Notice tone="warning">Add your Anthropic API key on the dashboard to use Claude.</Notice>}

      <div role="tablist" aria-label="How Claude works on the page" className="flex w-fit gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-800">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => changeMode(m.id)}
            className={`rounded px-3 py-1 text-sm font-medium ${mode === m.id ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "generate" ? (
        <DraftEditor file={file} onFileChange={changeFile} />
      ) : mode === "edit" ? (
        <InstructionEditor file={file} onFileChange={changeFile} />
      ) : mode === "convert" ? (
        <ConvertEditor file={file} onFileChange={changeFile} />
      ) : (
        <MarkdownEditor />
      )}

      <ProposalReview />
    </>
  );
}

/** Change one markdown file outside content/ (the site tree, the schedule, the docs) from an instruction. */
function MarkdownEditor() {
  const { overview } = useSite();
  return overview?.features.mdEdit ? <MarkdownForm /> : <InstallMdEdit />;
}

/** For copies made before scripts/edit-md.js: adds it from the template as an uncommitted change. */
function InstallMdEdit() {
  const { owner, repo, busy, setStatus, refresh } = useSite();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function install() {
    setInstalling(true);
    setError(null);
    try {
      const result = await api<{ written: string[]; status: WorkspaceStatus }>(
        workspacePath(owner, repo, "/install/md-edit"),
        { method: "POST", body: {} },
      );
      setStatus(result.status);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Section
      title="Edit a markdown file with Claude"
      description="Edit the site tree, the scaffold schedule, the predefined pages and the docs with Claude."
    >
      <div className="space-y-3">
        <Notice tone="warning">
          This site copy doesn&apos;t have <code className="font-mono">scripts/edit-md.js</code> yet. Adding it copies{" "}
          <code className="font-mono">scripts/edit-md.js</code> and <code className="font-mono">scripts/lib/schedule-jobs.js</code>{" "}
          from the template and adds the <code className="font-mono">md:edit</code> npm scripts. Nothing that&apos;s already in the
          copy is replaced. The change stays uncommitted until you publish it on the Changes tab.
        </Notice>
        <ErrorText error={error} />
        <Button variant="primary" disabled={busy || installing} onClick={() => void install()}>
          {installing ? "Adding…" : "Add markdown editing from the template"}
        </Button>
      </div>
    </Section>
  );
}

function MarkdownForm() {
  const { overview, busy, run, hasKey, job } = useSite();
  const [file, setFile] = useState("");
  const [instruction, setInstruction] = useState("");

  const files = overview?.markdownFiles ?? [];
  const disabled = busy || !hasKey;
  const ready = Boolean(file) && Boolean(instruction.trim());
  const previewRunning = job?.command === "md-edit" && job.status === "running";

  function startEdit(dryRun: boolean) {
    void run("md-edit", { file, instruction, dryRun });
  }

  return (
    <Section
      title="Edit a markdown file with Claude"
      description="For markdown outside the site's pages: the site tree, the scaffold schedule, the predefined pages in scripts/site-tree-content/ and the docs. Preview first: you'll see the complete new file below and can adjust it before applying."
    >
      <div className="space-y-4">
        <Field label="File">
          <select value={file} onChange={(e) => setFile(e.target.value)} className={inputClass} disabled={disabled}>
            <option value="">Choose a file…</option>
            {files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Instruction">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={4}
            maxLength={4000}
            placeholder="Add a careers page after faq.html with the instruction: Open roles and how to apply"
            className={inputClass}
            disabled={disabled}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={disabled || !ready} onClick={() => startEdit(true)}>
            {previewRunning ? "Asking Claude…" : "Preview change"}
          </Button>
          <Button disabled={disabled || !ready} onClick={() => startEdit(false)}>
            Apply without preview
          </Button>
          <span className="text-xs text-zinc-500">Each click is one Claude request, billed to your key.</span>
        </div>
      </div>
    </Section>
  );
}

/** Change one page from a plain-English instruction, optionally with images to place. */
function InstructionEditor({ file, onFileChange }: { file: string; onFileChange: (file: string) => void }) {
  const { owner, repo, overview, busy, run, hasKey, job } = useSite();
  const [instruction, setInstruction] = useState("");
  const [images, setImages] = useState<string[]>([]);

  const supportsImages = overview?.features.pageEditImages ?? true;

  function addImage(entry: string) {
    setImages((prev) => (prev.includes(entry) || prev.length >= MAX_IMAGES ? prev : [...prev, entry]));
  }

  function startEdit(dryRun: boolean) {
    void run("page-edit", { page: file, instruction, images: supportsImages ? images : [], dryRun });
  }

  const disabled = busy || !hasKey;
  const ready = Boolean(file) && Boolean(instruction.trim());
  const previewRunning = job?.command === "page-edit" && job.status === "running";

  return (
    <>
      {!supportsImages && (
        <Notice tone="warning">
          This site copy has an older <code className="font-mono">scripts/edit-page.js</code>, so images and the full preview
          below aren&apos;t available (the preview only appears in the Output panel on the other tabs). Update{" "}
          <code className="font-mono">scripts/edit-page.js</code> and <code className="font-mono">scripts/lib/claude-writer.js</code>{" "}
          from the template to get them.
        </Notice>
      )}

      <Section
        title="Edit a page with Claude"
        description="Pick one page, say what to change, and optionally give Claude images to look at and place in the page. Preview first: you'll see the complete new file below and can adjust it before applying."
      >
        <div className="space-y-4">
          <PageSelect value={file} onChange={onFileChange} disabled={disabled} />

          <Field label="Instruction">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Add a short 'Meet the team' section using the attached photo"
              className={inputClass}
              disabled={disabled}
            />
          </Field>

          {supportsImages && (
            <div>
              <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Images (optional, up to {MAX_IMAGES})
              </span>
              {images.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {images.map((image) => (
                    <li key={image} className="flex max-w-full items-center gap-2 rounded-md border border-zinc-200 p-1.5 pr-2 dark:border-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={/^https?:/i.test(image) ? image : workspaceImageUrl(owner, repo, image)}
                        alt=""
                        className="size-10 shrink-0 rounded object-cover"
                      />
                      <span className="max-w-56 truncate font-mono text-xs" title={image}>
                        {image}
                      </span>
                      <button
                        type="button"
                        onClick={() => setImages((prev) => prev.filter((i) => i !== image))}
                        disabled={disabled}
                        aria-label={`Remove ${image}`}
                        className="text-zinc-500 hover:text-foreground"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2">
                <ImagePicker
                  onAdd={addImage}
                  disabled={disabled}
                  room={MAX_IMAGES - images.length}
                  hint="Uploads are saved into the site under assets/img/uploads/ so the page can show them. Claude sees each image and writes alt text for it."
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={disabled || !ready} onClick={() => startEdit(true)}>
              {previewRunning ? "Asking Claude…" : "Preview change"}
            </Button>
            <Button disabled={disabled || !ready} onClick={() => startEdit(false)}>
              Apply without preview
            </Button>
            <span className="text-xs text-zinc-500">Each click is one Claude request, billed to your key.</span>
          </div>
        </div>
      </Section>
    </>
  );
}

/** Convert an existing HTML page (from an old site, say) into one of the site's pages. */
function ConvertEditor({ file, onFileChange }: { file: string; onFileChange: (file: string) => void }) {
  const { owner, repo, overview, busy, run, hasKey, job } = useSite();
  const [html, setHtml] = useState<HtmlSource | null>(null);
  const [instruction, setInstruction] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const supported = overview?.features.pageConvert ?? true;
  const disabled = busy || !hasKey || !supported;
  const ready = Boolean(file) && Boolean(html);
  const previewRunning = job?.command === "page-convert" && job.status === "running";

  async function upload(files: FileList | null) {
    const picked = files?.[0];
    if (!picked) return;
    setError(null);
    if (picked.size > MAX_HTML_BYTES) {
      setError(new Error(`${picked.name} is over 2 MB.`));
      return;
    }
    setUploading(true);
    try {
      const saved = await api<HtmlSource>(workspacePath(owner, repo, "/html-source"), {
        method: "POST",
        body: { name: picked.name, content: await picked.text() },
      });
      setHtml(saved);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }

  function startConvert(dryRun: boolean) {
    if (html) void run("page-convert", { page: file, source: html.source, instruction, dryRun });
  }

  return (
    <>
      {!supported && (
        <Notice tone="warning">
          This site copy has an older <code className="font-mono">scripts/edit-page.js</code> that can&apos;t convert HTML.
          Update <code className="font-mono">scripts/edit-page.js</code> and add{" "}
          <code className="font-mono">scripts/lib/html-source.js</code> from the template to use it.
        </Notice>
      )}

      <Section
        title="Convert an HTML page with Claude"
        description="Upload an existing HTML page and pick the page it becomes. The old site's header, footer, navigation and sidebars are removed, and the rest is converted to markdown with its wording kept. The page keeps its frontmatter, and its current body is replaced. Preview first: you'll see the complete new file below and can adjust it before applying."
      >
        <div className="space-y-4">
          <PageSelect value={file} onChange={onFileChange} disabled={disabled} />
          <p className="-mt-2 text-xs text-zinc-500">
            Converting into a new page? Create it on the Pages tab first, then pick it here.
          </p>

          <div>
            <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">HTML file</span>
            <label
              className={`mt-1 flex items-center justify-center rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 ${disabled || uploading ? "opacity-50" : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"}`}
            >
              {uploading
                ? "Uploading…"
                : html
                  ? `${html.name} (${Math.ceil(html.bytes / 1024)} KB). Choose another file`
                  : "Choose an .html file (2 MB max)"}
              <input
                type="file"
                accept=".html,.htm,text/html"
                className="sr-only"
                disabled={disabled || uploading}
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="mt-1 text-xs text-zinc-500">
              It&apos;s kept out of the site&apos;s files and never committed. Images with full URLs, or already in the site, are
              kept. Others are left out and listed, so you can upload them and add them afterwards.
            </p>
            <div className="mt-1">
              <ErrorText error={error} />
            </div>
          </div>

          <Field label="Direction (optional)">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Leave out the 'Latest news' section"
              className={inputClass}
              disabled={disabled}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={disabled || uploading || !ready} onClick={() => startConvert(true)}>
              {previewRunning ? "Asking Claude…" : "Preview conversion"}
            </Button>
            <Button disabled={disabled || uploading || !ready} onClick={() => startConvert(false)}>
              Apply without preview
            </Button>
            <span className="text-xs text-zinc-500">Each click is one Claude request, billed to your key.</span>
          </div>
        </div>
      </Section>
    </>
  );
}
