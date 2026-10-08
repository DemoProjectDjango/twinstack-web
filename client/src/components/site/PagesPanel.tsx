"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, isHomePage, workspacePath, type SitePage, type WorkspaceStatus } from "@/lib/site-api";
import { PageContentEditor } from "./EditPanel";
import { markVisited } from "./HomePanel";
import { PageHealth, usePageHealth } from "./PageHealth";
import { PageSeo } from "./SeoPanel";
import { useSite, type PageEditMode } from "./site-context";
import { Badge, Button, Details, EmptyState, ErrorText, Field, Notice, ScreenHeader, Segmented, inputClass } from "./ui";

const TYPES = [
  { value: "page", label: "Page", text: "A regular page, like About us or Contact." },
  { value: "post", label: "Blog post", text: "A dated article for your blog or news." },
  { value: "service", label: "Service", text: "Something you offer, with its own page." },
  { value: "product", label: "Product", text: "Something you sell, with its own page." },
  { value: "case", label: "Case study", text: "A story about work you did for a client." },
];

type Fill = "write" | "generate" | "convert";

/** The page list, the "Add a page" wizard, and the page editor for the page that's open. */
export function PagesPanel({ openPage, onClose }: { openPage: { file: string; mode: PageEditMode } | null; onClose: () => void }) {
  const { owner, repo } = useSite();

  useEffect(() => markVisited(owner, repo, "pages"), [owner, repo]);

  if (openPage) {
    return <PageEditor key={`${openPage.mode}:${openPage.file}`} file={openPage.file} mode={openPage.mode} onClose={onClose} />;
  }
  return <PageList />;
}

function PageList() {
  const { owner, repo, overview, editFile, showSection, busy, run, setStatus, refresh } = useSite();
  const [adding, setAdding] = useState(false);
  const [addingHome, setAddingHome] = useState(false);
  const [homeError, setHomeError] = useState<unknown>(null);
  const collections = overview?.collections ?? [];
  const pageCount = collections.reduce((n, c) => n + c.pages.length, 0);
  const hasHomepage = collections.some((c) => c.pages.some(isHomePage));
  // What the last build found: pages nothing links to, and pages that share an address.
  const health = usePageHealth();
  const unlinkedFiles = new Set(health.unlinked.map((p) => p.file));

  // "Add a page" can't make it: the homepage's address is "/", not its name.
  async function addHomepage() {
    setAddingHome(true);
    setHomeError(null);
    try {
      const { file, status } = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, "/pages/homepage"), { method: "POST", body: {} });
      setStatus(status);
      await refresh();
      await editFile(file, "generate");
    } catch (err) {
      setHomeError(err);
    } finally {
      setAddingHome(false);
    }
  }

  return (
    <div className="space-y-6">
      <ScreenHeader title="Pages" description="Every page on your site. Open one to write or change it.">
        {!adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            + Add a page
          </Button>
        )}
      </ScreenHeader>

      {adding && <AddPage onDone={() => setAdding(false)} />}

      {!overview && <p className="text-sm text-zinc-500">Loading…</p>}

      {overview && pageCount > 0 && !hasHomepage && (
        <Notice tone="warning">
          <span className="font-medium">Your site has no homepage,</span> the page people see first at your address. Your site can&apos;t go live
          without one.{" "}
          <Button variant="ghost" className="ml-1 underline" disabled={busy || addingHome} onClick={() => void addHomepage()}>
            {addingHome ? "Adding…" : "Add a homepage"}
          </Button>
          <ErrorText error={homeError} />
        </Notice>
      )}

      {overview && pageCount === 0 && !adding && (
        <EmptyState
          title="Your site has no pages yet"
          action={
            <>
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add a page
              </Button>
              <Button disabled={busy} onClick={() => run("scaffold", { dryRun: false, force: false })}>
                Create the starter pages
              </Button>
            </>
          }
        >
          Add your pages one at a time, or create the starter pages from the site plan in one go.
        </EmptyState>
      )}

      {pageCount > 0 && <PageHealth health={health} onOpen={(file) => void editFile(file, "generate")} />}

      {collections
        .filter((c) => c.pages.length > 0)
        .map((collection) => (
          <section key={collection.name} aria-label={collection.label}>
            <h3 className="mb-2 text-sm font-medium text-zinc-500">{collection.label}</h3>
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {sortPages(collection.pages).map((page) => (
                <li key={page.file}>
                  <button
                    type="button"
                    onClick={() => editFile(page.file, "generate")}
                    className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    <span className="font-medium">{page.title}</span>
                    {isHomePage(page) && <Badge>Homepage</Badge>}
                    {page.draft && <Badge>Hidden</Badge>}
                    {unlinkedFiles.has(page.file) && <Badge>Not linked from anywhere</Badge>}
                    <span className="truncate text-xs text-zinc-500">{pageAddress(page)}</span>
                    <span className="ml-auto text-sm text-zinc-500">Edit →</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

      {pageCount > 0 && (
        <p className="text-sm text-zinc-500">
          Need a whole new section, like Events, with its own list of pages?{" "}
          <button type="button" className="underline" onClick={() => showSection("design")}>
            Add it in Design
          </button>
          .
        </p>
      )}
    </div>
  );
}

/** The homepage first, then by title. */
function sortPages(pages: SitePage[]) {
  return [...pages].sort((a, b) => Number(isHomePage(b)) - Number(isHomePage(a)) || a.title.localeCompare(b.title));
}

function pageAddress(page: SitePage) {
  if (isHomePage(page)) return "/";
  return page.url ?? `/${page.slug}`;
}

/** Type, title and how to fill it; creating the page then opens it in the editor. */
function AddPage({ onDone }: { onDone: () => void }) {
  const { overview, busy, run, job, claude, editFile } = useSite();
  const [type, setType] = useState("page");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [draft, setDraft] = useState(false);
  const [fill, setFill] = useState<Fill>("write");
  // The pages that existed before "new" ran, to spot the one it created. Set while waiting for it.
  const [before, setBefore] = useState<Set<string> | null>(null);

  const allFiles = useMemo(() => overview?.collections.flatMap((c) => c.pages.map((p) => p.file)) ?? [], [overview]);
  const canConvert = claude.ready && (overview?.features.pageConvert ?? true);

  // Once the new page shows up in the overview, open it the way the user chose.
  // Opening it unmounts this form, so nothing needs resetting.
  const created = before ? allFiles.find((f) => !before.has(f)) : undefined;
  const failed = before !== null && job?.command === "new" && (job.status === "failed" || job.status === "cancelled");
  useEffect(() => {
    if (!created) return;
    // Writing by hand and Claude writing from notes both start in the draft editor.
    editFile(created, fill === "convert" ? "convert" : "generate");
  }, [created, fill, editFile]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const existing = new Set(allFiles);
    if (await run("new", { type, title, slug: slug || undefined, draft })) setBefore(existing);
  }

  const working = before !== null && !failed;

  return (
    <section className="space-y-5 rounded-lg border border-foreground p-5">
      <div className="flex items-center gap-3">
        <h3 className="font-semibold">Add a page</h3>
        <Button variant="ghost" className="ml-auto" disabled={working} onClick={onDone}>
          Cancel
        </Button>
      </div>

      <form onSubmit={create} className="space-y-5">
        <fieldset>
          <legend className="text-sm font-medium">1. What kind of page is it?</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {TYPES.map((t) => (
              <label
                key={t.value}
                className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${
                  type === t.value ? "border-foreground" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"
                }`}
              >
                <input type="radio" name="type" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} disabled={working} className="mt-0.5" />
                <span>
                  <span className="block font-medium">{t.label}</span>
                  <span className="block text-xs text-zinc-500">{t.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="new-page-title" className="text-sm font-medium">
            2. What&apos;s it called?
          </label>
          <input
            id="new-page-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="About us"
            className={`${inputClass} mt-2`}
            disabled={working}
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium">3. How do you want to fill it?</legend>
          <div className="mt-2 space-y-2 text-sm">
            <FillOption value="write" current={fill} onChange={setFill} disabled={working} title="I'll write it myself">
              You type the text. Claude can tidy it up afterwards if you like.
            </FillOption>
            <FillOption value="generate" current={fill} onChange={setFill} disabled={working || !claude.ready} title="Claude writes it from my notes">
              Jot down the facts, paste text or add photos, and Claude turns them into a finished page.
              {!claude.ready && (
                <>
                  {" "}
                  <Link href={claude.setupHref} className="underline">
                    {claude.setupLabel}
                  </Link>{" "}
                  to use this.
                </>
              )}
            </FillOption>
            <FillOption value="convert" current={fill} onChange={setFill} disabled={working || !canConvert} title="Bring in a page from my old website">
              Upload a page saved from another website, and Claude fits it into this one.
            </FillOption>
          </div>
        </fieldset>

        <Details summary="More options">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Web address (optional)" hint="Made from the title if you leave it empty. Lowercase letters, numbers and dashes.">
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                pattern="[a-z0-9\-]+"
                maxLength={70}
                placeholder="about-us"
                className={inputClass}
                disabled={working}
              />
            </Field>
            <label className="flex items-center gap-2 self-center text-sm">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={working} />
              Keep it hidden until I&apos;m ready
            </label>
          </div>
        </Details>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || working || !title.trim()}>
            {working ? "Creating the page…" : "Create the page"}
          </Button>
          {failed && <span className="text-sm text-red-600 dark:text-red-400">The page couldn&apos;t be created. Try a different title.</span>}
        </div>
      </form>
    </section>
  );
}

function FillOption({
  value,
  current,
  onChange,
  disabled,
  title,
  children,
}: {
  value: Fill;
  current: Fill;
  onChange: (fill: Fill) => void;
  disabled: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex gap-2 rounded-md border p-3 ${current === value ? "border-foreground" : "border-zinc-200 dark:border-zinc-800"} ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input type="radio" name="fill" checked={current === value} onChange={() => onChange(value)} disabled={disabled} className="mt-0.5" />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-zinc-500">{children}</span>
      </span>
    </label>
  );
}

/** One page: its content (written by hand or with Claude) and how it shows up in search results. */
function PageEditor({ file, mode, onClose }: { file: string; mode: PageEditMode; onClose: () => void }) {
  const { overview } = useSite();
  const [tab, setTab] = useState<"content" | "search">("content");
  // Opening the search tab checks every page's SEO, so it only mounts once asked for.
  const [searchOpened, setSearchOpened] = useState(false);
  const page = overview?.collections.flatMap((c) => c.pages).find((p) => p.file === file);
  const seoAvailable = overview?.features.seo !== false;

  return (
    <div className="space-y-6">
      <div>
        <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:underline">
          ← All pages
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight">{page?.title ?? file}</h2>
          {page && isHomePage(page) && <Badge>Homepage</Badge>}
          {page?.draft && <Badge>Hidden</Badge>}
          {page && <span className="text-sm text-zinc-500">{pageAddress(page)}</span>}
        </div>
      </div>

      {seoAvailable && (
        <Segmented
          label="Page sections"
          value={tab}
          onChange={(next) => {
            setTab(next);
            if (next === "search") setSearchOpened(true);
          }}
          options={[
            { value: "content", label: "Content" },
            { value: "search", label: "Search and sharing" },
          ]}
        />
      )}

      {/* Both stay mounted, so switching never loses unsaved text. */}
      <div hidden={tab !== "content"}>
        <PageContentEditor file={file} initialMode={mode} />
      </div>
      {seoAvailable && searchOpened && (
        <div hidden={tab !== "search"}>
          <PageSeo file={file} />
        </div>
      )}
    </div>
  );
}
