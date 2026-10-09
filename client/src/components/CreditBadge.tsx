"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { BUY_CREDITS_HREF, CLAUDE_SETUP_HREF } from "@/lib/claude";
import { type Credits, creditsValue, formatCredits, useCredits, useCreditsFailed } from "@/lib/credits";
import { BuyCredits } from "./BuyCredits";

/** "low" below a tenth of what the account has had (or 1,000), "empty" at zero. */
function level(credits: Credits) {
  if (credits.balance <= 0) return "empty";
  const total = credits.granted + credits.purchased;
  return credits.balance < Math.max(1_000, total / 10) ? "low" : "ok";
}

const TONE = {
  ok: "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900",
  low: "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  empty: "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950 dark:text-red-400",
};

/** The navbar's Claude credits: the balance (live while Claude works) and a menu to buy more. */
export function CreditBadge() {
  const credits = useCredits();
  const failed = useCreditsFailed();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (failed || !credits) return null;

  const own = credits.source === "own";
  const off = credits.source === "none";
  const tone = own || off ? "ok" : level(credits);
  const total = credits.granted + credits.purchased;
  const usedShare = total > 0 ? Math.min(1, Math.max(0, (total - credits.balance) / total)) : 1;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        title={own ? "Claude uses your own Anthropic key" : off ? "Claude isn't available yet" : `${formatCredits(credits.balance)} Claude credits left`}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm tabular-nums ${TONE[tone]}`}
      >
        <span aria-hidden="true">✦</span>
        {own ? (
          <span>Own key</span>
        ) : off ? (
          <span>Claude off</span>
        ) : (
          <span>
            {formatCredits(credits.balance)}
            <span className="hidden lg:inline"> credits</span>
          </span>
        )}
        {credits.active && (
          <span className="relative flex size-2" aria-label="Claude is working">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
          </span>
        )}
      </button>

      {open && (
        <div
          id={menuId}
          className="absolute right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-background p-4 shadow-lg dark:border-zinc-800"
        >
          {own ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Claude uses your own Anthropic API key, so no credits are used. Your balance of {formatCredits(credits.balance)} credits
              is kept for when you remove the key in{" "}
              <Link href={CLAUDE_SETUP_HREF} onClick={() => setOpen(false)} className="underline">
                Settings
              </Link>
              .
            </p>
          ) : credits.source === "none" ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Claude isn&apos;t available right now. Try again later.</p>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Claude credits</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCredits(credits.balance)}</p>
              <p className="text-xs text-zinc-500">
                {credits.balance > 0
                  ? `About ${creditsValue(credits.balance, credits.creditsPerDollar)} of Claude use left`
                  : "Buy more credits to keep using Claude."}
              </p>
              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                role="meter"
                aria-label="Credits used"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={total - Math.max(0, credits.balance)}
              >
                <div className={`h-full ${tone === "ok" ? "bg-foreground" : tone === "low" ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${(1 - usedShare) * 100}%` }} />
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {formatCredits(credits.used)} used of {formatCredits(total)}
                {credits.active && " · updating while Claude works"}
              </p>
              <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                <p className="mb-2 text-sm font-medium">Buy credits</p>
                <BuyCredits credits={credits} compact />
              </div>
            </>
          )}
          <Link
            href={BUY_CREDITS_HREF}
            onClick={() => setOpen(false)}
            className="mt-4 block text-sm font-medium underline-offset-2 hover:underline"
          >
            Usage and purchase history →
          </Link>
        </div>
      )}
    </div>
  );
}
