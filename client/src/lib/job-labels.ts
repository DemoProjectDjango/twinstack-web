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

export function friendlyJobLabel(command: string, fallback: string) {
  return RUNNING[command] ?? fallback;
}
