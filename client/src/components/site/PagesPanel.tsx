"use client";

import { noteFeature } from "./FeatureGuide";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { api, isHomePage, workspacePath, type NavigationInfo, type NavItem, type SitePage, type WorkspaceStatus } from "@/lib/site-api";
import { PageContentEditor } from "./EditPanel";
import { markVisited } from "./HomePanel";
import { OriginalPages } from "./OriginalPages";
import { SiteZipUpload } from "./SiteZipUpload";
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
  const { owner, repo, overview, version, editFile, showSection, busy, run, setStatus, refresh } = useSite();
  const [adding, setAdding] = useState(false);
  const [addingHome, setAddingHome] = useState(false);
  const [homeError, setHomeError] = useState<unknown>(null);
  const collections = overview?.collections ?? [];
  const pageCount = collections.reduce((n, c) => n + c.pages.length, 0);
  const hasHomepage = collections.some((c) => c.pages.some(isHomePage));
  // What the last build found: pages nothing links to, and pages that share an address.
  const health = usePageHealth();
  const unlinkedFiles = new Set(health.unlinked.map((p) => p.file));
  // The header menu and the pages that add themselves to it, for "In the menu" and the page menus.
  const [nav, setNav] = useState<NavigationInfo | null>(null);
  const [navTick, setNavTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api<NavigationInfo>(workspacePath(owner, repo, "/navigation"))
      .then((next) => !cancelled && setNav(next))
      // Without it, the list just has no menu actions.
      .catch(() => !cancelled && setNav(null));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version, navTick]);

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
          <Button
            variant="primary"
            data-tour="add-page"
            onClick={() => {
              setAdding(true);
              noteFeature("page-add");
            }}
          >
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

      <SiteZipUpload />
      <OriginalPages />

      {pageCount > 0 && <PageHealth health={health} onOpen={(file) => void editFile(file, "generate")} />}

      {pageCount > 0 && (
        <FindablePages collections={collections} nav={nav} unlinkedFiles={unlinkedFiles} onNavChanged={() => setNavTick((t) => t + 1)} onAdd={() => setAdding(true)} />
      )}

      {pageCount > 0 && (
        <p className="text-sm text-zinc-500">
          Need a whole new section, like Events, with its own list of pages?{" "}
          <button type="button" className="underline" onClick={() => showSection("design")}>
            Add it in Look &amp; logo
          </button>
          .
        </p>
      )}
    </div>
  );
}

type Collection = { name: string; label: string; pages: SitePage[] };
type PageFilter = "all" | "pages" | "posts" | "hidden";
type PageSort = "az" | "za" | "recent" | "newest";

/** A list of dated articles (a blog, news), rather than the site's main pages. */
function isPostList(collection: Collection) {
  const words = `${collection.name} ${collection.label}`.toLowerCase();
  return /blog|post|news|article|insight/.test(words) || (collection.pages.length > 0 && collection.pages.every((p) => p.date));
}

/** A date range over one of the page's dates: "changed" (last change) or "date" (a post's date). Days as YYYY-MM-DD, "" for open. */
type DateRange = { field: "changed" | "date"; from: string; to: string };
const NO_RANGE: DateRange = { field: "changed", from: "", to: "" };

/** YYYY-MM-DD of today minus `days`, in the owner's own time zone. */
function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDay(d);
}
function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whether the page's chosen date is inside the range (both ends included). A page without that date is left out. */
function inRange(page: SitePage, range: DateRange) {
  if (!range.from && !range.to) return true;
  const value = range.field === "changed" ? page.changed : page.date;
  if (!value) return false;
  // A post's date may be just "2026-08-25"; a change is a full time, compared as the owner's own day.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : Number.isNaN(Date.parse(value)) ? value.slice(0, 10) : localDay(new Date(value));
  return (!range.from || day >= range.from) && (!range.to || day <= range.to);
}

// A long list of posts shows this many until "Show all".
const FOLDED = 10;

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * Name A–Z or Z–A (the homepage first either way), the page changed most recently first, or posts by
 * their date, newest first (undated pages after them, A–Z).
 */
function sortPages(pages: SitePage[], sort: PageSort = "az") {
  const home = (a: SitePage, b: SitePage) => Number(isHomePage(b)) - Number(isHomePage(a));
  const az = (a: SitePage, b: SitePage) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
  const sorted = [...pages];
  if (sort === "recent") return sorted.sort((a, b) => time(b.changed) - time(a.changed) || az(a, b));
  if (sort === "newest") return sorted.sort((a, b) => time(b.date) - time(a.date) || az(a, b));
  if (sort === "za") return sorted.sort((a, b) => home(a, b) || az(b, a));
  return sorted.sort((a, b) => home(a, b) || az(a, b));
}

/** Whether a search matches the page: every word in its title or address. */
function matches(page: SitePage, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${page.title} ${pageAddress(page)} ${page.slug}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** `text` with the parts the search matched in bold. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-amber-200 px-0.5 text-inherit dark:bg-amber-500/40">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The header's button (like "Contact us") links to the page. */
function isMenuButton(page: SitePage, nav: NavigationInfo | null) {
  const cta = nav?.navigation.header.cta;
  if (!nav || !cta?.url) return false;
  const navPage = nav.pages.find((p) => p.file === page.file);
  return sameAddress(cta.url, navPage?.url ?? pageAddress(page));
}


/**
 * Every list of pages, with a search over all of them, filters (main pages, posts, hidden, not in
 * the menu) and a sort. A long list of posts shows its first ten until "Show all".
 */
function FindablePages({
  collections,
  nav,
  unlinkedFiles,
  onNavChanged,
  onAdd,
}: {
  collections: Collection[];
  nav: NavigationInfo | null;
  unlinkedFiles: Set<string>;
  onNavChanged: () => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PageFilter>("all");
  const [sort, setSort] = useState<PageSort>("az");
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<DateRange>(NO_RANGE);
  const [rangeOpen, setRangeOpen] = useState(false);

  const lists = collections.filter((c) => c.pages.length > 0);
  const total = lists.reduce((n, c) => n + c.pages.length, 0);
  const hasPosts = lists.some(isPostList);
  const hasMain = lists.some((c) => !isPostList(c));
  const hasHidden = lists.some((c) => c.pages.some((p) => p.draft));
  const canDate = lists.some((c) => c.pages.some((p) => p.changed));
  const hasDated = lists.some((c) => c.pages.some((p) => p.date));
  // The search is always there once the site has a page, so owners find it where they expect it.
  const showTools = total > 0 || query !== "" || filter !== "all";

  const shown = lists
    .filter((c) => (filter === "pages" ? !isPostList(c) : filter === "posts" ? isPostList(c) : true))
    .map((c) => {
      const pages = c.pages.filter(
        (p) =>
          (!query.trim() || matches(p, query)) &&
          inRange(p, range) &&
          (filter !== "hidden" || p.draft),
      );
      return { collection: c, pages: sortPages(pages, sort) };
    })
    .filter((l) => l.pages.length > 0);
  const found = shown.reduce((n, l) => n + l.pages.length, 0);
  const ranged = Boolean(range.from || range.to);
  const narrowed = query.trim() !== "" || filter !== "all" || ranged;
  const canRange = canDate || hasDated;
  // The words on the Dates button: the range chosen, or just "Dates".
  const short = (day: string) => new Date(`${day}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const rangeLabel = ranged ? (range.from && range.to ? `${short(range.from)} – ${short(range.to)}` : range.from ? `From ${short(range.from)}` : `Until ${short(range.to)}`) : "Dates";
  const presets = [
    { label: "Last 7 days", from: daysAgo(7) },
    { label: "Last 30 days", from: daysAgo(30) },
    { label: "Last 3 months", from: daysAgo(91) },
    { label: "This year", from: `${new Date().getFullYear()}-01-01` },
  ];

  const filters: { value: PageFilter; label: string; hint: string; when: boolean }[] = [
    { value: "all", label: "All pages", hint: "Every page of your site.", when: true },
    { value: "pages", label: "Main pages", hint: "Your main pages, like Home, About and Contact, without the blog posts.", when: hasPosts && hasMain },
    { value: "posts", label: "Blog posts", hint: "Only your blog posts and articles.", when: hasPosts && hasMain },
    { value: "hidden", label: "Hidden", hint: "Pages you've hidden from visitors: they're not on your live site.", when: hasHidden || filter === "hidden" },
  ];
  const chosen = filters.find((f) => f.value === filter);
  const visibleFilters = filters.filter((f) => f.when);

  return (
    <div className="space-y-5">
      {showTools && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-60">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder="Search your pages by title or address"
                aria-label="Search your pages"
                className={`${inputClass} pl-9`}
              />
            </div>
            {canRange && (
              <button
                type="button"
                aria-expanded={rangeOpen}
                onClick={() => setRangeOpen(!rangeOpen)}
                className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm ${
                  ranged ? "border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200" : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 10h18M8 3v4M16 3v4" />
                </svg>
                {rangeLabel}
              </button>
            )}
            <label className="flex items-center gap-2 text-sm text-zinc-500">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as PageSort)} className={`${inputClass} w-auto py-1.5`}>
                <option value="az">Name, A to Z</option>
                <option value="za">Name, Z to A</option>
                {canDate && <option value="recent">Last changed first</option>}
                {hasDated && <option value="newest">Newest posts first</option>}
              </select>
            </label>
          </div>
          {rangeOpen && canRange && (
            <div className="space-y-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              {canDate && hasDated && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Pages by</span>
                  <Segmented
                    label="Which date"
                    value={range.field}
                    onChange={(field) => setRange({ ...range, field })}
                    options={[
                      { value: "changed", label: "When they were last changed" },
                      { value: "date", label: "Post date" },
                    ]}
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {presets.map((preset) => {
                  const active = range.from === preset.from && !range.to;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setRange({ field: canDate ? range.field : "date", from: preset.from, to: "" })}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span className="block text-xs text-zinc-500">From</span>
                  <input
                    type="date"
                    value={range.from}
                    max={range.to || undefined}
                    onChange={(e) => setRange({ ...range, field: canDate ? range.field : "date", from: e.target.value })}
                    className={`${inputClass} w-auto py-1.5`}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-zinc-500">To</span>
                  <input
                    type="date"
                    value={range.to}
                    min={range.from || undefined}
                    onChange={(e) => setRange({ ...range, field: canDate ? range.field : "date", to: e.target.value })}
                    className={`${inputClass} w-auto py-1.5`}
                  />
                </label>
                {ranged && (
                  <Button variant="ghost" onClick={() => setRange({ ...NO_RANGE, field: range.field })}>
                    Clear dates
                  </Button>
                )}
              </div>
              <p className="text-xs text-zinc-500">
                {(canDate ? range.field : "date") === "changed"
                  ? "Shows the pages changed between these days, published or not."
                  : "Shows the blog posts dated between these days. Pages without a date are left out."}
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
            {/* "All pages" alone isn't a choice: the buttons show only when there's another one. */}
            {visibleFilters.length > 1 &&
              visibleFilters.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  title={f.hint}
                  onClick={() => setFilter(f.value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    filter === f.value
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            {narrowed && (
              <span role="status" className="ml-auto text-xs text-zinc-500">
                {found} of {total} {total === 1 ? "page" : "pages"}
              </span>
            )}
          </div>
        </div>
      )}

      {showTools && filter !== "all" && chosen && <p className="-mt-2 text-xs text-zinc-500">{chosen.hint}</p>}

      {found === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {query.trim() ? <>No page matches “{query.trim()}”.</> : ranged ? "No pages in those dates." : "No pages here."}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setQuery("");
              setFilter("all");
              setRange({ ...NO_RANGE, field: range.field });
            }}
          >
            Show all pages
          </button>
          {query.trim() && (
            <>
              {" or "}
              <button type="button" className="underline" onClick={onAdd}>
                add a new page
              </button>
            </>
          )}
          .
        </div>
      )}

      {shown.map(({ collection, pages }) => {
        const posts = isPostList(collection);
        // Searching or filtering shows every match; otherwise a long list of posts is folded.
        const folded = posts && !narrowed && !unfolded.has(collection.name) && pages.length > FOLDED;
        const visible = folded ? pages.slice(0, FOLDED) : pages;
        return (
          <section key={collection.name} aria-label={collection.label}>
            <h3 className="mb-2 flex items-baseline gap-2 text-sm font-medium text-zinc-500">
              {collectionHeading(collection.label, collections.length)}
              <span className="text-xs font-normal text-zinc-400">{pages.length}</span>
            </h3>
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {visible.map((page) => (
                <PageRow key={page.file} page={page} query={query} unlinked={unlinkedFiles.has(page.file)} nav={nav} onNavChanged={onNavChanged} />
              ))}
            </ul>
            {posts && !narrowed && pages.length > FOLDED && (
              <button
                type="button"
                className="mt-2 text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400"
                aria-expanded={!folded}
                onClick={() =>
                  setUnfolded((current) => {
                    const next = new Set(current);
                    if (next.has(collection.name)) next.delete(collection.name);
                    else next.add(collection.name);
                    return next;
                  })
                }
              >
                {folded ? `Show all ${pages.length} ▾` : "Show fewer ▴"}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function pageAddress(page: SitePage) {
  if (isHomePage(page)) return "/";
  return page.address ?? page.url ?? `/${page.slug}`;
}

/** Two addresses for one page: "/about.html" and "/about.html/", "/blog/", "/blog" and "/blog/index.html", "/" and "/index.html". */
const sameKey = (url: string) => url.replace(/\/index\.html$/i, "").replace(/\/+$/, "");
const sameAddress = (a: string | undefined, b: string) => Boolean(a) && sameKey(a!) === sameKey(b);

/** Whether the header menu links to `url`: an entry of its own, or one of a dropdown's. */
function listedInHeader(items: NavItem[], url: string) {
  return items.some((item) => sameAddress(item.url, url) || (item.children ?? []).some((child) => sameAddress(child.url, url)));
}

/** The header menu without its links to `url`. A dropdown that opened that page keeps its other links. */
function withoutLinksTo(items: NavItem[], url: string): NavItem[] {
  return items.flatMap((item) => {
    const children = item.children?.filter((child) => !sameAddress(child.url, url));
    if (!sameAddress(item.url, url)) return [children ? { ...item, children } : item];
    if (children?.length) {
      const rest: NavItem = { ...item, children };
      delete rest.url;
      return [rest];
    }
    return [];
  });
}

/** The menu and footer to save with these header links. */
function navigationWith(nav: NavigationInfo, items: NavItem[]) {
  const { appearance, ...rest } = nav.navigation;
  const navigation = { ...rest, header: { ...rest.header, items } };
  // Copies without appearance settings must not have them written.
  return nav.supportsAppearance ? { ...navigation, appearance } : navigation;
}

/**
 * One page in the list: open it on the site or in the page editor, and its ⋯ menu: put it in the
 * header menu or take it out, hide it from visitors or show it again, delete it. Each change is an
 * ordinary unpublished change, undone on What's changed until it's published.
 */
function PageRow({ page, query = "", unlinked, nav, onNavChanged }: { page: SitePage; query?: string; unlinked: boolean; nav: NavigationInfo | null; onNavChanged: () => void }) {
  const { owner, repo, overview, busy, editFile, showOnSite, setStatus, refresh } = useSite();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const home = isHomePage(page);
  const address = pageAddress(page);
  const navPage = nav?.pages.find((p) => p.file === page.file);
  const url = navPage?.url ?? address;
  const selfListed = navPage?.menu === "header" || navPage?.menu === "both";
  const listed = nav ? listedInHeader(nav.navigation.header.items, url) : false;
  const inMenu = selfListed || listed;
  // The homepage is the menu's logo link; other pages can be put in or taken out.
  const canMenu = !home && nav !== null;

  async function act(what: string, change: () => Promise<{ status: WorkspaceStatus } | void>) {
    setWorking(what);
    setError(null);
    try {
      const result = await change();
      if (result?.status) setStatus(result.status);
      await refresh();
      onNavChanged();
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  const toggleMenu = () =>
    act("menu", async () => {
      if (!nav) return;
      let status: WorkspaceStatus | undefined;
      if (inMenu) {
        if (selfListed) {
          const menu = navPage?.menu === "both" ? "footer" : null;
          status = (await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/navigation/page-menu"), { method: "PUT", body: { file: page.file, menu } })).status;
        }
        if (listed) {
          const navigation = navigationWith(nav, withoutLinksTo(nav.navigation.header.items, url));
          status = (await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/navigation"), { method: "PUT", body: { navigation, version: nav.version } })).status;
        }
      } else if (overview?.features.pageMenus && navPage) {
        // The page adds itself: it keeps its place when renamed and drops out if it's hidden or removed.
        const menu = navPage.menu === "footer" ? "both" : "header";
        status = (await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/navigation/page-menu"), { method: "PUT", body: { file: page.file, menu } })).status;
      } else {
        const navigation = navigationWith(nav, [...nav.navigation.header.items, { label: page.title, url }]);
        status = (await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/navigation"), { method: "PUT", body: { navigation, version: nav.version } })).status;
      }
      return status ? { status } : undefined;
    });

  const toggleHidden = () =>
    act("hide", () => api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/pages/draft"), { method: "PUT", body: { file: page.file, draft: !page.draft } }));

  async function remove() {
    const ok = await confirmModal(`Delete “${page.title}”? Visitors won't be able to open it. You can undo it on What's changed until you publish.`, {
      title: "Delete this page?",
      confirmLabel: "Delete page",
      danger: true,
    });
    if (!ok) return;
    await act("delete", () => api<{ status: WorkspaceStatus }>(`${workspacePath(owner, repo, "/pages/source")}?file=${encodeURIComponent(page.file)}`, { method: "DELETE" }));
  }

  const locked = busy || working !== null;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <span className="mr-2 font-medium">
            <Highlight text={page.title} query={query} />
          </span>
          <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
            {home && <Badge>Homepage</Badge>}
            {page.draft && <Badge>Hidden</Badge>}
            {inMenu && <Badge>In the menu</Badge>}
            {!inMenu && isMenuButton(page, nav) && <Badge>Menu button</Badge>}
            {unlinked && <Badge>Not linked from anywhere</Badge>}
          </span>
          <span className="block truncate text-xs text-zinc-500">
            <Highlight text={address} query={query} />
          </span>
        </div>
        <Button data-tour="page-on-site" onClick={() => showOnSite(address)}>
          Edit on site
        </Button>
        <Button onClick={() => void editFile(page.file, "generate")}>Edit page</Button>
        <Button variant="ghost" aria-expanded={open} aria-label={`More for ${page.title}`} onClick={() => setOpen(!open)}>
          ⋯
        </Button>
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
          {canMenu && (
            <Button disabled={locked} onClick={() => void toggleMenu()}>
              {working === "menu" ? "Saving…" : inMenu ? "Take out of the menu" : "Show in the menu"}
            </Button>
          )}
          {!home && (
            <Button disabled={locked} onClick={() => void toggleHidden()}>
              {working === "hide" ? "Saving…" : page.draft ? "Show to visitors" : "Hide from visitors"}
            </Button>
          )}
          {!home && (
            <Button variant="danger" disabled={locked} onClick={() => void remove()}>
              {working === "delete" ? "Deleting…" : "Delete…"}
            </Button>
          )}
          {home && <span className="text-sm text-zinc-500">The homepage is always shown, and visitors reach it from your logo.</span>}
        </div>
      )}
      <ErrorText error={error} />
    </li>
  );
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
              You type the text. The AI can tidy it up afterwards if you like.
            </FillOption>
            <FillOption value="generate" current={fill} onChange={setFill} disabled={working || !claude.ready} title="The AI writes it from my notes">
              Jot down the facts, paste text or add photos, and the AI turns them into a finished page.
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
              Upload a page saved from another website, and the AI fits it into this one.
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

/** A collection's heading in words an owner uses: its label is often just its folder ("pages", "blog"). */
function collectionHeading(label: string, count: number) {
  const name = label.trim().toLowerCase();
  if (count === 1 || name === "pages" || name === "page") return "Your pages";
  if (["blog", "posts", "post", "articles", "news"].includes(name)) return "Blog posts";
  return label.charAt(0).toUpperCase() + label.slice(1);
}
