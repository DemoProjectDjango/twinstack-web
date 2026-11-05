"use client";

import { useEffect, useRef, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { readAsBase64 } from "@/lib/setup";
import { ApiError, api, workspacePath, type RepoFiles, type RepoFolder, type WorkspaceStatus } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { OUT_OF_CREDITS, reasonOf } from "./OriginalPages";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Section, inputClass } from "./ui";

// Adding files to the site's repo (server/src/repo-files.js): its folders on the left, the chosen
// one on the right, with new folders and uploads. Git keeps no empty folders, so a new folder lives
// here until a file goes into it; the server then makes it. An HTML file asks first (HtmlChoice):
// a page, through the kept-styles conversion, with its own header and footer or the site's, or a
// plain file published as it is, which a search console's verification file has to be.

type Result = { name: string; address?: string; replaced?: boolean; asPage?: boolean; error?: unknown };
type HtmlAnswer = { asPage: boolean; chrome: "site" | "own" };
type Prepared = { page: string; source: string; css: string[]; js: string[]; address: string; created: boolean; assets: { name: string; folder: string }[]; status: WorkspaceStatus };

const isHtml = (file: File) => /\.html?$/i.test(file.name);
// Verification files are tiny and must stay exactly as they are.
const looksLikeVerification = (file: File) => /^(google[0-9a-z]+|BingSiteAuth|yandex_[0-9a-z]+)\.html?$/i.test(file.name) || file.size < 200;
const addressFor = (name: string) => {
  const base = cleanFolderName(name.replace(/\.html?$/i, "")).toLowerCase();
  return base === "index" ? "/" : `/${base}.html`;
};

/** A folder name that's safe in a web address, the way the server cleans a file's. */
const cleanFolderName = (raw: string) =>
  raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** The folders with the new ones (paths, not on the server yet) added where they belong. */
function withNewFolders(folders: RepoFolder[], added: string[]) {
  const copy = (list: RepoFolder[]): RepoFolder[] => list.map((f) => ({ ...f, folders: copy(f.folders) }));
  const root = copy(folders);
  for (const full of [...added].sort()) {
    let level = root;
    let at = "";
    for (const part of full.split("/")) {
      at = at ? `${at}/${part}` : part;
      let found = level.find((f) => f.path === at);
      if (!found) {
        found = { name: part, path: at, locked: null, files: [], folders: [], isNew: true };
        level.push(found);
        level.sort((a, b) => a.name.localeCompare(b.name));
      }
      level = found.folders;
    }
  }
  return root;
}

function findFolder(folders: RepoFolder[], wanted: string): RepoFolder | null {
  for (const folder of folders) {
    if (folder.path === wanted) return folder;
    const inner = findFolder(folder.folders, wanted);
    if (inner) return inner;
  }
  return null;
}

const parentsOf = (full: string) => full.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"));

export function FilesPanel() {
  const { owner, repo, busy, version, overview, claude, setStatus, refresh, runAndWait, showOnSite } = useSite();
  const [asking, setAsking] = useState<{ file: File; answer: (choice: HtmlAnswer | null) => void } | null>(null);
  const [listing, setListing] = useState<RepoFiles | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [selected, setSelected] = useState("static");
  const [open, setOpen] = useState<Set<string>>(new Set(["assets", "static"]));
  const [uploading, setUploading] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = useRef(0);
  useEffect(() => {
    const id = ++load.current;
    api<RepoFiles>(workspacePath(owner, repo, "/files"))
      .then((files) => id === load.current && setListing(files))
      .catch((err) => id === load.current && setError(err));
  }, [owner, repo, version]);

  const folders = listing ? withNewFolders(listing.folders, added) : [];
  const folder = findFolder(folders, selected);

  function select(path: string) {
    setSelected(path);
    setResults([]);
    setOpen((now) => new Set([...now, path, ...parentsOf(path)]));
  }

  function addFolder(name: string) {
    const path = `${selected}/${name}`;
    setAdded((now) => [...now, path]);
    select(path);
  }

  async function upload(files: File[]) {
    if (!folder || folder.locked || !files.length || !listing) return;
    const done: Result[] = [];
    setResults([]);
    setError(null);
    let status: WorkspaceStatus | null = null;

    // Each HTML file is asked about first, so what's chosen decides what the rest of the files are for.
    const pages: { file: File; html: string; chrome: HtmlAnswer["chrome"] }[] = [];
    const plain: File[] = files.filter((file) => !isHtml(file));
    for (const file of files.filter(isHtml)) {
      const choice = await new Promise<HtmlAnswer | null>((answer) => setAsking({ file, answer }));
      setAsking(null);
      if (choice?.asPage) pages.push({ file, html: await file.text(), chrome: choice.chrome });
      else if (choice) plain.push(file);
    }

    // Files a page asks for by name go with it; the rest go in the chosen folder.
    const usedByPage = (file: File, page: { html: string }) => page.html.includes(file.name);
    const isCode = (file: File) => /\.(css|m?js)$/i.test(file.name);
    const withPages = new Set<File>();
    for (const page of pages) for (const file of plain) if (usedByPage(file, page)) withPages.add(file);
    // A stylesheet's own images and fonts are only known once it's read.
    const sheets = await Promise.all([...withPages].filter((file) => /\.css$/i.test(file.name)).map((file) => file.text()));
    for (const file of plain) if (sheets.some((css) => css.includes(file.name))) withPages.add(file);

    for (const { file, html, chrome } of pages) {
      setUploading(`${file.name} as a page. This can take a few minutes`);
      let created: string | null = null;
      try {
        const linked = plain.filter((other) => withPages.has(other) && (usedByPage(other, { html }) || !isCode(other)));
        const code = linked.filter(isCode);
        const sourceOf = (ending: RegExp) => Promise.all(code.filter((f) => ending.test(f.name)).map(async (f) => ({ name: f.name, content: await f.text() })));
        const body = { name: file.name, content: html, css: await sourceOf(/\.css$/i), js: await sourceOf(/\.m?js$/i), assets: linked.filter((f) => !isCode(f)).map((f) => f.name) };
        const path = workspacePath(owner, repo, "/files/page");
        let prepared: Prepared;
        try {
          prepared = await api<Prepared>(path, { method: "POST", body });
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
          const replace = await confirmModal(`${err.message} Do you want to carry on? You can undo it from What's changed until you publish.`, { title: "Replace this page?", confirmLabel: "Replace the page", danger: true });
          if (!replace) continue;
          prepared = await api<Prepared>(path, { method: "POST", body: { ...body, replace: true } });
        }
        status = prepared.status;
        if (prepared.created) created = prepared.page;
        // What the page uses goes where it looks for it; a file already there stays.
        for (const asset of prepared.assets) {
          const match = linked.find((f) => cleanFolderName(f.name) === asset.name || f.name === asset.name);
          if (!match) continue;
          await api(workspacePath(owner, repo, "/files"), { method: "POST", body: { folder: asset.folder, name: match.name, data: await readAsBase64(match) } }).catch((err) => {
            if (!(err instanceof ApiError) || err.status !== 409) throw err;
          });
        }
        const job = await runAndWait("page-convert", { page: prepared.page, source: prepared.source, keepStyles: true, css: prepared.css, js: prepared.js, chrome, dryRun: false });
        if (job.status !== "succeeded") throw new Error(OUT_OF_CREDITS.test(job.output) ? "You've used all your AI credits. Buy more, then try again." : reasonOf(job.output));
        created = null;
        done.push({ name: file.name, address: prepared.address, asPage: true });
      } catch (err) {
        done.push({ name: file.name, error: err });
      }
      // A page that was never written shouldn't stay as an empty page.
      if (created) await api(`${workspacePath(owner, repo, "/pages/source")}?file=${encodeURIComponent(created)}`, { method: "DELETE" }).catch(() => {});
      setResults([...done]);
    }

    for (const file of plain.filter((other) => !withPages.has(other))) {
      setUploading(file.name);
      try {
        if (file.size > listing.maxBytes) throw new Error(`${file.name} is over ${formatSize(listing.maxBytes)}. Files that large are better kept elsewhere and linked to.`);
        const data = await readAsBase64(file);
        const send = (replace: boolean) =>
          api<{ saved: { name: string; address: string; replaced: boolean }; status: WorkspaceStatus }>(workspacePath(owner, repo, "/files"), {
            method: "POST",
            body: { folder: folder.path, name: file.name, data, replace },
          });
        let result;
        try {
          result = await send(false);
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
          const replace = await confirmModal(`${err.message} Do you want to replace it with the one you chose?`, { title: "Replace this file?", confirmLabel: "Replace" });
          if (!replace) continue;
          result = await send(true);
        }
        status = result.status;
        done.push({ name: result.saved.name, address: result.saved.address, replaced: result.saved.replaced });
      } catch (err) {
        done.push({ name: file.name, error: err });
      }
      setResults([...done]);
    }
    setUploading(null);
    if (status) setStatus(status);
    if (pages.length) await refresh();
    // New folders that now have a file are real: the server's list has them.
    const fresh = await api<RepoFiles>(workspacePath(owner, repo, "/files")).catch(() => null);
    if (fresh) {
      setListing(fresh);
      setAdded((now) => now.filter((path) => !findFolder(fresh.folders, path)));
    }
  }

  /** The question before removing: what goes, what still uses it, and that it can be undone. */
  async function confirmRemoval(what: { title: string; text: string; label: string; address: string; page?: string }) {
    const query = new URLSearchParams({ address: what.address, ...(what.page ? { page: what.page } : {}) });
    const { usedBy } = await api<{ usedBy: string[] }>(`${workspacePath(owner, repo, "/file-usage")}?${query}`);
    return confirmModal(
      <>
        <span className="block">{what.text}</span>
        {usedBy.length > 0 && (
          <span className="mt-3 block rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <b className="block font-medium">Still in use by {usedBy.join(", ")}.</b>
            Those links or images would stop working, and a link to something missing stops your site from publishing until it&apos;s fixed.
          </span>
        )}
        <span className="mt-3 block">You can undo this on What&apos;s changed until you publish.</span>
      </>,
      { title: what.title, confirmLabel: what.label, danger: true },
    );
  }

  /** Runs a removal, then shows the folders as they are now; a folder left empty is gone, so its parent opens. */
  async function removeThen(request: () => Promise<{ status: WorkspaceStatus }>) {
    setError(null);
    setResults([]);
    setRemoving(true);
    try {
      const { status } = await request();
      setStatus(status);
      const fresh = await api<RepoFiles>(workspacePath(owner, repo, "/files"));
      setListing(fresh);
      const known = withNewFolders(fresh.folders, added);
      let at = selected;
      while (at.includes("/") && !findFolder(known, at)) at = at.slice(0, at.lastIndexOf("/"));
      setSelected(at);
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(false);
    }
  }

  async function removeFile(file: RepoFolder["files"][number]) {
    if (!folder) return;
    try {
      const ok = await confirmRemoval({
        title: `Remove ${file.name}?`,
        text: /\.html?$/i.test(file.name) ? `This plain HTML file comes off your site, so ${file.address} stops working once you publish.` : `It comes off your site, so ${file.address} stops working once you publish.`,
        label: "Remove file",
        address: file.address,
      });
      if (!ok) return;
    } catch (err) {
      return setError(err);
    }
    await removeThen(() => api<{ status: WorkspaceStatus }>(`${workspacePath(owner, repo, "/files")}?file=${encodeURIComponent(`${folder.path}/${file.name}`)}`, { method: "DELETE" }));
  }

  async function removePage(page: RepoFiles["pages"][number]) {
    try {
      const ok = await confirmRemoval({
        title: `Remove "${page.title}"?`,
        text: `This page comes out of Pages and off your site, so ${page.address} stops working once you publish. Any images it used stay in your files.`,
        label: "Remove page",
        address: page.address,
        page: page.file,
      });
      if (!ok) return;
    } catch (err) {
      return setError(err);
    }
    await removeThen(() => api<{ status: WorkspaceStatus }>(`${workspacePath(owner, repo, "/files/page")}?file=${encodeURIComponent(page.file)}`, { method: "DELETE" }));
    await refresh();
  }

  const working = busy || uploading !== null || removing;
  return (
    <Section
      title="Files"
      description="Add files to your site, such as a PDF to download, a price list or a Google verification file. Choose a folder, make a new one if you like, then upload. They go live when you publish."
    >
      <ErrorText error={error} />
      {!listing ? (
        !error && <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label="Folders" className="max-h-128 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
            <FolderTree
              folders={folders}
              selected={selected}
              open={open}
              onSelect={select}
              onToggle={(path) =>
                setOpen((now) => {
                  const next = new Set(now);
                  if (!next.delete(path)) next.add(path);
                  return next;
                })
              }
            />
          </nav>
          {folder && (
            <FolderView
              key={folder.path}
              folder={folder}
              disabled={working}
              uploading={uploading}
              results={results}
              maxBytes={listing.maxBytes}
              onAddFolder={addFolder}
              onUpload={upload}
              onSeePage={showOnSite}
              onRemove={removeFile}
            />
          )}
        </div>
      )}
      {listing && listing.pages.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-semibold">Pages made from HTML files</h4>
          <p className="mt-1 text-xs text-zinc-500">Removing one here also takes it out of Pages.</p>
          <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {listing.pages.map((page) => (
              <li key={page.file} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-sm">{page.title}</p>
                  <p className="truncate font-mono text-xs text-zinc-500">{page.address}</p>
                </div>
                <Button onClick={() => showOnSite(page.address)}>See it</Button>
                {page.home ? (
                  <span className="px-3 text-xs text-zinc-500">Your homepage</span>
                ) : (
                  <Button variant="ghost" disabled={working} className="text-zinc-500" onClick={() => removePage(page)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {asking && (
        <HtmlChoice
          key={asking.file.name}
          file={asking.file}
          folder={selected}
          canConvert={Boolean(overview?.features.pageConvert && overview.features.pageConvertStyles)}
          canKeepOwn={Boolean(overview?.features.pageConvertOwnChrome)}
          aiReady={claude.ready}
          onAnswer={asking.answer}
        />
      )}
    </Section>
  );
}

/** What an uploaded HTML file is: a page (with which header and footer) or a plain file. */
function HtmlChoice({
  file,
  folder,
  canConvert,
  canKeepOwn,
  aiReady,
  onAnswer,
}: {
  file: File;
  folder: string;
  canConvert: boolean;
  canKeepOwn: boolean;
  aiReady: boolean;
  onAnswer: (choice: HtmlAnswer | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pageOffered = canConvert && aiReady;
  const [asPage, setAsPage] = useState(pageOffered && !looksLikeVerification(file));
  const [chrome, setChrome] = useState<HtmlAnswer["chrome"]>("site");
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  const option = "flex cursor-pointer items-start gap-2.5 rounded-lg border border-zinc-200 p-3 text-sm has-checked:border-foreground has-disabled:cursor-not-allowed has-disabled:opacity-60 dark:border-zinc-800";
  const note = "mt-0.5 block text-xs text-zinc-500";

  return (
    <dialog
      ref={dialog}
      aria-labelledby="html-choice-title"
      onCancel={(e) => {
        e.preventDefault();
        onAnswer(null);
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-zinc-200 bg-background p-6 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800"
    >
      <h2 id="html-choice-title" className="break-all text-lg font-semibold">
        How should {file.name} be added?
      </h2>
      <fieldset className="mt-4 space-y-2">
        <legend className="sr-only">Add it as</legend>
        <label className={option}>
          <input type="radio" name="html-as" checked={asPage} disabled={!pageOffered} onChange={() => setAsPage(true)} className="mt-0.5" />
          <span>
            <b className="font-medium">Add it as a page</b>
            <span className={note}>
              {!canConvert
                ? "This site needs the latest site update for this."
                : !aiReady
                  ? "This needs AI credits, and you have none left."
                  : `It appears in Pages at ${addressFor(file.name)}, looking as it does now. You can edit it, and your scripts run on it. It uses a few AI credits and can take a few minutes.`}
            </span>
          </span>
        </label>
        <label className={option}>
          <input type="radio" name="html-as" checked={!asPage} onChange={() => setAsPage(false)} className="mt-0.5" />
          <span>
            <b className="font-medium">Keep it as a plain file</b>
            <span className={note}>Published exactly as it is, in {folder}/. It isn&apos;t listed in Pages. Choose this for a Google or Bing verification file.</span>
          </span>
        </label>
      </fieldset>

      {asPage && (
        <fieldset className="mt-5 space-y-2">
          <legend className="text-sm font-semibold">Its header and footer</legend>
          <label className={option}>
            <input type="radio" name="html-chrome" checked={chrome === "site"} onChange={() => setChrome("site")} className="mt-0.5" />
            <span>
              <b className="font-medium">Use my site&apos;s</b>
              <span className={note}>The page&apos;s own are removed, so it has the same menu as the rest of your site and follows any changes to it.</span>
            </span>
          </label>
          <label className={option}>
            <input type="radio" name="html-chrome" checked={chrome === "own"} disabled={!canKeepOwn} onChange={() => setChrome("own")} className="mt-0.5" />
            <span>
              <b className="font-medium">Keep this page&apos;s own</b>
              <span className={note}>{canKeepOwn ? "It keeps the ones in the file, on this page only. The rest of your site doesn't change." : "This site needs the latest site update for this."}</span>
            </span>
          </label>
        </fieldset>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" className="text-zinc-500" onClick={() => onAnswer(null)}>
          Don&apos;t add it
        </Button>
        <Button variant="primary" onClick={() => onAnswer({ asPage, chrome })}>
          {asPage ? "Add the page" : "Add the file"}
        </Button>
      </div>
    </dialog>
  );
}

function FolderTree({
  folders,
  selected,
  open,
  onSelect,
  onToggle,
  depth = 0,
}: {
  folders: RepoFolder[];
  selected: string;
  open: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  depth?: number;
}) {
  return (
    <ul role={depth ? "group" : "tree"}>
      {folders.map((folder) => {
        const isOpen = open.has(folder.path);
        return (
          <li key={folder.path} role="treeitem" aria-expanded={folder.folders.length ? isOpen : undefined} aria-selected={folder.path === selected}>
            <div
              className={`flex items-center gap-0.5 rounded ${folder.path === selected ? "bg-zinc-200 dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
              style={{ paddingLeft: `${depth * 0.875}rem` }}
            >
              {folder.folders.length ? (
                <button type="button" onClick={() => onToggle(folder.path)} aria-label={`${isOpen ? "Close" : "Open"} ${folder.name}`} className="grid size-6 shrink-0 place-items-center text-zinc-500">
                  <svg viewBox="0 0 16 16" className={`size-3 transition-transform ${isOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : (
                <span className="size-6 shrink-0" />
              )}
              <button type="button" onClick={() => onSelect(folder.path)} className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-sm ${folder.locked ? "text-zinc-400 dark:text-zinc-600" : ""}`}>
                <span className="truncate">{folder.name}</span>
                {folder.isNew && <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">new</span>}
                {folder.locked && (
                  <svg viewBox="0 0 16 16" className="ml-auto size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" role="img" aria-label="Locked">
                    <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
                    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
                  </svg>
                )}
              </button>
            </div>
            {isOpen && folder.folders.length > 0 && <FolderTree folders={folder.folders} selected={selected} open={open} onSelect={onSelect} onToggle={onToggle} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

function FolderView({
  folder,
  disabled,
  uploading,
  results,
  maxBytes,
  onAddFolder,
  onUpload,
  onSeePage,
  onRemove,
}: {
  folder: RepoFolder;
  disabled: boolean;
  uploading: string | null;
  results: Result[];
  maxBytes: number;
  onAddFolder: (name: string) => void;
  onUpload: (files: File[]) => void;
  onSeePage: (address: string) => void;
  onRemove: (file: RepoFolder["files"][number]) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cleaned = cleanFolderName(name);
  const taken = folder.folders.some((f) => f.name.toLowerCase() === cleaned.toLowerCase());

  function create() {
    if (!cleaned || taken) return;
    onAddFolder(cleaned);
    setName("");
    setNaming(false);
  }

  const place = folder.path === "static" || folder.path.startsWith("static/") ? `/${folder.path.slice("static/".length)}` : `/${folder.path}`;
  const addressHint = folder.path === "static" ? "/" : `${place}/`;

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h4 className="break-all font-mono text-sm font-medium">{folder.path}/</h4>
        {folder.locked ? null : (
          <p className="mt-1 text-xs text-zinc-500">
            Files here are at <code className="font-mono">{addressHint}your-file.pdf</code> on your site.
          </p>
        )}
      </div>

      {folder.locked ? (
        <Notice>{folder.locked}</Notice>
      ) : (
        <>
          {folder.isNew && !folder.files.length && <Notice>This folder is saved once it has a file in it. Upload one below.</Notice>}

          <label
            onDragOver={(e) => {
              e.preventDefault();
              if (!disabled) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!disabled) onUpload([...e.dataTransfer.files]);
            }}
            className={`block cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition ${dragging ? "border-foreground bg-zinc-50 dark:bg-zinc-900" : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700"} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <input
              ref={input}
              type="file"
              multiple
              disabled={disabled}
              className="sr-only"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (input.current) input.current.value = "";
                onUpload(files);
              }}
            />
            {uploading ? (
              <span>Adding {uploading}…</span>
            ) : (
              <>
                <span className="font-medium">Choose files</span> <span className="text-zinc-500">or drop them here</span>
                <span className="mt-1 block text-xs text-zinc-500">Up to {formatSize(maxBytes)} each. Saved into {folder.name}/</span>
              </>
            )}
          </label>

          {results.length > 0 && (
            <ul className="space-y-1.5" aria-live="polite">
              {results.map((result, i) =>
                result.error ? (
                  <li key={i}>
                    <ErrorText error={result.error} />
                  </li>
                ) : result.asPage ? (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-green-800 dark:text-green-300">
                    <span>
                      Added {result.name} as a page at {result.address}. It&apos;s in Pages, and goes live when you publish.
                    </span>
                    <Button onClick={() => onSeePage(result.address!)}>See it</Button>
                  </li>
                ) : (
                  <li key={i} className="text-sm text-green-800 dark:text-green-300">
                    {result.replaced ? "Replaced" : "Added"} {result.name}. It goes live when you publish.
                  </li>
                ),
              )}
            </ul>
          )}

          {naming ? (
            <div>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  create();
                }}
              >
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Folder name" aria-label="New folder name" autoFocus className={`${inputClass} min-w-40 flex-1`} />
                <Button type="submit" variant="primary" disabled={!cleaned || taken}>
                  Create
                </Button>
                <Button variant="ghost" className="text-zinc-500" onClick={() => setNaming(false)}>
                  Cancel
                </Button>
              </form>
              <p className="mt-1 text-xs text-zinc-500" aria-live="polite">
                {taken ? "There's already a folder with that name here." : cleaned && cleaned !== name ? `It will be called ${cleaned}, so it works in a web address.` : "Inside " + folder.path + "/"}
              </p>
            </div>
          ) : (
            <Button disabled={disabled} onClick={() => setNaming(true)}>
              New folder
            </Button>
          )}

          {folder.files.length > 0 ? (
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {folder.files.map((file) => (
                <li key={file.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm">{file.name}</p>
                    <p className="truncate font-mono text-xs text-zinc-500">{file.address}</p>
                  </div>
                  <span className="text-xs text-zinc-500">{formatSize(file.size)}</span>
                  <Button
                    onClick={async () => {
                      await navigator.clipboard.writeText(file.address);
                      toast.success("Address copied");
                    }}
                  >
                    Copy address
                  </Button>
                  <Button variant="ghost" disabled={disabled} className="text-zinc-500" onClick={() => onRemove(file)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            !folder.isNew && <p className="text-sm text-zinc-500">No files directly in this folder yet.</p>
          )}
        </>
      )}
    </div>
  );
}
