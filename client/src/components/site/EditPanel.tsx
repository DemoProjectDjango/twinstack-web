"use client";

import Link from "next/link";
import { useState } from "react";
import { api, workspaceImageUrl, workspacePath, type HtmlSource, type WorkspaceStatus } from "@/lib/site-api";
import { DraftEditor } from "./DraftEditor";
import { ImagePicker } from "./ImagePicker";
import { ProposalReview } from "./ProposalReview";
import { useSite, type PageEditMode } from "./site-context";
import { Button, Details, ErrorText, Field, Notice, Section, Segmented, inputClass } from "./ui";

const MAX_IMAGES = 6;
// The site script's own limit.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_CSS_FILES = 10;

const MODES: { id: PageEditMode; label: string }[] = [
  { id: "generate", label: "Write it yourself" },
  { id: "edit", label: "Ask Claude to change it" },
  { id: "convert", label: "Bring in a page from another website" },
];

/**
 * The Content tab of the page editor: the page's own draft (written by hand, finished by
 * Claude if wanted), a plain-English instruction, or an uploaded web page to convert, then
 * Claude's proposal to check before it's kept.
 */
export function PageContentEditor({ file, initialMode }: { file: string; initialMode: PageEditMode }) {
  const { claude, confirmDiscardDraft } = useSite();
  const [mode, setMode] = useState<PageEditMode>(initialMode);

  // Leaving the draft editor may lose unsaved text.
  async function changeMode(next: PageEditMode) {
    if (next !== mode && (mode !== "generate" || (await confirmDiscardDraft()))) setMode(next);
  }

  return (
    <div className="space-y-6">
      <Segmented label="How to work on the page" value={mode} onChange={changeMode} options={MODES.map((m) => ({ value: m.id, label: m.label }))} />

      {!claude.ready && (
        <Notice>
          {mode === "generate" ? "You can write and save this page yourself. " : "This needs Claude. "}
          <Link href={claude.setupHref} className="font-medium underline">
            {claude.setupLabel}
          </Link>{" "}
          to let Claude write and change pages for you.
        </Notice>
      )}

      {mode === "generate" ? (
        <DraftEditor file={file} />
      ) : mode === "edit" ? (
        <InstructionEditor file={file} />
      ) : (
        <ConvertEditor file={file} />
      )}

      <ProposalReview />
    </div>
  );
}

/** Too old for a feature, with the files that would fix it for whoever looks after the site. */
function OldToolsNotice({ children, files }: { children: React.ReactNode; files: string }) {
  return (
    <Notice tone="warning">
      {children}
      <span className="mt-1 block text-xs opacity-80">Technical: update {files} from the template.</span>
    </Notice>
  );
}

/** Change one markdown file outside content/ (the site tree, the schedule, the docs) from an instruction. Not offered at the moment. */
export function MarkdownEditor() {
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
          copy is replaced. The change stays unpublished until you publish it.
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
  const { overview, busy, run, claude, job } = useSite();
  const [file, setFile] = useState("");
  const [instruction, setInstruction] = useState("");

  const files = overview?.markdownFiles ?? [];
  const disabled = busy || !claude.ready;
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
          <span className="text-xs text-zinc-500">{claude.costNote}</span>
        </div>
      </div>
    </Section>
  );
}

/** Change one page from a plain-English instruction, optionally with images to place. */
function InstructionEditor({ file }: { file: string }) {
  const { owner, repo, overview, busy, run, claude, job } = useSite();
  const [instruction, setInstruction] = useState("");
  const [images, setImages] = useState<string[]>([]);

  const supportsImages = overview?.features.pageEditImages ?? true;

  function addImage(entry: string) {
    setImages((prev) => (prev.includes(entry) || prev.length >= MAX_IMAGES ? prev : [...prev, entry]));
  }

  function startEdit(dryRun: boolean) {
    void run("page-edit", { page: file, instruction, images: supportsImages ? images : [], dryRun });
  }

  const disabled = busy || !claude.ready;
  const ready = Boolean(file) && Boolean(instruction.trim());
  const previewRunning = job?.command === "page-edit" && job.status === "running";

  return (
    <>
      {!supportsImages && (
        <OldToolsNotice files="scripts/edit-page.js and scripts/lib/claude-writer.js">
          Your site&apos;s tools are too old for adding photos here or seeing Claude&apos;s version before it&apos;s kept.
        </OldToolsNotice>
      )}

      <Section
        title="Ask Claude to change this page"
        description="Say what you'd like changed, in your own words. You can add photos for Claude to place. You'll see Claude's version before anything is kept."
      >
        <div className="space-y-4">
          <Field label="What should change?">
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
                Photos (optional, up to {MAX_IMAGES})
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
                  hint="Claude looks at each photo, places it and describes it for people who can't see it."
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={disabled || !ready} onClick={() => startEdit(true)}>
              {previewRunning ? "Claude is working…" : "Show me Claude's version"}
            </Button>
            <Button variant="ghost" disabled={disabled || !ready} onClick={() => startEdit(false)}>
              Change it without showing me first
            </Button>
            <span className="text-xs text-zinc-500">{claude.costNote}</span>
          </div>
        </div>
      </Section>
    </>
  );
}

/** Whose header and footer the site shows after a conversion: its own, or the page's (both or one). */
type ChromeChoice = "site" | "both" | "header" | "footer";

/**
 * Whether a saved page has its own header (a <header>, a <nav> or a navbar before its main heading)
 * and footer (a <footer>, or an element with a footer class or id). A quick look, to offer the
 * choice; the site's scripts/lib/html-source.js decides what is copied.
 */
function chromeIn(html: string) {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  const start = body.search(/<main\b|<h1\b/i);
  const top = start >= 0 ? body.slice(0, start) : body;
  return {
    header: /<header\b|<nav\b|role\s*=\s*["']?(banner|navigation)|(class|id)\s*=\s*["'][^"']*\b(site-header|navbar|masthead|topbar)\b/i.test(top),
    footer: /<footer\b|role\s*=\s*["']?contentinfo|(class|id)\s*=\s*["'][^"']*\b(site-)?footer\b/i.test(body),
  };
}

/** Convert an existing HTML page (from an old site, say) into one of the site's pages. */
function ConvertEditor({ file }: { file: string }) {
  const { owner, repo, overview, busy, run, claude, job } = useSite();
  const [htmlFile, setHtmlFile] = useState<File | null>(null);
  const [cssFiles, setCssFiles] = useState<File[]>([]);
  // Keeping the page as it is (its HTML and CSS) is the default; markdown rewrites it in the site's design.
  const [keepStyles, setKeepStyles] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Whether the uploaded page has its own header and footer, and which of them become the site's.
  const [pageChrome, setPageChrome] = useState<{ header: boolean; footer: boolean }>({ header: false, footer: false });
  const [useChrome, setUseChrome] = useState<ChromeChoice>("site");

  const supported = overview?.features.pageConvert ?? true;
  const stylesSupported = overview?.features.pageConvertStyles ?? true;
  const scriptsSupported = overview?.features.pageConvertScripts ?? true;
  const chromeSupported = overview?.features.pageConvertChrome ?? false;
  const styled = keepStyles && stylesSupported;
  const offerChrome = styled && chromeSupported && (pageChrome.header || pageChrome.footer);
  const withHeader = offerChrome && pageChrome.header && (useChrome === "both" || useChrome === "header");
  const withFooter = offerChrome && pageChrome.footer && (useChrome === "both" || useChrome === "footer");
  const isScript = (f: File) => /\.m?js$/i.test(f.name);
  const globalSheets = overview?.globalStylesheets ?? [];
  const disabled = busy || !claude.ready || !supported;
  const ready = Boolean(file) && Boolean(htmlFile);
  const previewRunning = job?.command === "page-convert" && job.status === "running";

  function pickHtml(files: FileList | null) {
    const picked = files?.[0];
    if (!picked) return;
    if (picked.size > MAX_HTML_BYTES) {
      setError(new Error(`${picked.name} is over 2 MB.`));
      return;
    }
    setError(null);
    setHtmlFile(picked);
    setUseChrome("site");
    void picked.text().then((html) => setPageChrome(chromeIn(html)), () => setPageChrome({ header: false, footer: false }));
  }

  function pickCss(files: FileList | null) {
    const picked = Array.from(files ?? []);
    const tooBig = picked.find((f) => f.size > MAX_HTML_BYTES);
    if (tooBig) {
      setError(new Error(`${tooBig.name} is over 2 MB.`));
      return;
    }
    setError(null);
    // Stylesheets and scripts share the list, up to MAX_CSS_FILES of each.
    setCssFiles((prev) => {
      const all = [...prev.filter((f) => !picked.some((p) => p.name === f.name)), ...picked];
      return [...all.filter((f) => !isScript(f)).slice(0, MAX_CSS_FILES), ...all.filter(isScript).slice(0, MAX_CSS_FILES)];
    });
  }

  // The files are uploaded with every run, so the server always converts what's picked here.
  async function startConvert(dryRun: boolean) {
    if (!htmlFile) return;
    setError(null);
    setUploading(true);
    try {
      const saved = await api<HtmlSource>(workspacePath(owner, repo, "/html-source"), {
        method: "POST",
        body: {
          name: htmlFile.name,
          content: await htmlFile.text(),
          css: styled ? await Promise.all(cssFiles.filter((f) => !isScript(f)).map(async (f) => ({ name: f.name, content: await f.text() }))) : [],
          js: styled && scriptsSupported ? await Promise.all(cssFiles.filter(isScript).map(async (f) => ({ name: f.name, content: await f.text() }))) : [],
        },
      });
      void run("page-convert", {
        page: file,
        source: saved.source,
        keepStyles: styled,
        css: saved.css.map((c) => c.source),
        js: (saved.js ?? []).map((c) => c.source),
        withHeader,
        withFooter,
        instruction,
        dryRun,
      });
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      {!supported && (
        <OldToolsNotice files="scripts/edit-page.js and scripts/lib/html-source.js">
          Your site&apos;s tools are too old to bring in pages from other websites.
        </OldToolsNotice>
      )}

      <Section
        title="Bring in a page from another website"
        description="Upload a page saved from your old website. Claude takes out the old header, menu and footer and fits the rest into this page. Everything on this page now is replaced. You'll see the result before anything is kept."
      >
        <div className="space-y-4">
          <div>
            <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">The saved page (.html)</span>
            <FilePick
              label={htmlFile ? `${htmlFile.name} (${Math.ceil(htmlFile.size / 1024)} KB). Choose another file` : "Choose the page you saved (2 MB max)"}
              accept=".html,.htm,text/html"
              disabled={disabled || uploading}
              onPick={pickHtml}
            />
            <p className="mt-1 text-xs text-zinc-500">
              In your browser, open the old page and use File → Save page as. Photos that are already online are kept; any
              others are listed so you can add them afterwards.
            </p>
          </div>

          <Field label={styled ? "Anything to tell Claude about the title and description? (optional)" : "Anything to tell Claude? (optional)"}>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder={styled ? "Use 'Our story' as the title" : "Leave out the 'Latest news' section"}
              className={inputClass}
              disabled={disabled}
            />
          </Field>

          {offerChrome && (
            <fieldset className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <legend className="px-1 text-sm font-medium">
                This page has its own {pageChrome.header && pageChrome.footer ? "header and footer" : pageChrome.header ? "header" : "footer"}
              </legend>
              {(
                [
                  ["site", "Keep my site's header and footer", "The page's own are left out; your site's show around it, as on every other page."],
                  ...(pageChrome.header && pageChrome.footer
                    ? [["both", "Use this page's header and footer on every page", "Copied exactly as they are, with their own look and scripts, and shown on every page of your site."]]
                    : []),
                  ...(pageChrome.header ? [["header", pageChrome.footer ? "Use only its header, on every page" : "Use its header on every page", "Copied exactly as it is; your site keeps its own footer."]] : []),
                  ...(pageChrome.footer ? [["footer", pageChrome.header ? "Use only its footer, on every page" : "Use its footer on every page", "Copied exactly as it is; your site keeps its own header."]] : []),
                ] as [ChromeChoice, string, string][]
              ).map(([value, label, hint]) => (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="convert-chrome"
                    checked={useChrome === value}
                    onChange={() => setUseChrome(value)}
                    disabled={disabled}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-zinc-500">{hint}</span>
                  </span>
                </label>
              ))}
              {useChrome !== "site" && (
                <p className="text-xs text-zinc-500">
                  A copied header or footer is fixed: the menu settings on the Design screen don&apos;t change it. You can go back to
                  your site&apos;s own there at any time.
                </p>
              )}
            </fieldset>
          )}

          <Details summary="Advanced options: how it looks, stylesheets and scripts">
            <div className="space-y-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={keepStyles}
                  onChange={(e) => setKeepStyles(e.target.checked)}
                  disabled={disabled || !stylesSupported}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Keep the page looking the way it did (recommended)</span>
                  <span className="block text-xs text-zinc-500">
                    Copies the page&apos;s own layout and styling, kept to this page only, between your site&apos;s header and
                    footer.{" "}
                    {scriptsSupported
                      ? "Its scripts are kept too, and the preview checks they run without errors. "
                      : "This site's tools drop the page's scripts; update scripts/edit-page.js from the template to keep them. "}
                    Claude only writes the title and description. Untick it to have Claude rewrite the page in your site&apos;s own
                    design instead.
                  </span>
                </span>
              </label>
              {!stylesSupported && (
                <p className="text-xs text-zinc-500">
                  Your site&apos;s tools can&apos;t keep a page&apos;s look yet (technical: update scripts/edit-page.js and add
                  scripts/lib/css-scope.js from the template).
                </p>
              )}
              {styled && (
                <div>
                  <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {scriptsSupported ? "CSS and JavaScript files the page links" : "CSS files the page links"} (optional, up to{" "}
                    {MAX_CSS_FILES}{scriptsSupported ? " of each" : ""})
                  </span>
                  {cssFiles.length > 0 && (
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {cssFiles.map((f) => (
                        <li
                          key={f.name}
                          className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1 font-mono text-xs dark:border-zinc-800"
                        >
                          {f.name}
                          <button
                            type="button"
                            onClick={() => setCssFiles((prev) => prev.filter((p) => p !== f))}
                            disabled={disabled || uploading}
                            aria-label={`Remove ${f.name}`}
                            className="text-zinc-500 hover:text-foreground"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <FilePick
                    label={scriptsSupported ? "Add .css or .js files" : "Add .css files"}
                    accept={scriptsSupported ? ".css,.js,.mjs,text/css,text/javascript" : ".css,text/css"}
                    multiple
                    disabled={disabled || uploading || cssFiles.length >= MAX_CSS_FILES * (scriptsSupported ? 2 : 1)}
                    onPick={pickCss}
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    A saved page usually links its stylesheet and scripts rather than including them. Upload those files under
                    the names the page links them by (e.g. <code className="font-mono">style.css</code>,{" "}
                    <code className="font-mono">main.js</code>). Stylesheets and scripts from a full URL (a CDN such as Font
                    Awesome) are brought in from it without uploading. The preview lists any linked file that&apos;s missing.
                  </p>
                  {globalSheets.length > 0 && (
                    <p className="mt-2 text-xs text-zinc-500">
                      Shared stylesheets from the site plan are applied, without uploading them, to a page that links them:{" "}
                      {globalSheets.map((g, i) => (
                        <span key={g.file}>
                          {i > 0 && ", "}
                          <code className="font-mono">{g.path}</code>
                          {!g.exists && " (not created yet)"}
                        </span>
                      ))}
                      . Uploading a file with the same name replaces the stored one for every page you bring in after this.
                    </p>
                  )}
                </div>
              )}
            </div>
          </Details>

          <ErrorText error={error} />

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={disabled || uploading || !ready} onClick={() => void startConvert(true)}>
              {uploading ? "Uploading…" : previewRunning ? "Claude is working…" : "Show me the result"}
            </Button>
            <Button variant="ghost" disabled={disabled || uploading || !ready} onClick={() => void startConvert(false)}>
              Replace it without showing me first
            </Button>
            <span className="text-xs text-zinc-500">{claude.costNote}</span>
          </div>
        </div>
      </Section>
    </>
  );
}

/** A dashed file-picker button. */
function FilePick({
  label,
  accept,
  multiple = false,
  disabled,
  onPick,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  disabled: boolean;
  onPick: (files: FileList | null) => void;
}) {
  return (
    <label
      className={`mt-1 flex items-center justify-center rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 ${disabled ? "opacity-50" : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"}`}
    >
      {label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          onPick(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
  );
}
