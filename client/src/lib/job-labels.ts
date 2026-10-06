// What each workspace command is doing, in words for people who don't know the site's scripts.
// The server's own label (commands.js) is the fallback and is still shown in the technical log.

const RUNNING: Record<string, string> = {
  install: "Getting your site ready",
  check: "Checking your site for problems",
  preview: "Updating the preview",
  new: "Adding the page",
  "nav-add": "Adding the new section",
  "nav-remove": "Removing the menu item",
  "page-edit": "Claude is changing the page",
  "page-generate": "Claude is writing the page",
  "page-convert": "Claude is bringing in the web page",
  "proposal-preview": "Building a preview of Claude's version",
  "md-edit": "Claude is editing the file",
  "seo-audit": "Checking how your pages look in search results",
  "seo-set": "Saving the search settings",
  "seo-claude": "Claude is writing search text",
  scaffold: "Creating the pages",
  schedule: "Running scheduled pages",
  changelog: "Updating the change history",
};

const DONE: Record<string, string> = {
  install: "Your site is ready",
  check: "Your site has been checked",
  preview: "Preview updated",
  new: "Page added",
  "nav-add": "Section added",
  "nav-remove": "Menu item removed",
  "page-edit": "Claude's version is ready",
  "page-generate": "Claude's version is ready",
  "page-convert": "Claude's version is ready",
  "proposal-preview": "Preview of Claude's version is ready",
  "md-edit": "Claude's version is ready",
  "seo-audit": "Search check finished",
  "seo-set": "Search settings saved",
  "seo-claude": "Claude finished the search text",
  scaffold: "Pages created",
  schedule: "Scheduled pages run",
  changelog: "Change history updated",
};

export function friendlyJobLabel(command: string, fallback: string) {
  return RUNNING[command] ?? fallback;
}

/** What a command that finished successfully did, for the "Done" message. */
export function friendlyJobDone(command: string) {
  return DONE[command] ?? "Done";
}
