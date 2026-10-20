"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { BUY_CREDITS_HREF, CONNECT_GITHUB_HREF } from "@/lib/claude";
import { formatCredits, useCredits } from "@/lib/credits";
import { level } from "../CreditBadge";

// The editor's top bar says whether there's enough AI help left, not the exact count: a six-digit
// number with no unit leaves owners unsure whether they can afford a change. The number, and where
// to buy more, are one click away. The navbar's CreditBadge keeps the exact figure.

const WORDS = { ok: "plenty left", low: "running low", empty: "none left" };
const TONE = {
  ok: "text-zinc-600 dark:text-zinc-400",
  low: "text-amber-700 dark:text-amber-400",
  empty: "text-red-700 dark:text-red-400",
};

export function AiHelpBadge() {
  const credits = useCredits();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

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

  if (!credits) return null;
  const own = credits.source === "own";
  const off = credits.source === "none";
  const tone = own || off ? "ok" : level(credits);
  const words = own ? "your own key" : off ? "off for now" : credits.freePending ? "connect GitHub" : WORDS[tone];

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={`rounded-md px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 ${TONE[tone]}`}
      >
        AI help: <span className="font-semibold">{words}</span>
        {credits.active && <span className="ml-1.5 inline-block size-2 animate-pulse rounded-full bg-sky-500 motion-reduce:animate-none" aria-label="The AI is working" />}
      </button>
      {open && (
        <div id={id} className="absolute right-0 z-30 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-background p-4 text-sm shadow-lg dark:border-zinc-800">
          {own ? (
            <p className="text-zinc-600 dark:text-zinc-400">The AI uses your own key, so no credits are used.</p>
          ) : off ? (
            <p className="text-zinc-600 dark:text-zinc-400">The AI isn&apos;t available right now. Try again later.</p>
          ) : (
            <>
              <p>
                <span className="text-2xl font-semibold tabular-nums">{formatCredits(Math.max(0, credits.balance))}</span> credits left
              </p>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                {credits.freePending
                  ? `Connect GitHub to get ${formatCredits(credits.freeCredits)} free credits.`
                  : tone === "empty"
                    ? "Buy more to keep asking the AI for changes."
                    : tone === "low"
                      ? "Enough for a few more changes. Buy more before a big job."
                      : "Each request uses some. A small wording change costs far less than designing a page."}
              </p>
              {credits.freePending ? (
                <Link href={CONNECT_GITHUB_HREF} onClick={() => setOpen(false)} className="mt-3 block font-medium underline">
                  Connect GitHub
                </Link>
              ) : null}
            </>
          )}
          <Link href={BUY_CREDITS_HREF} onClick={() => setOpen(false)} className="mt-3 block font-medium underline-offset-2 hover:underline">
            Buy credits and see history →
          </Link>
        </div>
      )}
    </div>
  );
}
