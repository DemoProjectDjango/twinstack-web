"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { BUY_CREDITS_HREF, CLAUDE_SETUP_HREF, CONNECT_GITHUB_HREF } from "@/lib/claude";
import { type Credits, creditsValue, formatCredits, useCredits, useCreditsFailed } from "@/lib/credits";
import { BuyCredits } from "./BuyCredits";

/** "low" below a tenth of what the account has had (or 1,000), "empty" at zero (not while the free credits wait for GitHub). */
function level(credits: Credits) {
  if (credits.balance <= 0) return credits.freePending ? "ok" : "empty";
  const total = credits.granted + credits.purchased;
  return credits.balance < Math.max(1_000, total / 10) ? "low" : "ok";
}

const TONE = {
  ok: "border-zinc-300 text-zinc-700 hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900",
  low: "border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  empty: "border-red-300 bg-red-50 text-red-700 hover:border-red-400 hover:bg-red-100 dark:border-red-900 dark:bg-red-950 dark:text-red-400",
};

// The ring's filled part: what's left.
const RING = { ok: "text-emerald-500", low: "text-amber-500", empty: "text-red-500" };

/** Counts from the shown number to `target` whenever it changes (at once with reduced motion). */
function useCountUp(target: number, ms = 600) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (start === target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const began = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = reduce ? 1 : Math.min(1, (now - began) / ms);
      const value = start + (target - start) * (1 - (1 - t) ** 3);
      from.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}

/**
 * A ring filled to `share` (0-1) of the way round. `working` spins a short arc over it while Claude
 * is running. Decorative: the numbers beside it carry the meaning.
 */
function CreditRing({ share, tone, size, stroke, working = false }: { share: number; tone: keyof typeof RING; size: number; stroke: number; working?: boolean }) {
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, share));
  return (
    <span aria-hidden="true" className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-current opacity-15" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={length}
          // A sliver shows even at a few credits, so the ring never looks broken.
          strokeDashoffset={length * (1 - (filled > 0 ? Math.max(filled, 0.03) : 0))}
          className={`stroke-current transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none ${RING[tone]}`}
        />
      </svg>
      {working && (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 animate-spin motion-reduce:animate-none">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${length * 0.2} ${length}`}
            className="stroke-sky-500"
          />
        </svg>
      )}
    </span>
  );
}

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

  const shownBalance = useCountUp(credits?.balance ?? 0);

  if (failed || !credits) return null;

  const own = credits.source === "own";
  const off = credits.source === "none";
  const tone = own || off ? "ok" : level(credits);
  const total = credits.granted + credits.purchased;
  const remainingShare = total > 0 ? Math.max(0, credits.balance) / total : 0;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        title={own ? "Claude uses your own Anthropic key" : off ? "Claude isn't available yet" : `${formatCredits(credits.balance)} Claude credits left`}
        className={`group flex items-center gap-2 rounded-full border py-1 pl-1 pr-2.5 text-sm tabular-nums shadow-sm transition-all hover:-translate-y-px hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 active:translate-y-0 motion-reduce:transform-none ${TONE[tone]} ${open ? "ring-2 ring-zinc-300 dark:ring-zinc-700" : ""}`}
      >
        <span className="relative grid place-items-center">
          <CreditRing share={own || off ? 1 : remainingShare} tone={tone} size={24} stroke={3} working={credits.active} />
          <span aria-hidden="true" className="absolute text-[10px] leading-none transition-transform group-hover:scale-125">
            ✦
          </span>
        </span>
        {own ? (
          <span>Own key</span>
        ) : off ? (
          <span>Claude off</span>
        ) : (
          <span>
            {formatCredits(shownBalance)}
            <span className="hidden lg:inline"> credits</span>
          </span>
        )}
        {credits.active && <span className="sr-only">Claude is working</span>}
        <svg aria-hidden="true" viewBox="0 0 12 12" className={`size-3 opacity-60 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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
              <div className="flex items-center gap-4">
                <span className="relative grid place-items-center">
                  <CreditRing share={remainingShare} tone={tone} size={72} stroke={7} working={credits.active} />
                  <span className="absolute text-sm font-semibold tabular-nums">{Math.round(Math.min(1, remainingShare) * 100)}%</span>
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Claude credits</p>
                  <p className="text-2xl font-semibold tabular-nums">{formatCredits(shownBalance)}</p>
                  <p className="text-xs text-zinc-500">
                    {credits.balance > 0
                      ? `About ${creditsValue(credits.balance, credits.creditsPerDollar)} of Claude use left`
                      : credits.freePending
                        ? "Connect GitHub to get your free credits."
                        : "Buy more credits to keep using Claude."}
                  </p>
                </div>
              </div>
              {credits.freePending && (
                <p className="mt-3 rounded-md bg-sky-500/10 px-3 py-2 text-sm text-sky-900 dark:text-sky-200">
                  Get {formatCredits(credits.freeCredits)} free credits when you{" "}
                  <Link href={CONNECT_GITHUB_HREF} onClick={() => setOpen(false)} className="font-medium underline">
                    connect GitHub
                  </Link>
                  .
                </p>
              )}
              <p
                className="mt-3 text-xs text-zinc-500"
                role="meter"
                aria-label="Credits left"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={Math.max(0, credits.balance)}
              >
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
