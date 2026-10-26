import { deleteSiteRecords, findSiteCopy } from "./db.js";
import { githubFetch } from "./github.js";
import { WorkspaceError, acquire, removeWorkspace, workspaceKeysFor } from "./workspace.js";

// Deleting a site from the dashboard (the site card's menu). Only its creator
// (siteCopies.userId) may. It always removes the site from Twinstack: every
// account's clone on this server and what the database keeps for it
// (deleteSiteRecords). The owner may also delete the repository on GitHub,
// which takes the published site offline; that needs GitHub's `delete_repo`
// scope, which the normal connect doesn't ask for, so the dashboard sends the
// owner to `/auth/github?allow=delete_repo` first (DeletePermissionError).

export const DELETE_REPO_SCOPE = "delete_repo";

/** The GitHub token lacks `delete_repo`: the owner must allow it on GitHub. */
export class DeletePermissionError extends Error {}

/**
 * Deletes the site `owner/repo` for `user` (req.user). `scopes` are the GitHub token's. A repo
 * already gone from GitHub is still removed from Twinstack, found by the name it was created with.
 * Nothing is removed if GitHub refuses to delete the repository. Returns `{ repoDeleted }`.
 */
export async function deleteSite({ user, scopes, accessToken, owner, repo, deleteRepo }) {
  const fullName = `${owner}/${repo}`;
  const res = await githubFetch(`/repos/${fullName}`, accessToken);
  if (!res.ok && res.status !== 404) throw new WorkspaceError("GitHub isn't answering. Please try again.", 502);
  const onGithub = res.ok ? await res.json() : null;

  const record = await findSiteCopy(onGithub ? { id: onGithub.id } : { fullName });
  if (!record) throw new WorkspaceError("This isn't one of your sites.", 404);
  if (record.userId !== user.id) throw new WorkspaceError("Only the person who created this site can delete it.", 403);

  const removeRepo = Boolean(deleteRepo && onGithub);
  if (removeRepo) {
    if (!scopes.includes(DELETE_REPO_SCOPE)) throw new DeletePermissionError("Deleting a repository needs one more GitHub permission.");
    if (!onGithub.permissions?.admin) throw new WorkspaceError("Only an admin of the repository on GitHub can delete it.", 403);
  }

  // Clones may sit under the name it has now and the one it was created with.
  const names = new Set([fullName, record.fullName, onGithub?.full_name].filter(Boolean).map((name) => name.toLowerCase()));
  const keys = [];
  for (const name of names) {
    const [o, r] = name.split("/");
    keys.push(...(await workspaceKeysFor(o, r)));
  }

  // Every clone's lock first, so no command is running in one as it's deleted.
  const releases = [];
  try {
    for (const key of keys) releases.push(acquire(key, "deleting the site"));

    if (removeRepo) {
      const del = await githubFetch(`/repos/${onGithub.full_name}`, accessToken, { method: "DELETE" });
      if (!del.ok && del.status !== 404) {
        const { message } = await del.json().catch(() => ({}));
        throw new WorkspaceError(`GitHub didn't delete the repository${message ? ` (${message})` : ""}. Nothing was deleted.`, 502);
      }
    }
    await deleteSiteRecords(record._id);
    for (const key of keys) await removeWorkspace(key);
  } finally {
    for (const release of releases) release();
  }
  return { repoDeleted: removeRepo };
}
