/** A repository from `GET /api/repos`: only the site template and copies of it are returned. */
export type Repo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  stars: number;
  updatedAt: string;
  permission: "admin" | "write" | "read";
  role: "template" | "copy";
  /** A copy this account created: only its creator may delete it. */
  createdByYou?: boolean;
};

/** Why a copy can't be opened in the site editor, or null when it can. */
export function cantManage(repo: Repo) {
  if (repo.permission === "read") return "You can look at this site but not change it. Ask its owner to let you edit it.";
  if (repo.archived) return "This site is archived on GitHub, so it can't be changed.";
  return null;
}

/** The site template's placeholder name (`site.config.json` → `name`): a site still showing it hasn't been named. */
export const TEMPLATE_SITE_NAME = "My Website";

/** "new-site110" → "New site110": a site's address in words, when nothing better names it. */
export const nameFromRepo = (name: string) => name.replace(/[-_.]+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()) || name;

/**
 * The name to show for a site: its own (from its details), else the one it was created with
 * (`displayName`), else its address in words, never the template's placeholder.
 */
export function siteTitle(siteName: string | null | undefined, displayName: string | null | undefined, repo: string) {
  const own = siteName?.trim();
  return (own && own !== TEMPLATE_SITE_NAME ? own : null) || displayName?.trim() || nameFromRepo(repo);
}

/** A GitHub repository name from a site name: "Bright Bakery!" → "bright-bakery". */
export function repoNameFor(siteName: string) {
  return siteName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}
