"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StarterKit } from "@/lib/setup";

// The setup's "Pick a starting design" step. Owners call the starter kits (server/kits/) templates:
// the step offers "Use a template", which opens the gallery (search, category filter, a card with a
// thumbnail per template, each with a full-screen Preview), or the AI designing the homepage.

/** Where a template's sample site is served (server/kits/<id>/preview/, built by `npm --prefix server run kits:build`). */
const previewUrl = (kit: StarterKit) => `/api/kit-preview/${kit.id}/`;

const ALL = "All";
// How long "Use a template" shows it's opening before the gallery comes in.
const OPENING_MS = 450;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** `value` is the chosen template's id, or null for the AI designing the homepage. */
export function KitPicker({
  kits,
  value,
  onChange,
}: {
  kits: StarterKit[];
  value: string | null;
  onChange: (kit: string | null) => void;
}) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  /** A moment of "Opening templates…" on the card, then the gallery (at once with reduced motion). */
  function openGallery() {
    if (opening) return;
    if (reducedMotion()) return setGalleryOpen(true);
    setOpening(true);
    timer.current = setTimeout(() => {
      setOpening(false);
      setGalleryOpen(true);
    }, OPENING_MS);
  }
  const chosen = kits.find((k) => k.id === value) ?? null;
  const card = (selected: boolean) =>
    `rounded-xl border transition ${
      selected
        ? "border-zinc-900 ring-2 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100"
        : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-700"
    }`;
  return (
    <div className="space-y-3" role="radiogroup" aria-label="Starting design">
      {chosen ? (
        <div
          role="radio"
          aria-checked="true"
          className={`${card(true)} flex items-center gap-4 p-3`}
        >
          <Thumbnail kit={chosen} className="w-32 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-zinc-500">Your template</p>
            <p className="font-semibold">{chosen.label}</p>
            <p className="truncate text-sm text-zinc-500">
              {chosen.description}
            </p>
          </div>
          <button
            type="button"
            onClick={openGallery}
            disabled={opening}
            className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            {opening ? <Spinner /> : "Change"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          role="radio"
          aria-checked="false"
          aria-busy={opening}
          onClick={openGallery}
          className={`${card(opening)} flex w-full cursor-pointer flex-col items-start p-4 text-left ${opening ? "scale-[0.99] bg-zinc-50 dark:bg-zinc-900" : ""}`}
        >
          <span className="flex w-full items-center justify-between gap-3">
            <span className="font-semibold">Use a template</span>
            {opening && (
              <span className="flex items-center gap-2 text-sm text-zinc-500">
                <Spinner />
                Opening templates…
              </span>
            )}
          </span>
          <span className="mt-1 text-sm text-zinc-500">
            {kits.length === 1
              ? "Preview our ready-made design and use it."
              : `Browse ${kits.length} ready-made designs, preview them and pick one.`}{" "}
            Ready in seconds, no AI needed.
          </span>
        </button>
      )}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        onClick={() => onChange(null)}
        className={`${card(value === null && !opening)} flex w-full flex-col items-start p-4 text-left cursor-pointer`}
      >
        <span className="font-semibold">Let the AI design it</span>
        <span className="mt-1 text-sm text-zinc-500">
          A homepage designed from scratch for your business, from your answers.
          Takes a few minutes.
        </span>
      </button>
      {galleryOpen && (
        <TemplateGallery
          kits={kits}
          value={value}
          onClose={() => setGalleryOpen(false)}
          onUse={(id) => {
            onChange(id);
            setGalleryOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 motion-reduce:animate-none dark:border-zinc-600 dark:border-t-white"
    />
  );
}

/** A template's card picture: its homepage's top, or a plain panel when none was built. */
function Thumbnail({
  kit,
  className = "",
}: {
  kit: StarterKit;
  className?: string;
}) {
  return (
    <div
      className={`aspect-[8/5] overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 ${className}`}
    >
      {kit.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element -- a small static picture from the API, no optimisation needed
        <img
          src={kit.thumbnail}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-zinc-400">
          {kit.label}
        </div>
      )}
    </div>
  );
}

/** Lower case, accents dropped, for matching what's typed against names, descriptions and tags. */
const fold = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The template gallery, full screen: search, category chips and a card per template. */
function TemplateGallery({
  kits,
  value,
  onClose,
  onUse,
}: {
  kits: StarterKit[];
  value: string | null;
  onClose: () => void;
  onUse: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  const [previewing, setPreviewing] = useState<StarterKit | null>(null);
  // Fades and slides in once open; its cards follow one after another.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const enter = `transition duration-300 ease-out motion-reduce:transition-none ${shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`;
  // The window itself grows in slightly as it fades in.
  const pop = `transition duration-300 ease-out motion-reduce:transition-none ${shown ? "scale-100 opacity-100" : "scale-[0.97] opacity-0"}`;

  const categories = useMemo(
    () => [
      ALL,
      ...[...new Set(kits.map((k) => k.category))].sort((a, b) =>
        a.localeCompare(b),
      ),
    ],
    [kits],
  );
  const matching = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    return kits.filter((k) => {
      if (category !== ALL && k.category !== category) return false;
      const text = fold(
        [
          k.label,
          k.description,
          k.category,
          ...k.tags,
          ...k.pages.map((p) => p.title),
        ].join(" "),
      );
      return words.every((w) => text.includes(w));
    });
  }, [kits, query, category]);
  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1 text-sm font-medium transition ${
      on
        ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900"
        : "border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-600 dark:text-zinc-300"
    }`;

  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        // Escape closes the gallery only when it's the dialog's own (the preview handles its own).
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="template-gallery-title"
      // A centred window over the dimmed page, not the whole screen.
      className={`m-auto h-[min(85dvh,900px)] max-h-none w-[calc(100%-2rem)] max-w-5xl overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 p-0 text-foreground shadow-2xl backdrop:bg-black/50 dark:border-zinc-800 dark:bg-zinc-900 ${pop}`}
    >
      <div className="flex h-full flex-col">
        <div className="border-b border-zinc-200 bg-white px-4 py-4 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center gap-3">
            <h2
              id="template-gallery-title"
              className="text-xl font-semibold tracking-tight"
            >
              Templates
            </h2>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
              className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 sm:max-w-sm dark:border-zinc-600 dark:bg-zinc-900 dark:focus:border-white"
              autoFocus
            />
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
          <div
            className="mt-3 flex flex-wrap gap-2"
            role="group"
            aria-label="Category"
          >
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={chip(category === c)}
                aria-pressed={category === c}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div>
            <p className="text-sm text-zinc-500" aria-live="polite">
              {matching.length} template{matching.length === 1 ? "" : "s"}
            </p>
            {matching.length ? (
              <ul className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {matching.map((kit, i) => (
                  <li
                    key={kit.id}
                    style={{ transitionDelay: shown ? `${Math.min(i, 8) * 60 + 120}ms` : "0ms" }}
                    className={`${enter} overflow-hidden rounded-xl border bg-white shadow-sm dark:bg-zinc-950 ${
                      value === kit.id
                        ? "border-zinc-900 ring-2 ring-zinc-900 dark:border-white dark:ring-white"
                        : "border-zinc-200 dark:border-zinc-700"
                    }`}
                  >
                    <button
                      type="button"
                      className="block w-full p-3 pb-0"
                      aria-label={`Preview ${kit.label}`}
                    >
                      {/* <button type="button" onClick={() => setPreviewing(kit)} className="block w-full p-3 pb-0" aria-label={`Preview ${kit.label}`}> */}
                      <Thumbnail kit={kit} />
                    </button>
                    <div className="p-4">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold">{kit.label}</p>
                        {kit.free && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                            Free
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs font-medium text-zinc-500">
                        {kit.category} · {kit.pages.length} page
                        {kit.pages.length === 1 ? "" : "s"}
                      </p>
                      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                        {kit.description}
                      </p>
                      <div className="mt-4 flex gap-2">
                        <button
                          type="button"
                          onClick={() => setPreviewing(kit)}
                          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          onClick={() => onUse(kit.id)}
                          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 cursor-pointer"
                        >
                          {value === kit.id ? "Selected" : "Use this template"}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-10 text-center text-sm text-zinc-500">
                <p>No templates match.</p>
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setCategory(ALL);
                  }}
                  className="mt-2 font-medium text-zinc-900 underline dark:text-white"
                >
                  Show all templates
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {previewing && (
        <KitPreview
          kit={previewing}
          onClose={() => setPreviewing(null)}
          onUse={() => {
            const id = previewing.id;
            setPreviewing(null);
            onUse(id);
          }}
        />
      )}
    </dialog>
  );
}

/**
 * A template's sample site, full screen, at computer or phone width, with "Use this template". Its
 * other pages are reached through the sample site's own menu.
 * The frame is sandboxed without allow-same-origin, like the editor's site preview.
 */
function KitPreview({
  kit,
  onClose,
  onUse,
}: {
  kit: StarterKit;
  onClose: () => void;
  onUse: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={`Preview of the ${kit.label} template`}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-zinc-100 p-0 backdrop:bg-black/50 dark:bg-zinc-900"
    >
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="font-semibold">{kit.label}</p>
          <div
            className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800"
            role="group"
            aria-label="Screen size"
          >
            <button
              type="button"
              onClick={() => setWidth("computer")}
              className={tab(width === "computer")}
              aria-pressed={width === "computer"}
            >
              Computer
            </button>
            <button
              type="button"
              onClick={() => setWidth("phone")}
              className={tab(width === "phone")}
              aria-pressed={width === "phone"}
            >
              Phone
            </button>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onUse}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900"
            >
              Use this template
            </button>
          </div>
        </div>
        <p className="bg-white px-4 pb-2 text-xs text-zinc-500 dark:bg-zinc-950">
          Sample details shown: your own name, description and contact details
          go in their place.
        </p>
        <div className="flex min-h-0 flex-1 justify-center overflow-auto p-4">
          <iframe
            title={`Preview of the ${kit.label} template`}
            src={previewUrl(kit)}
            sandbox="allow-scripts allow-popups"
            className={`h-full rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 ${width === "phone" ? "w-[390px] shrink-0" : "w-full"}`}
          />
        </div>
      </div>
    </dialog>
  );
}
