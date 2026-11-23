"use client";

import { useEffect, useRef } from "react";
import type { PublishedPage } from "./site-context";

/** A page's address on the live site: the site's URL (which may end in /<repo>/) joined with the page's own address. */
export function liveLink(siteUrl: string | null, address: string | null) {
  if (!siteUrl || !address) return null;
  return `${siteUrl.replace(/\/+$/, "")}${address.startsWith("/") ? address : `/${address}`}`;
}

/**
 * After the top bar's Publish: the pages that went live, each with its link, in a list of fixed
 * height so a big publish doesn't push the window off the screen.
 */
export function PublishedPages({ pages, siteUrl, onClose }: { pages: PublishedPage[]; siteUrl: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="published-pages-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800"
    >
      <div className="p-6">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-emerald-50 text-lg text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300">
            ✓
          </span>
          <div>
            <h2 id="published-pages-title" className="text-lg font-semibold">
              Published
            </h2>
            <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
              {pages.length === 1 ? "The page you worked on is" : `The ${pages.length} pages you worked on are`} going live. Your site updates in
              about a minute.
            </p>
          </div>
        </div>

        <ul className="mt-5 h-60 divide-y divide-zinc-100 overflow-y-auto overscroll-contain rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {pages.map((page) => {
            const href = liveLink(siteUrl, page.address);
            return (
              <li key={page.file} className="flex items-center gap-3 px-4 py-3">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                    <path d="M14 3v5h5" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{page.title}</p>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                      {href.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    <p className="truncate text-xs text-zinc-500">{page.address ?? "Address not known yet"}</p>
                  )}
                </div>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 cursor-pointer rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    Open ↗
                  </a>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="h-9 cursor-pointer rounded-[10px] bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
