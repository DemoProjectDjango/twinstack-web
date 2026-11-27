"use client";

import { useEffect, useRef, useState } from "react";
import type { StarterKit } from "@/lib/setup";

/** Where a kit's sample site is served (server/kits/<id>/preview/, built by `npm --prefix server run kits:build`). */
const previewUrl = (kit: StarterKit, page = "/") =>
  `/api/kit-preview/${kit.id}${page === "/" ? "/" : page}`;

/**
 * The setup's "Pick a starting design" step: the starter kits (server/kits/, all free for now),
 * each with a Preview of its sample site, and, last, the AI designing the homepage from the
 * owner's answers. `value` null is the AI.
 */
export function KitPicker({
  kits,
  value,
  onChange,
}: {
  kits: StarterKit[];
  value: string | null;
  onChange: (kit: string | null) => void;
}) {
  const [previewing, setPreviewing] = useState<StarterKit | null>(null);
  const card = (selected: boolean) =>
    `rounded-xl border transition ${
      selected
        ? "border-zinc-900 ring-2 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100"
        : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-700"
    }`;
  return (
    <div className="space-y-3" role="radiogroup" aria-label="Starting design">
      {kits.map((kit) => (
        <div key={kit.id} className={card(value === kit.id)}>
          <button
            type="button"
            role="radio"
            aria-checked={value === kit.id}
            onClick={() => onChange(kit.id)}
            className="flex w-full flex-col items-start p-4 pb-2 text-left"
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="font-semibold">{kit.label}</span>
              {kit.free && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                  Free
                </span>
              )}
            </span>
            <span className="mt-1 text-sm text-zinc-500">{kit.description}</span>
            <span className="mt-2 text-xs text-zinc-500">
              {kit.pages.length} pages: {kit.pages.map((p) => p.title).join(", ")}. Ready in
              seconds, no AI needed.
            </span>
          </button>
          <div className="px-4 pb-4">
            <button
              type="button"
              onClick={() => setPreviewing(kit)}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
            >
              Preview
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        onClick={() => onChange(null)}
        className={`${card(value === null)} flex w-full flex-col items-start p-4 text-left`}
      >
        <span className="font-semibold">Let the AI design it</span>
        <span className="mt-1 text-sm text-zinc-500">
          A homepage designed from scratch for your business, from your answers. Takes a few
          minutes.
        </span>
      </button>
      {previewing && (
        <KitPreview
          kit={previewing}
          onClose={() => setPreviewing(null)}
          onUse={() => {
            onChange(previewing.id);
            setPreviewing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * A kit's sample site, full screen: its pages, at computer or phone width, with "Use this design".
 * The frame is sandboxed without allow-same-origin, like the editor's site preview.
 */
function KitPreview({ kit, onClose, onUse }: { kit: StarterKit; onClose: () => void; onUse: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(kit.pages[0]?.url ?? "/");
  const [width, setWidth] = useState<"computer" | "phone">("computer");
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  const tab = (on: boolean) =>
    `rounded-md px-3 py-1 text-sm font-medium ${on ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white" : "text-zinc-500"}`;
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        // A file picker's cancel bubbles here too: only the dialog's own (Escape) closes it.
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={`Preview of the ${kit.label} design`}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-zinc-100 p-0 backdrop:bg-black/50 dark:bg-zinc-900"
    >
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="font-semibold">{kit.label}</p>
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800" role="group" aria-label="Page">
            {kit.pages.map((p) => (
              <button key={p.url} type="button" onClick={() => setPage(p.url)} className={tab(page === p.url)} aria-pressed={page === p.url}>
                {p.title}
              </button>
            ))}
          </div>
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800" role="group" aria-label="Screen size">
            <button type="button" onClick={() => setWidth("computer")} className={tab(width === "computer")} aria-pressed={width === "computer"}>
              Computer
            </button>
            <button type="button" onClick={() => setWidth("phone")} className={tab(width === "phone")} aria-pressed={width === "phone"}>
              Phone
            </button>
          </div>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
              Close
            </button>
            <button type="button" onClick={onUse} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900">
              Use this design
            </button>
          </div>
        </div>
        <p className="bg-white px-4 pb-2 text-xs text-zinc-500 dark:bg-zinc-950">
          Sample details shown: your own name, description and contact details go in their place.
        </p>
        <div className="flex min-h-0 flex-1 justify-center overflow-auto p-4">
          <iframe
            key={page}
            title={`${kit.label}: ${kit.pages.find((p) => p.url === page)?.title ?? "page"}`}
            src={previewUrl(kit, page)}
            sandbox="allow-scripts allow-popups"
            className={`h-full rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 ${width === "phone" ? "w-[390px] shrink-0" : "w-full"}`}
          />
        </div>
      </div>
    </dialog>
  );
}
