import { config } from "./config.js";
import { findSiteCopyIds } from "./db.js";

// Users only work with the site template and their copies of it:
//   template  the one repo in SITE_TEMPLATE_REPO. It can be duplicated but is
//             never opened in the site manager.
//   copy      a repo duplicated from the template through this app (recorded
//             by repo id), or one named like the template ("twinstack-site",
//             "twinstack-site-copy", …) for copies made before that record existed.

const templateName = () => config.siteTemplate.split("/")[1];

export function isTemplate(fullName) {
  return fullName.toLowerCase() === config.siteTemplate;
}

function looksLikeCopy(name) {
  const lower = name.toLowerCase();
  return lower === templateName() || lower.startsWith(`${templateName()}-`);
}

/** Adds `role` to each repo and drops every repo that is neither the template nor a copy. */
export async function withSiteRoles(repos) {
  const copyIds = await findSiteCopyIds(repos.map((repo) => repo.id));
  return repos
    .map((repo) => ({
      ...repo,
      role: isTemplate(repo.fullName) ? "template" : copyIds.has(repo.id) || looksLikeCopy(repo.name) ? "copy" : null,
    }))
    .filter((repo) => repo.role);
}

export async function isSiteCopy(repo) {
  if (isTemplate(repo.fullName)) return false;
  return looksLikeCopy(repo.name) || (await findSiteCopyIds([repo.id])).has(repo.id);
}
