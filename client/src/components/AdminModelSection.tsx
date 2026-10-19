import type { ReactNode } from "react";

// The frame each setting on /admin/models sits in: a title and what it's for, what's in use now and
// who chose it, then the choices.

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function AdminModelSection({
  title,
  description,
  inUse,
  inUseTone = "good",
  chosen,
  note,
  children,
}: {
  title: string;
  description: ReactNode;
  /** What's running now, e.g. "DeepSeek Flash". */
  inUse: string | null;
  inUseTone?: "good" | "warning";
  /** Who chose it and when, or how the server decided. */
  chosen: { by: string | null; at: string | null } | string;
  /** A line under who chose it, e.g. how many sites chose their own. */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 bg-zinc-50/70 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="min-w-0 max-w-2xl">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-zinc-500">{description}</p>
        </div>
        {inUse && (
          <div className="text-right">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                inUseTone === "good"
                  ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900"
                  : "bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900"
              }`}
            >
              <span className={`size-1.5 rounded-full ${inUseTone === "good" ? "bg-emerald-500" : "bg-amber-500"}`} />
              In use: {inUse}
            </span>
            <p className="mt-1 text-xs text-zinc-500">
              {typeof chosen === "string"
                ? chosen
                : chosen.at
                  ? `Chosen by ${chosen.by ?? "an admin"}, ${dateFormat.format(new Date(chosen.at))}`
                  : "Not chosen yet"}
            </p>
            {note && <p className="mt-0.5 text-xs text-zinc-500">{note}</p>}
          </div>
        )}
      </header>
      <div className="space-y-6 p-5">{children}</div>
    </section>
  );
}

/** A provider's key on the server: set, or the variable that's missing. */
export function KeyBadge({ set, env }: { set: boolean; env: string }) {
  return set ? (
    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">Key set</span>
  ) : (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
      Needs <code>{env}</code>
    </span>
  );
}

/** The frame of one choice: a card that's a radio button, outlined when chosen. */
export function ChoiceCard({
  name,
  value,
  checked,
  disabled,
  onChoose,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <label
      className={`relative flex flex-col rounded-lg border p-4 transition-shadow has-focus-visible:ring-2 has-focus-visible:ring-sky-500 ${
        checked
          ? "border-zinc-900 bg-white shadow-sm ring-1 ring-zinc-900 dark:border-zinc-100 dark:bg-zinc-950 dark:ring-zinc-100"
          : "border-zinc-200 hover:border-zinc-400 hover:shadow-sm dark:border-zinc-800 dark:hover:border-zinc-600"
      } ${disabled ? "cursor-not-allowed opacity-55 hover:border-zinc-200 hover:shadow-none" : "cursor-pointer"}`}
    >
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChoose} className="sr-only" />
      {checked && (
        <span aria-hidden="true" className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-foreground text-background">
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
        </span>
      )}
      {children}
    </label>
  );
}
