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
};

/** Why a copy can't be opened in the site editor, or null when it can. */
export function cantManage(repo: Repo) {
  if (repo.permission === "read") return "You can view this site but not change it. Ask its owner for write access.";
  if (repo.archived) return "This site is archived on GitHub, so it can't be changed.";
  return null;
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
