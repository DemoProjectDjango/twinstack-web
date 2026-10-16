import { useEffect, useSyncExternalStore } from "react";
import {
  checkoutSnapshot,
  creditsFailedSnapshot,
  creditsSnapshot,
  startFollowing,
  stopFollowing,
  subscribeCredits,
  type CheckoutResult,
  type Credits,
} from "./credits-store";

// React hooks over the credits store (credits-store.ts). Import this only from client components;
// code that server components may load (lib/site-api.ts) imports credits-store.ts instead.

export * from "./credits-store";

/**
 * The credits, or null until they've loaded (or when they couldn't be: `useCreditsFailed`).
 * Every component using it keeps the polling and the focus listener alive.
 */
export function useCredits(): Credits | null {
  useEffect(() => {
    startFollowing();
    return stopFollowing;
  }, []);
  return useSyncExternalStore(subscribeCredits, creditsSnapshot, () => null);
}

/** Where a Stripe payment the browser just came back from has got to (CheckoutReturn.tsx). */
export function useCheckoutResult(): CheckoutResult {
  return useSyncExternalStore(subscribeCredits, checkoutSnapshot, () => null);
}

/** True when the credits couldn't be loaded at all (e.g. a server from before credits). */
export function useCreditsFailed(): boolean {
  return useSyncExternalStore(subscribeCredits, creditsFailedSnapshot, () => false);
}
