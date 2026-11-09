import { moveEditor } from "./site-update.js";
import { WorkspaceError, acquire, getStatus, git, listChanges, readMeta, tryGit, workspaceDir } from "./workspace.js";

// Changes that reached the site's GitHub repo from outside the editor (a push from someone's
// computer, an edit on github.com). Opening a site only fetches them; the owner sees what changed
// and decides when to bring them in. They're already on the live site either way.

const MAX_COMMITS = 30;
const MAX_FILES = 200;
// A site update's own commit (site-update.js's UPDATE_TRAILER): the owner asked for it, so it isn't news.
const PLATFORM_COMMIT = /^Twinstack-Update: /m;
const FIELD = "\x1f";
const RECORD = "\x1e";

/** What kind of thing a file is, in the owner's words. */
function kindOf(file) {
  if (/^content\/data\//.test(file) || file === "site.config.json") return "Site settings";
  if (/^content\/.+\.md$/.test(file)) return "Page";
  if (/^assets\/img\/|\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/i.test(file)) return "Image";
  if (/^(?:styles\/|assets\/css\/)/.test(file)) return "Styling";
  if (/^(?:scripts\/|templates\/|\.github\/|package(?:-lock)?\.json$)/.test(file)) return "Site tools";
  return "File";
}

function filesOf(output) {
  const parts = output.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0] === "A" ? "added" : parts[i][0] === "D" ? "removed" : "changed";
    files.push({ path: parts[i + 1], status, kind: kindOf(parts[i + 1]) });
  }
  return files;
}

/** What GitHub has that the editor doesn't, or null when there's nothing the owner needs to look at. */
export async function incomingChanges(key) {
  const dir = workspaceDir(key);
  const meta = await readMeta(dir);
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch !== meta.defaultBranch) return null;
  const target = `origin/${branch}`;
  // --first-parent: a merge is one change, not every commit it brought in.
  const range = `HEAD..${target}`;
  const log = await tryGit(dir, ["log", "--first-parent", `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%b${RECORD}`, range]);
  if (!log?.trim()) return null;
  const commits = log
    .split(RECORD)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, author, date, subject, body] = entry.split(FIELD);
      return { sha, author, date, subject, platform: PLATFORM_COMMIT.test(body ?? "") };
    });
  const outside = commits.filter((c) => !c.platform);
  if (!outside.length) return null;

  const files = filesOf(await git(dir, ["diff", "--name-status", "--no-renames", "-z", `HEAD...${target}`]));
  const incoming = new Set(files.map((f) => f.path));
  const overlap = (await listChanges(dir)).map((c) => c.path).filter((file) => incoming.has(file));
  const ahead = Number((await git(dir, ["rev-list", "--count", `${target}..HEAD`])).trim());
  return {
    sha: (await git(dir, ["rev-parse", target])).trim(),
    commits: outside.slice(0, MAX_COMMITS).map(({ platform: _platform, ...commit }) => ({ ...commit, sha: commit.sha.slice(0, 7) })),
    moreCommits: Math.max(0, outside.length - MAX_COMMITS),
    files: files.slice(0, MAX_FILES),
    moreFiles: Math.max(0, files.length - MAX_FILES),
    overlap,
    // Commits here that never reached GitHub: publishing puts them after GitHub's first.
    needsPublish: ahead > 0,
  };
}

/**
 * Brings GitHub's changes into the editor, keeping unpublished work: it's combined with them, and
 * where both changed the same lines the unpublished version stays (`kept`). `sha` is what the owner
 * was shown, so something newer is shown to them before it's brought in.
 */
export async function acceptIncoming({ key, accessToken, sha }) {
  const release = acquire(key, "getting the changes from GitHub");
  const kept = [];
  let subjects = [];
  try {
    const dir = workspaceDir(key);
    const { defaultBranch } = await readMeta(dir);
    const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch !== defaultBranch) throw new WorkspaceError("These changes can only be brought in on the live version of the site.", 409);
    await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
    const target = `origin/${branch}`;
    if ((await git(dir, ["rev-parse", target])).trim() !== sha) throw new WorkspaceError("Your site changed on GitHub again just now. Reload the page to see the latest changes.", 409);
    if ((await git(dir, ["rev-list", "--count", `${target}..HEAD`])).trim() !== "0") throw new WorkspaceError("You have saved work that hasn't reached GitHub yet. Publish it first, and these changes will be brought in with it.", 409);
    subjects = (await git(dir, ["log", "--first-parent", "--format=%s", `HEAD..${target}`])).split("\n").filter(Boolean);
    await moveEditor(dir, target, ["merge", "--ff-only", "--quiet", target], (line) => {
      const files = /^Kept your unpublished version of (.+)\.$/.exec(line)?.[1];
      if (files) kept.push(...files.split(", "));
    });
  } finally {
    release();
  }
  return { status: await getStatus(key), kept, subjects };
}
