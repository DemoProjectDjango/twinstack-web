"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isHomePage, type SitePage } from "@/lib/site-api";
import { Highlight, pageAddress } from "./PagesPanel";
import { noteFeature } from "./FeatureGuide";
import { useSite } from "./site-context";

// "Find a page": a search over every page of the site from any screen, opened with Ctrl+K (⌘K on a
// Mac) or the menu's button (FIND_PAGE_EVENT). Enter shows the page on the site to edit in place;
// the row's "Edit page" opens it in the page editor.

export const FIND_PAGE_EVENT = "twinstack:find-page";

export function openPageFinder() {
  window.dispatchEvent(new Event(FIND_PAGE_EVENT));
}

/** "Ctrl K", or "⌘K" on a Mac. */
export function finderShortcut() {
  if (typeof navigator === "undefined") return "Ctrl K";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";
}

const SHOWN = 50;

export function PageFinder() {
  const [open, setOpen] = useState(false);

  // "Learn the features" ticks Find a page off however it was opened (button or shortcut).
  useEffect(() => {
    if (open) noteFeature("find");
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(FIND_PAGE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(FIND_PAGE_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return <FinderDialog onClose={() => setOpen(false)} />;
}

function FinderDialog({ onClose }: { onClose: () => void }) {
  const { overview, showOnSite, editFile } = useSite();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const pages = useMemo(() => {
    const all = (overview?.collections ?? []).flatMap((c) => c.pages);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const found = all.filter((p) => {
      const text = `${p.title} ${pageAddress(p)} ${p.slug}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    // With no search, the pages changed most recently first: usually the one being looked for.
    const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
    return found.sort((a, b) =>
      words.length
        ? Number(b.title.toLowerCase().startsWith(words[0])) - Number(a.title.toLowerCase().startsWith(words[0])) || a.title.localeCompare(b.title)
        : Number(isHomePage(b)) - Number(isHomePage(a)) || time(b.changed) - time(a.changed) || a.title.localeCompare(b.title),
    );
  }, [overview, query]);
  const visible = pages.slice(0, SHOWN);
  const current = Math.min(active, Math.max(0, visible.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function show(page: SitePage) {
    onClose();
    showOnSite(pageAddress(page));
  }
  function edit(page: SitePage) {
    onClose();
    void editFile(page.file, "generate");
  }

  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-start justify-center bg-black/40 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Find a page"
        className="w-full max-w-lg overflow-hidden rounded-2xl bg-background shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(Math.min(current + 1, visible.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(current - 1, 0));
              } else if (e.key === "Enter" && visible[current]) {
                e.preventDefault();
                if (e.ctrlKey || e.metaKey) edit(visible[current]);
                else show(visible[current]);
              }
            }}
            placeholder="Find a page by its title or address…"
            aria-label="Find a page"
            role="combobox"
            aria-expanded
            aria-controls="page-finder-list"
            aria-activedescendant={visible[current] ? `page-finder-${current}` : undefined}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
          <kbd className="rounded border border-zinc-200 px-1.5 text-[10px] text-zinc-500 dark:border-zinc-700">Esc</kbd>
        </div>
        <ul id="page-finder-list" ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {visible.map((page, i) => (
            <li
              key={page.file}
              id={`page-finder-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === current}
              onMouseMove={() => setActive(i)}
              onClick={() => show(page)}
              className={`group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${i === current ? "bg-indigo-50 dark:bg-indigo-950/60" : ""}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  <Highlight text={page.title} query={query} />
                  {isHomePage(page) && <span className="ml-2 text-xs font-normal text-zinc-500">Homepage</span>}
                  {page.draft && <span className="ml-2 text-xs font-normal text-zinc-500">Hidden</span>}
                </span>
                <span className="block truncate text-xs text-zinc-500">
                  <Highlight text={pageAddress(page)} query={query} />
                </span>
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  edit(page);
                }}
                className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800 ${i === current ? "" : "invisible group-hover:visible"}`}
              >
                Edit page
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className="px-3 py-6 text-center text-sm text-zinc-500">{overview ? "No page matches." : "Loading your pages…"}</li>}
        </ul>
        <p className="border-t border-zinc-200 px-4 py-2 text-[11px] text-zinc-500 dark:border-zinc-800">
          {pages.length > SHOWN ? `Showing ${SHOWN} of ${pages.length}: type to narrow it down. ` : ""}↑↓ to choose · Enter to edit it on your site · {finderShortcut().startsWith("⌘") ? "⌘" : "Ctrl"}+Enter for the page editor
        </p>
      </div>
    </div>,
    document.body,
  );
}
