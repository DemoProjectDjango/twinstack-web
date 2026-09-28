import { githubFetch, readRepoFile } from "./github.js";
import { WorkspaceError } from "./workspace.js";

// Publishing a site copy with GitHub Pages. The copy's own
// .github/workflows/deploy.yml builds and deploys every push to its default
// branch; this module turns Pages on (source: GitHub Actions), reports the
// live URL and the latest deploy, and can start a deploy by hand.

export const DEPLOY_WORKFLOW = "deploy.yml";
const WORKFLOW_PATH = `.github/workflows/${DEPLOY_WORKFLOW}`;
// Files a copy needs from the template to publish under /<repo> on github.io.
// Copies made before that support get them with "Update publishing files".
export const PUBLISHING_FILES = [WORKFLOW_PATH, "scripts/build.js", "scripts/check.js", "scripts/lib/content.js"];

async function json(path, accessToken, options) {
  const res = await githubFetch(path, accessToken, options);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { res, body };
}

/** GitHub's own explanation of a refused request, e.g. a plan without Pages for private repos. */
function githubMessage(body, fallback) {
  return body?.message ? `GitHub: ${body.message}` : fallback;
}

/**
 * Whether Pages is on, its URL, the latest deploy run on the default branch,
 * and whether the copy's pushed workflow can publish under /<repo>.
 */
export async function getPublishing(accessToken, fullName) {
  const repo = await json(`/repos/${fullName}`, accessToken);
  if (repo.res.status === 404) throw new WorkspaceError("Repository not found.", 404);
  if (!repo.res.ok) throw new Error(`GitHub GET repo failed with ${repo.res.status}`);
  const branch = repo.body.default_branch;

  const [pages, runs, workflow] = await Promise.all([
    json(`/repos/${fullName}/pages`, accessToken),
    json(
      `/repos/${fullName}/actions/workflows/${DEPLOY_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
      accessToken,
    ),
    readRepoFile(accessToken, fullName, WORKFLOW_PATH),
  ]);

  const run = runs.res.ok ? runs.body?.workflow_runs?.[0] : null;
  return {
    defaultBranch: branch,
    private: repo.body.private,
    canConfigure: Boolean(repo.body.permissions?.admin),
    enabled: pages.res.ok,
    // "legacy" means Pages publishes a branch as-is, which skips the build.
    usesActions: pages.res.ok && pages.body?.build_type === "workflow",
    url: pages.res.ok ? pages.body.html_url : null,
    // The copy's deploy.yml on the default branch passes BASE_PATH to the build.
    workflowReady: Boolean(workflow?.includes("BASE_PATH")),
    run: run
      ? {
          status: run.status, // queued | in_progress | completed | …
          conclusion: run.conclusion, // success | failure | cancelled | … (null while running)
          url: run.html_url,
          commit: run.head_sha?.slice(0, 7) ?? null,
          createdAt: run.created_at,
        }
      : null,
  };
}

/** Turns Pages on with GitHub Actions as its source, or switches an existing Pages site to it. */
export async function enablePages(accessToken, fullName) {
  let result = await json(`/repos/${fullName}/pages`, accessToken, { method: "POST", body: { build_type: "workflow" } });
  if (result.res.status === 409) {
    // Already on, publishing from a branch: switch it to the workflow.
    result = await json(`/repos/${fullName}/pages`, accessToken, { method: "PUT", body: { build_type: "workflow" } });
  }
  if (!result.res.ok) {
    throw new WorkspaceError(githubMessage(result.body, `GitHub refused to turn on Pages (${result.res.status}).`), 422);
  }
}

/** Runs the deploy workflow on the default branch now. */
export async function startDeploy(accessToken, fullName, branch) {
  const result = await json(`/repos/${fullName}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, accessToken, {
    method: "POST",
    body: { ref: branch },
  });
  if (!result.res.ok) {
    throw new WorkspaceError(githubMessage(result.body, `GitHub refused to start the deploy (${result.res.status}).`), 422);
  }
}
