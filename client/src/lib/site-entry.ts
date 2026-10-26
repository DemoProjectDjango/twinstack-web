// Whether the editor was entered from the dashboard (a site card's "Edit site", or Create a new site
// opening the new one) rather than by reloading it: the dashboard marks the site in this tab's
// sessionStorage, and the editor uses the mark up. FirstRunSetup asks its questions only on such an
// entry. Anything wrong with storage just means no mark.

const entryKey = (owner: string, repo: string) => `twinstack:entered:${owner.toLowerCase()}/${repo.toLowerCase()}`;

/** Marks the site as being entered from the dashboard; call just before navigating to it. */
export function markSiteEntry(owner: string, repo: string) {
  try {
    sessionStorage.setItem(entryKey(owner, repo), "1");
  } catch {
    // The setup just won't open by itself.
  }
}

/** Whether the site was entered from the dashboard. Doesn't remove the mark: see `clearSiteEntry`. */
export function readSiteEntry(owner: string, repo: string) {
  try {
    return sessionStorage.getItem(entryKey(owner, repo)) === "1";
  } catch {
    return false;
  }
}

/**
 * Uses the mark up, so a reload isn't an entry. Called from an effect, not while rendering: React's
 * development mode renders twice, and the second render must still see the mark.
 */
export function clearSiteEntry(owner: string, repo: string) {
  try {
    sessionStorage.removeItem(entryKey(owner, repo));
  } catch {
    // Nothing to clear.
  }
}
