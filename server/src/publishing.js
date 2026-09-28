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
    // What a custom domain's CNAME record points at.
    pagesHost: `${(repo.body.owner?.login ?? fullName.split("/")[0]).toLowerCase()}.github.io`,
    domain: pages.res.ok ? (pages.body.cname ?? null) : null,
    httpsEnforced: pages.res.ok ? Boolean(pages.body.https_enforced) : false,
    // GitHub's certificate for the custom domain: "new", "authorization_pending", "approved", "issued", "errored"…
    certificate: pages.res.ok ? (pages.body.https_certificate?.state ?? null) : null,
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

/** A bare host name ("www.example.com"), from whatever the user typed; throws if it isn't one. */
export function normalizeDomain(input) {
  if (typeof input !== "string") throw new WorkspaceError("Enter a domain.", 400);
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => label.test(l)) || /^\d+$/.test(labels.at(-1))) {
    throw new WorkspaceError(`"${input.trim()}" isn't a domain name like www.example.com.`, 400);
  }
  if (host.endsWith(".github.io")) throw new WorkspaceError("That's a github.io address, not a custom domain.", 400);
  return host;
}

/**
 * Sets the Pages custom domain (null removes it), then redeploys so the site
 * is built for its new address: the workflow reads the domain back from Pages.
 */
export async function setDomain(accessToken, fullName, domain) {
  const result = await json(`/repos/${fullName}/pages`, accessToken, { method: "PUT", body: { cname: domain } });
  if (!result.res.ok) {
    throw new WorkspaceError(githubMessage(result.body, `GitHub refused the domain (${result.res.status}).`), 422);
  }
  const after = await getPublishing(accessToken, fullName);
  let redeployed = false;
  if (after.workflowReady) {
    await startDeploy(accessToken, fullName, after.defaultBranch);
    redeployed = true;
  }
  return { ...after, redeployed };
}

/** Turns "Enforce HTTPS" on or off. GitHub refuses until the domain's certificate exists. */
export async function setHttps(accessToken, fullName, enforced) {
  const result = await json(`/repos/${fullName}/pages`, accessToken, {
    method: "PUT",
    body: { https_enforced: Boolean(enforced) },
  });
  if (!result.res.ok) {
    throw new WorkspaceError(githubMessage(result.body, `GitHub refused to change HTTPS (${result.res.status}).`), 422);
  }
  return getPublishing(accessToken, fullName);
}

/**
 * GitHub's DNS check for the custom domain. `pending` while GitHub is still
 * working it out (it answers 202 at first; ask again a few seconds later).
 */
export async function checkDomain(accessToken, fullName) {
  const result = await json(`/repos/${fullName}/pages/health`, accessToken);
  if (result.res.status === 202) return { pending: true };
  if (!result.res.ok) {
    throw new WorkspaceError(githubMessage(result.body, `GitHub couldn't check the domain (${result.res.status}).`), 422);
  }
  const summary = (d) =>
    d && {
      host: d.host,
      isApex: Boolean(d.is_apex_domain),
      resolves: Boolean(d.dns_resolves),
      pointsToGithub: Boolean(d.is_pointed_to_github_pages_server),
      httpsEligible: Boolean(d.is_https_eligible),
      // Cloudflare's orange-cloud proxy hides GitHub's servers and blocks the certificate.
      proxied: Boolean(d.is_proxied || d.is_cloudflare_ip),
      caaError: d.caa_error ?? null,
    };
  return { pending: false, domain: summary(result.body?.domain), altDomain: summary(result.body?.alt_domain) };
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
