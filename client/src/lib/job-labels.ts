// What each workspace command is doing, in words for people who don't know the site's scripts.
// The server's own label (commands.js) is the fallback and is still shown in the technical log.

const RUNNING: Record<string, string> = {
  install: "Getting your site ready",
  check: "Checking your site for problems",
  preview: "Updating the preview",
  new: "Adding the page",
  "nav-add": "Adding the new section",
  "nav-remove": "Removing the menu item",
  "page-edit": "The AI is changing the page",
  "page-generate": "The AI is writing the page",
  "page-convert": "The AI is bringing in the web page",
  "chrome-design": "The AI is designing the header and footer",
  "proposal-preview": "Building a preview of the AI's version",
  "md-edit": "The AI is editing the file",
  "seo-audit": "Checking how your pages look in search results",
  "seo-set": "Saving the search settings",
  "seo-claude": "The AI is writing search text",
  scaffold: "Creating the pages",
  schedule: "Running scheduled pages",
  changelog: "Updating the change history",
  "site-update": "Updating your site to the latest version",
  "site-build": "The AI is building your site",
};

const DONE: Record<string, string> = {
  install: "Your site is ready",
  check: "Your site has been checked",
  preview: "Preview updated",
  new: "Page added",
  "nav-add": "Section added",
  "nav-remove": "Menu item removed",
  "page-edit": "The AI's version is ready",
  "page-generate": "The AI's version is ready",
  "page-convert": "The AI's version is ready",
  "chrome-design": "The AI's header and footer are ready",
  "proposal-preview": "Preview of the AI's version is ready",
  "md-edit": "The AI's version is ready",
  "seo-audit": "Search check finished",
  "seo-set": "Search settings saved",
  "seo-claude": "The AI finished the search text",
  scaffold: "Pages created",
  schedule: "Planned posts run",
  changelog: "Change history updated",
  "site-update": "Your site is up to date",
  "site-build": "Your site is built",
};

export function friendlyJobLabel(command: string, fallback: string) {
  return RUNNING[command] ?? fallback;
}

/**
 * What a running job is on now, when it says so: its latest "▸ " line (the site build's steps,
 * server/src/setup-build.js), e.g. "2/4 Designing your homepage". Null when it doesn't.
 */
export function jobProgress(output: string) {
  const lines = output.match(/^▸ .+$/gm);
  return lines ? lines[lines.length - 1].slice(2) : null;
}

/** What a command that finished successfully did, for the "Done" message. */
export function friendlyJobDone(command: string) {
  return DONE[command] ?? "Done";
}
