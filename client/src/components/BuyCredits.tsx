"use client";

import { useEffect, useState } from "react";
import { type Credits, creditsValue, formatCredits, formatDollars, setCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { Button, ErrorText, inputClass } from "./site/ui";

const PRESETS = [5, 10, 25, 50];

/**
 * Buying Claude credits: a preset amount or any whole number of dollar steps. Paid on Stripe's
 * payment page, which sends the browser back here (CheckoutReturn.tsx adds up the result). In
 * development without Stripe it's a demo: the credits are added at once and nothing is paid.
 */
export function BuyCredits({ credits, onBought, compact = false }: { credits: Credits; onBought?: () => void; compact?: boolean }) {
  const { mode, stepUsd, maxUsd, creditsPerUsd } = credits.purchase;
  const [amount, setAmount] = useState(PRESETS[0]);
  const [custom, setCustom] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Back from Stripe's page with the browser's back button: this page comes back as it was left.
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => e.persisted && setWorking(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  if (mode === "off") return <p className="text-sm text-zinc-500">Buying credits isn&apos;t available yet.</p>;

  const typed = custom.trim() === "" ? null : Number(custom);
  const chosen = typed ?? amount;
  const problem =
    !Number.isInteger(chosen) || chosen < stepUsd || chosen > maxUsd || chosen % stepUsd !== 0
      ? `Choose a multiple of ${formatDollars(stepUsd)}, up to ${formatDollars(maxUsd)}.`
      : null;
  const creditsFor = (dollars: number) => dollars * creditsPerUsd;

  async function buy() {
    if (problem) return;
    setWorking(true);
    setError(null);
    try {
      if (mode === "stripe") {
        // Back to this page afterwards, so the assistant can carry on where it stopped.
        const { url } = await api<{ url: string }>("/api/credits/checkout", {
          method: "POST",
          body: { dollars: chosen, returnTo: `${window.location.pathname}${window.location.search}` },
        });
        window.location.assign(url);
        return;
      }
      const result = await api<{ credits: Credits }>("/api/credits/purchases", { method: "POST", body: { dollars: chosen } });
      setCredits(result.credits);
      setCustom("");
      toast.success(`${formatCredits(creditsFor(chosen))} credits added.`);
      onBought?.();
      setWorking(false);
    } catch (err) {
      setError(err);
      setWorking(false);
    }
  }

  const label = Number.isFinite(chosen) ? formatDollars(chosen) : "";

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="How much to spend" className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
        {PRESETS.filter((p) => p <= maxUsd).map((preset) => {
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
              <span className="block font-medium">{formatDollars(preset)}</span>
              <span className="block text-xs text-zinc-500">{formatCredits(creditsFor(preset))} credits</span>
            </button>
          );
        })}
      </div>

      <label className="block text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Or enter an amount in dollars</span>
        <input
          type="number"
          inputMode="numeric"
          min={stepUsd}
          max={maxUsd}
          step={stepUsd}
          value={custom}
          placeholder={`${stepUsd}, ${stepUsd * 2}, …`}
          onChange={(e) => setCustom(e.target.value)}
          className={`${inputClass} mt-1`}
        />
      </label>
      {typed !== null && problem && <p className="text-xs text-red-600 dark:text-red-400">{problem}</p>}
      {!problem && (
        <p className="text-xs text-zinc-500">
          {formatCredits(creditsFor(chosen))} credits, about {creditsValue(creditsFor(chosen), credits.creditsPerDollar)} of Claude use.
        </p>
      )}

      <Button variant="primary" className="w-full" disabled={working || Boolean(problem)} onClick={buy}>
        {mode === "stripe" ? (working ? "Opening payment…" : `Pay ${label}`) : working ? "Adding…" : `Add credits for ${label}`}
      </Button>
      <p className="text-xs text-zinc-500">
        {mode === "stripe"
          ? "You'll pay on Stripe's secure page, then come straight back here."
          : "Demo: no payment is taken. The credits are added to your balance straight away."}
      </p>
      <ErrorText error={error} />
    </div>
  );
}
