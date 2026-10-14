import { config } from "./config.js";
import { findSiteCopyIds } from "./db.js";
import { ReauthRequiredError, githubFetch, readRepoFile, toRepo } from "./github.js";

// Users only work with the site template and their copies of it:
//   template  the one repo in SITE_TEMPLATE_REPO. It can be duplicated but is
//             never opened in the site manager.
//   copy      a repo duplicated from the template through this app, recorded
//             by repo id in siteCopies (so it survives renames).
//
// Only recorded copies count, never a repo that is merely named like one.
// Managing a site runs the repo's own scripts on this server, so this is what
// limits it to people who were approved (users.access) and duplicated it.
// `npm run record-copies` records copies made before the record existed.
//
// The template is private. Approved accounts read it with TEMPLATE_GITHUB_TOKEN
// (`templateToken`), so they needn't be collaborators on it; without that token,
// or for accounts that aren't approved, their own GitHub token is used.

export function isTemplate(fullName) {
  return fullName.toLowerCase() === config.siteTemplate;
}

/** Whether this account (req.user) may copy, install from and update from the template. */
export const hasTemplateAccess = (user) => user?.access?.status === "approved";

/** The token to read the template with for this account. */
export function templateToken(user, userToken) {
  return hasTemplateAccess(user) && config.templateToken ? config.templateToken : userToken;
}

/** A text file from the template's default branch, or null if it isn't there. */
export async function readTemplateFile(user, userToken, filePath) {
  const token = templateToken(user, userToken);
  try {
    return await readRepoFile(token, config.siteTemplate, filePath);
  } catch (err) {
    throw appTokenError(err, token);
  }
}

/**
 * GitHub refusing the app's template token isn't something the user can fix by reconnecting
 * GitHub: it becomes a plain server error (and a log line for the admin) instead of a 401.
 */
export function appTokenError(err, token) {
  if (token !== config.templateToken || !(err instanceof ReauthRequiredError)) return err;
  console.error(`GitHub rejected TEMPLATE_GITHUB_TOKEN (expired or revoked?) reading ${config.siteTemplate}.`);
  return new Error("The site template can't be read right now.");
}

/**
 * Adds `role` to each repo and drops every repo that is neither the template nor a copy. The
 * template is listed only for approved accounts, read with the template token when the account
 * can't see it itself.
 */
export async function withSiteRoles(repos, user) {
  const copyIds = await findSiteCopyIds(repos.map((repo) => repo.id));
  const listed = repos
    .map((repo) => ({
      ...repo,
      role: isTemplate(repo.fullName) ? "template" : copyIds.has(repo.id) ? "copy" : null,
    }))
    .filter((repo) => repo.role && (repo.role !== "template" || hasTemplateAccess(user)));
  if (hasTemplateAccess(user) && config.templateToken && !listed.some((repo) => repo.role === "template")) {
    const res = await githubFetch(`/repos/${config.siteTemplate}`, config.templateToken).catch((err) => {
      console.error(`TEMPLATE_GITHUB_TOKEN can't read ${config.siteTemplate}: ${err.message}`);
      return null;
    });
    if (res?.ok) listed.push({ ...toRepo(await res.json()), permission: "read", role: "template" });
    else if (res) console.error(`TEMPLATE_GITHUB_TOKEN can't read ${config.siteTemplate}: GitHub returned ${res.status}`);
  }
  return listed;
}

export async function isSiteCopy(repo) {
  if (isTemplate(repo.fullName)) return false;
  return (await findSiteCopyIds([repo.id])).has(repo.id);
}
