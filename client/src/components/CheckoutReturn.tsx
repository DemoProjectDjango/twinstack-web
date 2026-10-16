"use client";

import { useEffect } from "react";
import { type Credits, formatCredits, setCheckoutResult, setCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";

const POLL_MS = 2_000;
const GIVE_UP_MS = 60_000;

type Purchase = { credits: number; status: string };

// Once per page load: React may run the effect twice, and it takes the parameter out of the address.
let handled = false;

/**
 * Back from Stripe's payment page (BuyCredits.tsx) with `?checkout=<session id>` or
 * `?checkout=cancelled`: takes it out of the address and says how it went. A payment can take a
 * moment to reach the server (Stripe's webhook, or GET /api/credits/checkout/:id asking Stripe),
 * so it checks every couple of seconds for up to a minute. Mounted once, in the root layout, which
 * stays for the whole visit.
 */
export function CheckoutReturn() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const checkout = url.searchParams.get("checkout");
    if (!checkout || handled) return;
    handled = true;
    url.searchParams.delete("checkout");
    window.history.replaceState(window.history.state, "", url);

    if (checkout === "cancelled") {
      toast.info("Payment cancelled. Nothing was charged.");
      return;
    }

    const started = Date.now();
    const toastId = toast.loading("Payment received. Adding your credits…");
    const finish = (render: string, type: "success" | "error" | "info") =>
      toast.update(toastId, { render, type, isLoading: false, autoClose: 6_000 });
    setCheckoutResult("waiting");

    async function check() {
      try {
        const { purchase, credits } = await api<{ purchase: Purchase; credits: Credits }>(`/api/credits/checkout/${encodeURIComponent(checkout!)}`);
        if (purchase.status !== "pending") {
          setCredits(credits);
          if (purchase.status === "paid") {
            setCheckoutResult("paid");
            finish(`${formatCredits(purchase.credits)} credits added.`, "success");
          } else {
            setCheckoutResult(null);
            finish(purchase.status === "expired" ? "The payment page timed out. Nothing was charged." : "The payment didn't go through. Nothing was charged.", "error");
          }
          return;
        }
      } catch {
        // Not found (not this account's) or a passing network error: keep trying until the end.
      }
      if (Date.now() - started > GIVE_UP_MS) {
        setCheckoutResult(null);
        finish("Your payment is still being processed. The credits will appear as soon as it clears.", "info");
        return;
      }
      setTimeout(() => void check(), POLL_MS);
    }
    void check();
  }, []);

  return null;
}
