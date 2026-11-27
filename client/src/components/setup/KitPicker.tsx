"use client";

import type { StarterKit } from "@/lib/setup";

/**
 * The setup's "Pick a starting design" step: the starter kits (server/kits/, all free for now)
 * and, last, the AI designing the homepage from the owner's answers. `value` null is the AI.
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
  const card = (selected: boolean) =>
    `flex w-full flex-col items-start rounded-xl border p-4 text-left transition ${
      selected
        ? "border-zinc-900 ring-2 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100"
        : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-700"
    }`;
  return (
    <div className="space-y-3" role="radiogroup" aria-label="Starting design">
      {kits.map((kit) => (
        <button
          key={kit.id}
          type="button"
          role="radio"
          aria-checked={value === kit.id}
          onClick={() => onChange(kit.id)}
          className={card(value === kit.id)}
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
            {kit.pages.length} pages: {kit.pages.map((p) => p.title).join(", ")}. Ready in seconds,
            no AI needed.
          </span>
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        onClick={() => onChange(null)}
        className={card(value === null)}
      >
        <span className="font-semibold">Let the AI design it</span>
        <span className="mt-1 text-sm text-zinc-500">
          A homepage designed from scratch for your business, from your answers. Takes a few
          minutes.
        </span>
      </button>
    </div>
  );
}
