import { config } from "./config.js";
import { findSiteCopyIds } from "./db.js";

// Users only work with the site template and their copies of it:
//   template  the one repo in SITE_TEMPLATE_REPO. It can be duplicated but is
//             never opened in the site manager.
//   copy      a repo duplicated from the template through this app, recorded
//             by repo id in siteCopies (so it survives renames).
//
// Only recorded copies count, never a repo that is merely named like one.
// Managing a site runs the repo's own scripts on this server, so this is what
// limits it to people who could read the private template and duplicate it.
// `npm run record-copies` records copies made before the record existed.

export function isTemplate(fullName) {
  return fullName.toLowerCase() === config.siteTemplate;
}

/** Adds `role` to each repo and drops every repo that is neither the template nor a copy. */
export async function withSiteRoles(repos) {
  const copyIds = await findSiteCopyIds(repos.map((repo) => repo.id));
  return repos
    .map((repo) => ({
      ...repo,
      role: isTemplate(repo.fullName) ? "template" : copyIds.has(repo.id) ? "copy" : null,
    }))
    .filter((repo) => repo.role);
}

export async function isSiteCopy(repo) {
  if (isTemplate(repo.fullName)) return false;
  return (await findSiteCopyIds([repo.id])).has(repo.id);
}
