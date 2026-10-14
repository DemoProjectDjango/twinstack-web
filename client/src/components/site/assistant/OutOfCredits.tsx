"use client";

import Link from "next/link";
import { useState } from "react";
import { BUY_CREDITS_HREF } from "@/lib/claude";
import { formatCredits, useCredits } from "@/lib/credits";
import { BuyCredits } from "../../BuyCredits";
import { Button } from "../ui";
import { useAssistant } from "./AssistantProvider";

const CARRY_ON = "I've added credits. Please carry on where you stopped.";

/**
 * Under the note Claude stopped with for want of credits: buy more right here, then carry on with one
 * click. `short` (credits left, but not enough to pick the conversation up again) also offers a new
 * conversation, which costs much less.
 */
export function OutOfCredits({ reason }: { reason: "out" | "short" }) {
  const credits = useCredits();
  const { send, startOver } = useAssistant();
  const [bought, setBought] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!credits) return null;

  async function carryOn() {
    setBusy(true);
    try {
      await send(CARRY_ON);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{bought ? "Credits added" : "Add credits to keep going"}</p>
        <p className="text-xs tabular-nums text-zinc-500">{formatCredits(Math.max(0, credits.balance))} left</p>
      </div>

      {bought ? (
        <Button variant="primary" disabled={busy} onClick={() => void carryOn()}>
          {busy ? "Sending…" : "Carry on"}
        </Button>
      ) : (
        <BuyCredits credits={credits} compact onBought={() => setBought(true)} />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {reason === "short" && (
          <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => void startOver()}>
            Start a new conversation instead
          </button>
        )}
        <Link href={BUY_CREDITS_HREF} className="text-zinc-500 underline-offset-2 hover:underline">
          Usage and purchase history
        </Link>
      </div>
    </div>
  );
}
