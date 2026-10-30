import { config } from "./config.js";
import { OWNER_PATTERN, isValidRepoName } from "./duplicate.js";
import { githubFetch, readRepoFile, toRepo } from "./github.js";
import { TEMPLATE_TRAILER } from "./site-update.js";
import { appTokenError, isSiteCopy, isTemplate, templateToken } from "./sites.js";

// Making a site from a repo the owner already has, instead of a fresh copy of the template:
//   site   the repo already is a Twinstack site (a copy made by hand, or in another account): it
//          has the workspace's SITE_MARKERS, so it's only recorded in siteCopies.
//   adopt  any other repo (an old static site, say): the template's files are added to it in one
//          commit on its default branch, never replacing a file it has, with copies of its own
//          images, styles and files under static/, then it's recorded. Its own pages stay where
//          they are; the Pages screen brings each one in (original-pages.js). When Pages already
//          publishes the repo, the deploy workflow isn't added and Pages isn't switched (keepLive):
//          the old site stays live until the owner switches it there.
// Both need admin access to the repo (Pages, and the record is the access control, see sites.js).
// A repo with its own package.json can't be adopted: npm ci needs the template's lockfile.

const SITE_MARKERS = ["site.config.json", "scripts/build.js"];
// Template files a repo keeps its own of, or doesn't need.
const NOT_COPIED = new Set(["README.md", "LICENSE", "CLAUDE.md", "AGENTS.md", ".gitignore"]);
const IGNORED = ["node_modules/", "dist/", ".env"];
const BLOB_CONCURRENCY = 8;

/** An error whose message is safe to show to the user. */
export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function json(pathname, token, init) {
  const res = await githubFetch(pathname, token, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`GitHub ${init?.method ?? "GET"} ${pathname} returned ${res.status}`);
  return body;
}

/** The owner's repos that could be imported: admin access, not archived, not the template or a site already. */
export function importCandidates(repos) {
  return repos.filter((repo) => repo.permission === "admin" && !repo.archived && !isTemplate(repo.fullName));
}

/** What `fullName` is: `{ repo, kind: "site" | "other", hasPackageJson }`, or an ImportError saying why it can't be used. */
export async function inspectRepo(accessToken, fullName) {
  const [owner, name, ...rest] = typeof fullName === "string" ? fullName.trim().split("/") : [];
  if (rest.length || !OWNER_PATTERN.test(owner ?? "") || !isValidRepoName(name)) {
    throw new ImportError("Enter the repository as owner/name.");
  }
  const res = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, accessToken);
  if (res.status === 404) throw new ImportError("That repository wasn't found, or your GitHub account can't see it.", 404);
  if (!res.ok) throw new Error(`GitHub GET repo failed with ${res.status}`);
  const body = await res.json();
  const repo = toRepo(body);
  if (isTemplate(repo.fullName)) throw new ImportError("That's the site template. Use Create a new site instead.", 403);
  if (repo.permission !== "admin") throw new ImportError("You need admin access to that repository to make it a site.", 403);
  if (repo.archived) throw new ImportError("That repository is archived. Unarchive it on GitHub first.", 409);
  if (await isSiteCopy(repo)) throw new ImportError("That repository is already one of your sites.", 409);
  if (!body.size && !(await githubFetch(`/repos/${repo.fullName}/commits?per_page=1`, accessToken)).ok) {
    throw new ImportError("That repository is empty. Use Create a new site instead.", 409);
  }
  const [markers, hasPackageJson] = await Promise.all([
    Promise.all(SITE_MARKERS.map((file) => hasFile(accessToken, repo.fullName, file))),
    hasFile(accessToken, repo.fullName, "package.json"),
  ]);
  const kind = markers.every(Boolean) ? "site" : "other";
  return { repo, kind, hasPackageJson, defaultBranch: body.default_branch };
}

/** Whether `filePath` is a file on the repo's default branch. Only existence: any repo can be inspected. */
async function hasFile(accessToken, fullName, filePath) {
  const res = await githubFetch(`/repos/${fullName}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`, accessToken);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${fullName}/${filePath}`);
  const file = await res.json().catch(() => null);
  return file?.type === "file";
}

/** Runs `fn` over `items`, `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Adds the template's files that `fullName` doesn't have, in one commit on its default branch, and
 * the template's ignore rules to its .gitignore. Returns `{ added, kept, keepLive }` (kept: template
 * paths the repo already had, left as they were).
 */
export async function adoptTemplate({ user, accessToken, fullName }) {
  const sourceToken = templateToken(user, accessToken);
  const template = await json(`/repos/${config.siteTemplate}`, sourceToken).catch((err) => {
    throw appTokenError(err, sourceToken);
  });
  // The files come from one template commit, recorded in the commit below (TEMPLATE_TRAILER): the
  // repo has none of the template's history, so the site update reads which version it has there.
  const templateHead = (await json(`/repos/${config.siteTemplate}/git/ref/heads/${encodeURIComponent(template.default_branch)}`, sourceToken)).object.sha;
  const templateCommit = await json(`/repos/${config.siteTemplate}/git/commits/${templateHead}`, sourceToken);
  const templateTree = await json(`/repos/${config.siteTemplate}/git/trees/${templateCommit.tree.sha}?recursive=1`, sourceToken);
  if (templateTree.truncated) throw new Error("The template's file list is too long to read.");

  const repo = await json(`/repos/${fullName}`, accessToken);
  const branch = encodeURIComponent(repo.default_branch);
  const head = (await json(`/repos/${fullName}/git/ref/heads/${branch}`, accessToken)).object.sha;
  const baseTree = (await json(`/repos/${fullName}/git/commits/${head}`, accessToken)).tree.sha;
  const ownTree = await json(`/repos/${fullName}/git/trees/${baseTree}?recursive=1`, accessToken);
  if (ownTree.truncated) throw new ImportError("That repository has too many files to add the site tools to.", 409);
  const own = new Set(ownTree.tree.map((entry) => entry.path));
  if (own.has("package.json")) {
    throw new ImportError("That repository has its own package.json, so the site tools can't be added to it.", 409);
  }

  // A repo Pages already publishes keeps publishing as it is: without the deploy workflow the
  // new build never deploys, until the owner switches (the Pages screen's original pages).
  const keepLive = (await githubFetch(`/repos/${fullName}/pages`, accessToken)).ok;
  const templateFiles = templateTree.tree.filter(
    (entry) => entry.type === "blob" && !NOT_COPIED.has(entry.path) && !(keepLive && entry.path.startsWith(".github/")),
  );
  const missing = templateFiles.filter((entry) => !own.has(entry.path));
  const kept = templateFiles.filter((entry) => own.has(entry.path)).map((entry) => entry.path);

  // The repo's own images, styles, scripts and files, also under static/ (which the build publishes
  // at the site's root), so converted pages find them at the addresses they had. Same blobs, so
  // nothing is uploaded; the originals stay where they are.
  const published = ownTree.tree
    .filter((entry) => entry.type === "blob" && isPublishedOriginal(entry.path) && !own.has(`static/${entry.path}`))
    .map((entry) => ({ path: `static/${entry.path}`, mode: entry.mode, type: "blob", sha: entry.sha }));

  // Blobs can't be shared between unrelated repos: each is read from the template and written here.
  const entries = await mapLimit(missing, BLOB_CONCURRENCY, async (entry) => {
    const blob = await json(`/repos/${config.siteTemplate}/git/blobs/${entry.sha}`, sourceToken);
    const created = await json(`/repos/${fullName}/git/blobs`, accessToken, {
      method: "POST",
      body: { content: blob.content.replace(/\n/g, ""), encoding: "base64" },
    });
    return { path: entry.path, mode: entry.mode, type: "blob", sha: created.sha };
  });

  entries.push(...published);

  const ignore = own.has(".gitignore") ? ((await readRepoFile(accessToken, fullName, ".gitignore", head)) ?? "") : "";
  const lines = new Set(ignore.split(/\r?\n/).map((line) => line.trim()));
  const extra = IGNORED.filter((rule) => !lines.has(rule) && !lines.has(rule.replace(/\/$/, "")));
  if (extra.length) {
    const content = `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${extra.join("\n")}\n`;
    entries.push({ path: ".gitignore", mode: "100644", type: "blob", content });
  }
  if (!entries.length) return { added: [], kept, keepLive };

  const tree = await json(`/repos/${fullName}/git/trees`, accessToken, { method: "POST", body: { base_tree: baseTree, tree: entries } });
  const commit = await json(`/repos/${fullName}/git/commits`, accessToken, {
    method: "POST",
    body: { message: `Add the Twinstack site tools

${TEMPLATE_TRAILER}: ${templateHead}`, tree: tree.sha, parents: [head] },
  });
  await json(`/repos/${fullName}/git/refs/heads/${branch}`, accessToken, { method: "PATCH", body: { sha: commit.sha } });
  return { added: missing.map((entry) => entry.path), kept, keepLive };
}

// Pages are brought in by conversion (original-pages.js), and what the build or git already has
// isn't copied.
const NOT_PUBLISHED_DIRS = new Set(["node_modules", "dist", "static", "assets"]);
const NOT_PUBLISHED_FILE = /\.(html?|md|markdown)$|^(CNAME|LICENSE|package(-lock)?\.json)$/i;
function isPublishedOriginal(filePath) {
  const parts = filePath.split("/");
  if (parts.some((part) => part.startsWith(".") || part.startsWith("_")) || NOT_PUBLISHED_DIRS.has(parts[0])) return false;
  return !NOT_PUBLISHED_FILE.test(parts.at(-1));
}
