// Shared by the editor's copied-website builder (components/site/CopyWebsite.tsx, CopyWebsiteRunner:
// no screen of its own), which owns the queue that builds copied pages into the site, and the AI's
// copy_website action (AssistantProvider, ActionCard), which makes the prototype and, on "Build it",
// hands the building to that queue.

/** Ask the Pages screen to bring in the copied pages now waiting in the saved queue. */
export const COPY_BRING_IN_EVENT = "twinstack:copy-website-bring-in";
/** The Pages screen's answer once that bringing-in has ended. */
export const COPY_DONE_EVENT = "twinstack:copy-website-done";

export type CopyDone = { broughtIn: number; total: number; missing: string[]; stopped: string | null };

/** "Stop building" on the prototype card: the builder stops the page in progress and the run. */
export const COPY_STOP_EVENT = "twinstack:copy-website-stop";

/** The build's progress while it runs, for the prototype card in the chat. */
export const COPY_PROGRESS_EVENT = "twinstack:copy-website-progress";
export type CopyProgress = { done: number; total: number; working: string | null; retryPass: number | null };

// What's left of a "Bring in", per site and tab, so a reload carries on where it stopped.
const queueKey = (owner: string, repo: string) => `twinstack:copy-website-queue:${owner}/${repo}`;

export function readSavedQueue(owner: string, repo: string): string[] {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(queueKey(owner, repo)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveQueue(owner: string, repo: string, ids: string[]) {
  try {
    if (ids.length) window.sessionStorage.setItem(queueKey(owner, repo), JSON.stringify(ids));
    else window.sessionStorage.removeItem(queueKey(owner, repo));
  } catch {
    // It just won't carry on after a reload.
  }
}

/** Resolves with the Pages screen's report once the bringing-in ends (or null after `timeoutMs`). */
export function waitForCopyDone(timeoutMs: number): Promise<CopyDone | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener(COPY_DONE_EVENT, listener);
      resolve(null);
    }, timeoutMs);
    function listener(event: Event) {
      window.clearTimeout(timer);
      window.removeEventListener(COPY_DONE_EVENT, listener);
      resolve((event as CustomEvent<CopyDone>).detail);
    }
    window.addEventListener(COPY_DONE_EVENT, listener);
  });
}
