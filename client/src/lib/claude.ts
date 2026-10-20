// Whether the signed-in user can run Claude commands, and where to go when they can't.
// Every panel asks this one place. Claude runs on the account's credits ("own" keys are off on the
// server for now, OWN_KEYS in server/src/credits.js).

import { type Credits, formatCredits } from "./credits-store";

export type ClaudeAccess = {
  /** Claude commands can run. */
  ready: boolean;
  /** Shown when they can't, e.g. on a disabled Claude button. */
  reason: string;
  /** Where the user sets Claude up, or buys credits. */
  setupHref: string;
  setupLabel: string;
  /** What one Claude run costs the user, beside the buttons that start one. */
  costNote: string;
};

export const CLAUDE_SETUP_HREF = "/settings#claude";
export const BUY_CREDITS_HREF = "/credits";
/** Where the account connects GitHub, which also brings its free credits. */
export const CONNECT_GITHUB_HREF = "/settings#github";

/** `credits` is null while it loads (Claude counts as not ready until then). */
export function claudeAccess(credits: Credits | null): ClaudeAccess {
  if (!credits) {
    return { ready: false, reason: "Checking your Claude credits…", setupHref: BUY_CREDITS_HREF, setupLabel: "Claude credits", costNote: "" };
  }
  if (credits.source === "own") {
    return {
      ready: true,
      reason: "",
      setupHref: CLAUDE_SETUP_HREF,
      setupLabel: "Claude settings",
      costNote: "Each try is one Claude request, billed to your own Anthropic account.",
    };
  }
  if (credits.source === "none") {
    return {
      ready: false,
      reason: "Claude isn't available right now. Try again later.",
      setupHref: BUY_CREDITS_HREF,
      setupLabel: "Claude credits",
      costNote: "",
    };
  }
  const costNote = "Each try uses Claude credits from your balance.";
  if (credits.balance > 0) return { ready: true, reason: "", setupHref: BUY_CREDITS_HREF, setupLabel: "Claude credits", costNote };
  return credits.freePending
    ? {
        ready: false,
        reason: `Connect GitHub to get ${formatCredits(credits.freeCredits)} free Claude credits.`,
        setupHref: CONNECT_GITHUB_HREF,
        setupLabel: "Connect GitHub",
        costNote,
      }
    : {
        ready: false,
        reason: "You've used all your Claude credits. Buy more to let Claude write and change pages for you.",
        setupHref: BUY_CREDITS_HREF,
        setupLabel: "Buy credits",
        costNote,
      };
}

/** The editor's words for the same access: it says "the AI" where the rest of the app says Claude. */
export function inEditorWords(access: ClaudeAccess): ClaudeAccess {
  const reword = (text: string) =>
    text
      .replace(/\bClaude credits\b/g, "AI credits")
      .replace(/\bClaude settings\b/g, "AI account settings")
      .replace(/\bClaude request\b/g, "AI request")
      .replace(/(^|[.!?]\s+)Claude\b/g, "$1The AI")
      .replace(/\bClaude\b/g, "the AI");
  return { ...access, reason: reword(access.reason), setupLabel: reword(access.setupLabel), costNote: reword(access.costNote) };
}
