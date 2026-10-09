// The account's Claude credits, shared by the navbar badge, the site editor and the dashboard so
// they always agree. No React here: lib/site-api.ts imports it and server components import that;
// the hooks are in credits.ts. Loaded once, again when the window regains focus or something starts Claude
// (`refreshCredits`), and every 5 seconds while the server says Claude is working for this
// account, so the balance goes down as Claude uses it.

export type CreditsSource = "credits" | "own" | "none";

export type Credits = {
  balance: number;
  granted: number;
  purchased: number;
  used: number;
  /** Whose key Claude runs on: credits on the app's key, the account's own key, or neither. */
  source: CreditsSource;
  /** Claude is working for this account right now. */
  active: boolean;
  creditsPerDollar: number;
  purchase: { step: number; max: number; demo: boolean };
};

const ACTIVE_POLL_MS = 5_000;

let credits: Credits | null = null;
let failed = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let subscribers = 0;

function emit() {
  for (const listener of listeners) listener();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  // While Claude works the balance changes; otherwise only events refresh it.
  if (subscribers > 0 && credits?.active) timer = setTimeout(() => void refreshCredits(), ACTIVE_POLL_MS);
}

/** Loads the balance now. Safe to call often: calls made while one is loading share it. */
export function refreshCredits(): Promise<void> {
  inFlight ??= (async () => {
    try {
      const res = await fetch("/api/credits", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      credits = (await res.json()) as Credits;
      failed = false;
    } catch {
      failed = credits === null;
    } finally {
      inFlight = null;
      emit();
      schedule();
    }
  })();
  return inFlight;
}

/** Use the answer the server just gave (after buying credits) instead of asking again. */
export function setCredits(next: Credits) {
  credits = next;
  emit();
  schedule();
}

/** Claude was just started: check soon, so the badge starts following it. */
export function claudeStarted() {
  void refreshCredits();
}

const numberFormat = new Intl.NumberFormat("en-US");

/** 12,345 */
export function formatCredits(n: number) {
  return numberFormat.format(Math.round(n));
}

/** What `n` credits are worth in Claude use, e.g. "$1.00". */
export function creditsValue(n: number, perDollar: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / perDollar);
}

/* What the hooks in credits.ts build on. */

export function subscribeCredits(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const creditsSnapshot = () => credits;
export const creditsFailedSnapshot = () => failed;

function onFocus() {
  void refreshCredits();
}

/** A component started following the credits: the first one starts loading and the focus check. */
export function startFollowing() {
  subscribers += 1;
  if (subscribers === 1) {
    void refreshCredits();
    window.addEventListener("focus", onFocus);
  }
}

export function stopFollowing() {
  subscribers -= 1;
  if (subscribers === 0) {
    window.removeEventListener("focus", onFocus);
    if (timer) clearTimeout(timer);
    timer = null;
  }
}
