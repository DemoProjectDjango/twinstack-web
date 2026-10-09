"use client";

import { useState } from "react";
import { type Credits, creditsValue, formatCredits, setCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { Button, ErrorText, inputClass } from "./site/ui";

const PRESETS = [1_000, 5_000, 10_000, 50_000];

/**
 * Buying Claude credits: a preset amount or any multiple of the purchase step. For now a demo: the
 * credits are added straight away and nothing is paid.
 */
export function BuyCredits({ credits, onBought, compact = false }: { credits: Credits; onBought?: () => void; compact?: boolean }) {
  const { step, max, demo } = credits.purchase;
  const [amount, setAmount] = useState(PRESETS[0]);
  const [custom, setCustom] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!demo) return <p className="text-sm text-zinc-500">Buying credits isn&apos;t available yet.</p>;

  const typed = custom.trim() === "" ? null : Number(custom);
  const chosen = typed ?? amount;
  const problem =
    !Number.isInteger(chosen) || chosen < step || chosen > max || chosen % step !== 0
      ? `Choose a multiple of ${formatCredits(step)}, up to ${formatCredits(max)}.`
      : null;

  async function buy() {
    if (problem) return;
    setWorking(true);
    setError(null);
    try {
      const result = await api<{ credits: Credits }>("/api/credits/purchases", { method: "POST", body: { credits: chosen } });
      setCredits(result.credits);
      setCustom("");
      toast.success(`${formatCredits(chosen)} credits added.`);
      onBought?.();
    } catch (err) {
      setError(err);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="How many credits" className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
        {PRESETS.filter((p) => p <= max).map((preset) => {
          const selected = typed === null && amount === preset;
          return (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setAmount(preset);
                setCustom("");
              }}
              className={`rounded-md border px-3 py-2 text-left text-sm ${
                selected
                  ? "border-foreground bg-zinc-100 dark:bg-zinc-900"
                  : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              }`}
            >
              <span className="block font-medium">{formatCredits(preset)}</span>
              <span className="block text-xs text-zinc-500">{creditsValue(preset, credits.creditsPerDollar)} of Claude use</span>
            </button>
          );
        })}
      </div>

      <label className="block text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Or enter an amount</span>
        <input
          type="number"
          inputMode="numeric"
          min={step}
          max={max}
          step={step}
          value={custom}
          placeholder={`${formatCredits(step)}, ${formatCredits(step * 2)}, …`}
          onChange={(e) => setCustom(e.target.value)}
          className={`${inputClass} mt-1`}
        />
      </label>
      {typed !== null && problem && <p className="text-xs text-red-600 dark:text-red-400">{problem}</p>}

      <Button variant="primary" className="w-full" disabled={working || Boolean(problem)} onClick={buy}>
        {working ? "Adding…" : `Add ${Number.isFinite(chosen) ? formatCredits(chosen) : ""} credits`}
      </Button>
      <p className="text-xs text-zinc-500">Demo: no payment is taken. The credits are added to your balance straight away.</p>
      <ErrorText error={error} />
    </div>
  );
}
