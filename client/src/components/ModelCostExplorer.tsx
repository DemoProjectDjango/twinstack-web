"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/site-api";

// The AI models page's cost comparison: pick a task (or set its size with sliders) and every model
// card shows what it would cost there. Also the page's usage (GET /api/admin/models/usage): what each
// model did lately, and how many sites chose their own.

/** Dollars per million tokens. */
export type Price = { input: number; output: number; cacheRead: number; long?: { above: number; input: number; output: number; cacheRead: number } };

export type ModelUsage = {
  model: string;
  requests: number;
  credits: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
export type Usage = { days: number; models: ModelUsage[]; overrides: { fast: number; image: number } };

type Tokens = { input: number; output: number };

/** What the tokens cost on a model, in dollars. */
export const costOf = (price: Price, t: Tokens) => (t.input * price.input + t.output * price.output) / 1e6;

/** The last `days`' usage per model, and the sites' own choices. */
export function useModelUsage(days: number) {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<Usage>(`/api/admin/models/usage?days=${days}`)
      .then((u) => !cancelled && setUsage(u))
      .catch(() => !cancelled && setUsage(null));
    return () => {
      cancelled = true;
    };
  }, [days]);
  return usage;
}

export const TASKS = [
  { id: "edit", label: "Edit a page", input: 30_000, output: 4_000 },
  { id: "create", label: "Create a page", input: 45_000, output: 12_000 },
  { id: "details", label: "Site details", input: 6_000, output: 800 },
  { id: "custom", label: "Custom", input: 20_000, output: 3_000 },
] as const;
type TaskId = (typeof TASKS)[number]["id"];

/** The task being compared, and the size Custom is set to. */
export type Explore = { task: TaskId; custom: Tokens };
export const START: Explore = { task: "edit", custom: { input: 20_000, output: 3_000 } };

/** The tokens the cards price, and how to name the task ("edit a page"). */
export type Measure = { tokens: Tokens; label: string };

export function measureOf(e: Explore): Measure {
  const preset = TASKS.find((t) => t.id === e.task)!;
  return e.task === "custom" ? { tokens: e.custom, label: "this task" } : { tokens: { input: preset.input, output: preset.output }, label: preset.label.toLowerCase() };
}

/** About 0.75 English words per token. */
const words = (tokens: number) => (Math.round((tokens * 0.75) / 100) * 100).toLocaleString();

/** The task buttons, and the size sliders for Custom. */
export function CostExplorer({ value, onChange }: { value: Explore; onChange: (next: Explore) => void }) {
  const { tokens } = measureOf(value);
  return (
    <div className="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-900/50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-sm font-medium">Compare the cost to</p>
        <div role="radiogroup" aria-label="Task" className="flex flex-wrap gap-1.5">
          {TASKS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={value.task === t.id}
              onClick={() => onChange({ ...value, task: t.id })}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                value.task === t.id ? "border-foreground bg-foreground text-background" : "border-zinc-300 bg-background hover:border-zinc-400 dark:border-zinc-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {value.task === "custom" ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Slider label="Words read" value={tokens.input} min={1_000} max={200_000} step={1_000} onChange={(input) => onChange({ ...value, custom: { ...value.custom, input } })} />
          <Slider label="Words written" value={tokens.output} min={100} max={50_000} step={100} onChange={(output) => onChange({ ...value, custom: { ...value.custom, output } })} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">
          A typical size: about {words(tokens.input)} words read and {words(tokens.output)} written. Choose Custom to set your own.
        </p>
      )}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void }) {
  return (
    <label className="block">
      <span className="flex justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-zinc-500">about {words(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-2 w-full accent-sky-600" />
    </label>
  );
}
