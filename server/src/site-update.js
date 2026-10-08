import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { anthropicClient } from "./assistant/turn.js";
import { jobEnv, npmCli } from "./commands.js";
import { config } from "./config.js";
import { GIT_TIMEOUT_MS } from "./duplicate.js";
import { githubFetch } from "./github.js";
import { WorkspaceError, git, listChanges, markInstalled, readMeta, tryGit, workspaceDir } from "./workspace.js";

// One-click site updates: brings a copy up to the template's newest commit on its default branch
// (every push to the template is an update) while keeping everything the owner made. The
// template says which files are whose in twinstack-update.json (MANIFEST), read from the update:
//   site          the owner's (content, settings, images, the site plan): never changed, only
//                 added when the update brings a file the copy never had
//   template      the template's (scripts, layouts, the deploy workflow): take the update's
//                 version, unless the template didn't change it since the copy's last update
//   keepDesigned  the header and footer: the owner's while Claude designed or copied them
//                 (data-designed), otherwise the template's
//   packages      package.json: the update's, plus the scripts and packages only the copy has
//   anything else both sides' changes are merged line by line; where they touch the same lines,
//                 Claude combines them
// Files the template no longer has are kept (pages may still use an old layout) unless the
// manifest lists them in `remove`; data-shape changes come as the template's migrations
// (scripts/migrate.js).
//
// It all happens in a separate checkout of the published site (updateDir), so the editor's
// unpublished changes are never touched. The result must build, and its check may not report
// a problem the site didn't already have, before it's published as one merge commit (marked
// UPDATE_TRAILER) on the default branch. The merge records the template commit as a parent, so the next
// update only brings what changed since. Undo puts the branch back on the commit before it,
// while nothing has been published after the update.

const execFileAsync = promisify(execFile);

const MANIFEST = "twinstack-update.json";
const TEMPLATE_REF = "refs/twinstack/template";
const UPDATE_TRAILER = "Twinstack-Update";
const DESIGNED_MARK = "data-designed=";
// Claude merges files up to this size; a bigger conflicting file stops the update.
const MAX_MERGE_CHARS = 300_000;
const MAX_TOKENS = 64_000;
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;
const PACKAGE_FIELDS = ["scripts", "dependencies", "devDependencies", "optionalDependencies"];
const MINUTE = 60 * 1000;

const updateDir = (key, suffix = "") => path.join(config.workspacesDir, ".site-updates", ...key.split("/")) + suffix;
const templateUrl = () => `https://github.com/${config.siteTemplate}.git`;

/* ----------------------------------------------------------------- status */

// The update is the newest commit on the template's default branch: a copy has it waiting when
// that commit isn't in its published history yet. Copies share the template's history from the
// day they were duplicated, and every update merges the template in, so no version is needed.
const COMMITS_TTL_MS = 60 * 1000;
const MAX_COMMITS = 50;
let commitsCache = { at: 0, value: [] };

/** The template's latest commits on its default branch, newest first: `{ sha, date, message }`. */
async function templateCommits(accessToken) {
  if (Date.now() - commitsCache.at < COMMITS_TTL_MS) return commitsCache.value;
  const res = await githubFetch(`/repos/${config.siteTemplate}/commits?per_page=${MAX_COMMITS}`, accessToken);
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for the template's commits`);
  const value = (await res.json()).map((c) => ({ sha: c.sha, date: c.commit?.committer?.date ?? null, message: c.commit?.message ?? "" }));
  commitsCache = { at: Date.now(), value };
  return value;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A commit message's first line in plain words: "fix: small change" → "Small change". Merges are left out. */
function changeLine(message) {
  const line = message.split("\n")[0].trim();
  if (!line || /^merge\b/i.test(line)) return null;
  const text = line.replace(/^[\w-]+(\([^)]*\))?!?:\s*/, "");
  return text ? text[0].toUpperCase() + text.slice(1) : null;
}

/** The update the published site's latest commit is, if it is one: what Undo would take back. */
async function lastUpdate(dir, branch) {
  const out = await tryGit(dir, ["log", "-1", "--format=%H%n%P%n%B", `origin/${branch}`]);
  if (!out) return null;
  const [commit, parents, ...body] = out.split("\n");
  const marked = new RegExp(`^${UPDATE_TRAILER}: \\S+$`, "m").test(body.join("\n"));
  const [previous, second] = parents.trim().split(" ");
  if (!marked || !previous || !second) return null;
  const date = (await tryGit(dir, ["log", "-1", "--format=%cI", second]))?.trim() || null;
  return { commit, previous, date };
}

/**
 * What the site screens show: the date of the newest template commit the published site has, the
 * template's newest, the changes in between (commit messages) and whether Undo is possible.
 */
export async function getUpdateStatus(key, accessToken) {
  const dir = workspaceDir(key);
  const meta = await readMeta(dir);
  const published = `origin/${meta.defaultBranch}`;
  const [commits, last] = await Promise.all([templateCommits(accessToken), lastUpdate(dir, meta.defaultBranch)]);
  // A commit the copy doesn't have isn't even in its object store, so the check just fails.
  let have = -1;
  for (let i = 0; i < commits.length; i++) {
    if ((await tryGit(dir, ["merge-base", "--is-ancestor", commits[i].sha, published])) !== null) {
      have = i;
      break;
    }
  }
  const newer = have === -1 ? commits : commits.slice(0, have);
  return {
    current: have === -1 ? null : { date: commits[have].date },
    latest: commits.length ? { date: commits[0].date } : null,
    available: newer.length > 0,
    changes: newer.map((c) => changeLine(c.message)).filter(Boolean).slice(0, 20),
    // More changes than listed: the site is older than the commits fetched.
    moreChanges: have === -1 && commits.length === MAX_COMMITS,
    undo: last ? { date: last.date } : null,
  };
}

/* ----------------------------------------------------------------- merging */

function globPattern(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function readManifest(text) {
  const raw = safeJson(text);
  if (!raw || typeof raw !== "object") throw new Error(`The update's ${MANIFEST} isn't valid JSON.`);
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
  return {
    site: list(raw.site).map(globPattern),
    template: list(raw.template).map(globPattern),
    keepDesigned: new Set(list(raw.keepDesigned)),
    packages: typeof raw.packages === "string" ? raw.packages : "package.json",
    remove: list(raw.remove),
  };
}

function ownerOf(manifest, file) {
  if (manifest.keepDesigned.has(file)) return "designed";
  if (file === manifest.packages) return "packages";
  if (manifest.site.some((re) => re.test(file))) return "site";
  if (manifest.template.some((re) => re.test(file))) return "template";
  return "merge";
}

/** path → { mode, sha } for every file in `rev` (empty for no rev). */
async function listTree(dir, rev) {
  const files = new Map();
  if (!rev) return files;
  const out = await git(dir, ["ls-tree", "-r", "-z", "--full-tree", rev], { maxBuffer: 64 * 1024 * 1024 });
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha] = entry.slice(0, tab).split(" ");
    if (type === "blob") files.set(entry.slice(tab + 1), { mode, sha });
  }
  return files;
}

async function readBlob(dir, sha) {
  if (!sha) return Buffer.alloc(0);
  const { stdout } = await execFileAsync("git", ["cat-file", "blob", sha], { cwd: dir, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/** git merge-file on three versions: `{ text, conflicts }`, with conflict markers when there are any. */
async function mergeFile(ours, base, theirs) {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), "twinstack-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => path.join(tmp, n));
    await Promise.all([fs.writeFile(o, ours), fs.writeFile(b, base), fs.writeFile(t, theirs)]);
    const args = ["merge-file", "-p", "-L", "your site", "-L", "before", "-L", "the update", o, b, t];
    try {
      const { stdout } = await execFileAsync("git", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      return { text: stdout, conflicts: 0 };
    } catch (err) {
      // The exit code is the number of conflicts.
      if (typeof err.code === "number" && err.code > 0 && err.stdout) return { text: err.stdout, conflicts: err.code };
      throw err;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** The update's package.json with the scripts and packages only the copy has kept, in its own line endings. */
function mergePackageJson(oursText, theirsText) {
  const ours = safeJson(oursText);
  const theirs = safeJson(theirsText);
  if (!theirs) throw new Error("The update's package.json isn't valid JSON.");
  if (!ours) return { text: theirsText, extra: false };
  const merged = { ...theirs };
  let extra = false;
  for (const field of PACKAGE_FIELDS) {
    const own = Object.entries(ours[field] ?? {}).filter(([name]) => !(name in (theirs[field] ?? {})));
    if (!own.length) continue;
    merged[field] = { ...theirs[field], ...Object.fromEntries(own) };
    if (field !== "scripts") extra = true;
  }
  if (typeof ours.name === "string") merged.name = ours.name;
  const eol = theirsText.includes("\r\n") ? "\r\n" : "\n";
  return { text: `${JSON.stringify(merged, null, 2)}\n`.replace(/\n/g, eol), extra };
}

const isBinary = (...buffers) => buffers.some((b) => b.includes(0));

/* ---------------------------------------------------------------- Claude */

const MERGE_SYSTEM = `You combine two sets of changes to one file of a website that was built from a template.

The site's owner changed the file (YOUR SITE), and a newer version of the template changed it too (THE UPDATE). BEFORE is the version both started from. Git's attempt to combine them is included, with conflict markers where both changed the same lines.

Write the file with both sets of changes in it:
- Everything the owner added, removed or reworded stays as the owner has it.
- Every change the update makes is applied too: new code, fixes, new settings, removed code.
- Where both changed the same lines, keep the owner's content, wording and look, and add the update's code and structure around them. If they truly can't both be kept, the owner's version wins.
- Add nothing that is in neither version, and drop nothing that either version added.
- The result must be a complete, valid file of its type, with no conflict markers.

Reply with the whole merged file between <merged_file> and </merged_file>, and nothing else.`;

function block(name, buffer) {
  return `<${name}>\n${buffer.toString("utf8")}\n</${name}>`;
}

/** Claude's merge of one conflicting text file, checked before it's used. */
async function mergeWithClaude(client, model, conflict) {
  const { file, ours, base, theirs, marked } = conflict;
  if ([ours, base, theirs].some((b) => b.length > MAX_MERGE_CHARS)) {
    throw new Error(`${file} is too big to merge automatically.`);
  }
  const prompt = [`File: ${file}`, block("before", base), block("your_site", ours), block("the_update", theirs), block("git_attempt", marked)].join("\n\n");
  const stream = client.beta.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    system: MERGE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "high" },
    fallbacks: "default",
    betas: ["server-side-fallback-2026-07-01"],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error(`Claude declined to merge ${file}.`);
  if (message.stop_reason === "max_tokens") throw new Error(`Claude's merge of ${file} was cut off.`);
  const reply = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const found = /<merged_file>\r?\n?([\s\S]*?)<\/merged_file>/.exec(reply);
  if (!found) throw new Error(`Claude's merge of ${file} came back in the wrong form.`);

  const oursText = ours.toString("utf8");
  const eol = oursText.includes("\r\n") ? "\r\n" : "\n";
  let text = found[1].replace(/\r?\n$/, "").replace(/\r?\n/g, eol);
  if (/\r?\n$/.test(oursText)) text += eol;
  if (CONFLICT_MARKER.test(text)) throw new Error(`Claude's merge of ${file} still has conflict markers.`);
  if (!text.trim() && oursText.trim()) throw new Error(`Claude's merge of ${file} came back empty.`);
  if (file.endsWith(".json") && !safeJson(text)) throw new Error(`Claude's merge of ${file} isn't valid JSON.`);
  return text;
}

/* ------------------------------------------------------------ the update */

/** `git checkout <rev> -- files`, in batches small enough for any command line. */
async function checkoutFiles(dir, rev, files) {
  for (let i = 0; i < files.length; i += 100) {
    await git(dir, ["--literal-pathspecs", "checkout", rev, "--", ...files.slice(i, i + 100)]);
  }
}

async function readOptional(file) {
  return fs.readFile(file).catch(() => null);
}

/** The site's dependencies in a separate checkout: a link to the editor's when the lockfile matches, else npm ci. */
async function installDependencies(dir, work, exec, env) {
  const [mine, theirs] = await Promise.all([readOptional(path.join(dir, "package-lock.json")), readOptional(path.join(work, "package-lock.json"))]);
  if (mine && theirs && mine.equals(theirs) && existsSync(path.join(dir, "node_modules"))) {
    await fs.symlink(path.join(dir, "node_modules"), path.join(work, "node_modules"), "junction");
    return false;
  }
  const npm = npmCli();
  const { code } = await exec({
    file: process.execPath,
    args: [npm, "ci", "--no-audit", "--no-fund", "--ignore-scripts"],
    display: "npm ci --no-audit --no-fund --ignore-scripts",
    timeoutMs: 15 * MINUTE,
    cwd: work,
    env,
  });
  if (code !== 0) throw new Error("Installing the updated site's tools failed.");
  return true;
}

/** A linked node_modules is removed as a link, never by walking into the editor's copy. */
async function unlinkModules(work) {
  const link = path.join(work, "node_modules");
  const stat = await fs.lstat(link).catch(() => null);
  if (stat && (stat.isSymbolicLink() || (await fs.readlink(link).catch(() => null)))) await fs.unlink(link).catch(() => fs.rmdir(link));
}

async function removeCheckout(dir, work) {
  await unlinkModules(work);
  await tryGit(dir, ["worktree", "remove", "--force", work]);
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  await tryGit(dir, ["worktree", "prune"]);
}

/** The error lines of a build-and-check, or null when the build itself failed. */
async function checkSite(work, exec, env) {
  const node = process.execPath;
  const step = (name) => ({ file: node, args: [`scripts/${name}`], display: `node scripts/${name}`, timeoutMs: 10 * MINUTE, cwd: work, env });
  const build = await exec(step("build.js"));
  if (build.code !== 0) return null;
  const check = await exec(step("check.js"));
  const errors = check.output.split(/\r?\n/).filter((line) => line.startsWith("  error"));
  return { ok: check.code === 0, errors };
}

function identity(user) {
  const email = user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
  return ["-c", `user.name=${user.name || user.login}`, "-c", `user.email=${email}`];
}

/**
 * The job's steps for installing the template's newest commit into the copy's published site (see the
 * top of this file). `cleanup` must run when the job ends, whatever happened.
 */
export function siteUpdateSteps({ key, accessToken, user, anthropicKey, model }) {
  const dir = workspaceDir(key);
  const work = updateDir(key);
  const before = updateDir(key, "-before");
  const env = jobEnv(null, null);
  const s = { done: false };

  const steps = [
    {
      display: "Getting the update",
      run: async ({ log }) => {
        s.meta = await readMeta(dir);
        const branch = s.meta.defaultBranch;
        await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
        // The template's newest commit on its default branch (its HEAD) is the update.
        await git(dir, ["fetch", "--quiet", "--no-tags", templateUrl(), `+HEAD:${TEMPLATE_REF}`], { accessToken });
        s.base = (await git(dir, ["rev-parse", `origin/${branch}`])).trim();
        s.incoming = (await git(dir, ["rev-parse", `${TEMPLATE_REF}^{commit}`])).trim();
        if ((await tryGit(dir, ["merge-base", "--is-ancestor", s.incoming, s.base])) !== null) {
          s.done = true;
          log("Your site is already up to date.");
          return;
        }
        await removeCheckout(dir, work);
        await fs.mkdir(path.dirname(work), { recursive: true });
        await git(dir, ["worktree", "add", "--quiet", "--detach", work, s.base]);
        log(`Updating to the template's latest changes (${s.incoming.slice(0, 7)}).`);
      },
    },
    {
      display: "Merging it with your site",
      run: async ({ log }) => {
        if (s.done) return;
        const manifest = readManifest(await git(work, ["show", `${s.incoming}:${MANIFEST}`]));
        s.mergeBase = (await tryGit(work, ["merge-base", "HEAD", s.incoming]))?.trim() || null;
        // Records the template commit as the second parent; the files are decided below, one by one.
        await git(work, [...identity(user), "merge", "--quiet", "--no-commit", "--no-ff", "-s", "ours", ...(s.mergeBase ? [] : ["--allow-unrelated-histories"]), s.incoming]);

        const [ours, theirs, base] = await Promise.all([listTree(work, "HEAD"), listTree(work, s.incoming), listTree(work, s.mergeBase)]);
        const take = [];
        const write = new Map();
        s.conflicts = [];
        const kept = [];
        for (const [file, t] of theirs) {
          const o = ours.get(file);
          const b = base.get(file);
          if (o?.sha === t.sha) continue;
          const owner = ownerOf(manifest, file);
          if (owner === "site") {
            if (!o && !b) take.push(file);
            continue;
          }
          if (owner === "template") {
            if (!(o && b && t.sha === b.sha)) take.push(file);
            continue;
          }
          if (owner === "designed") {
            if (o && (await readBlob(work, o.sha)).toString("utf8").includes(DESIGNED_MARK)) kept.push(file);
            else take.push(file);
            continue;
          }
          if (owner === "packages") {
            if (!o) take.push(file);
            else {
              const merged = mergePackageJson((await readBlob(work, o.sha)).toString("utf8"), (await readBlob(work, t.sha)).toString("utf8"));
              write.set(file, merged.text);
              s.refreshLock ||= merged.extra;
            }
            continue;
          }
          // Shared files: whoever changed it wins; both → a line merge, then Claude.
          if (!o) {
            if (!b) take.push(file);
            continue;
          }
          if (b && o.sha === b.sha) {
            take.push(file);
            continue;
          }
          if (b && t.sha === b.sha) continue;
          const [ob, bb, tb] = await Promise.all([readBlob(work, o.sha), readBlob(work, b?.sha), readBlob(work, t.sha)]);
          if (isBinary(ob, bb, tb)) {
            kept.push(file);
            continue;
          }
          const merged = await mergeFile(ob, bb, tb);
          if (merged.conflicts) s.conflicts.push({ file, ours: ob, base: bb, theirs: tb, marked: merged.text });
          else write.set(file, merged.text);
        }

        await checkoutFiles(work, s.incoming, take);
        for (const [file, text] of write) await fs.writeFile(path.join(work, file), text);
        const remove = manifest.remove.filter((file) => ours.has(file));
        if (remove.length) await git(work, ["--literal-pathspecs", "rm", "--quiet", "--", ...remove]);

        log(`  ${take.length + write.size} file${take.length + write.size === 1 ? "" : "s"} updated, ${remove.length} removed.`);
        for (const file of kept) log(`  Kept your ${file}.`);
        if (s.conflicts.length) log(`  ${s.conflicts.length} file${s.conflicts.length === 1 ? " needs" : "s need"} both your changes and the update's.`);
      },
    },
    {
      display: "Combining your changes with the update's",
      run: async ({ log }) => {
        if (s.done || !s.conflicts.length) return;
        const files = s.conflicts.map((c) => c.file).join(", ");
        if (!anthropicKey) {
          throw new Error(
            `You changed ${files}, and so does this update. Claude combines the two: add your Anthropic API key in Settings and try again. Nothing on your site has changed.`,
          );
        }
        const client = anthropicClient(anthropicKey);
        for (const conflict of s.conflicts) {
          log(`  Claude is combining ${conflict.file}…`);
          await fs.writeFile(path.join(work, conflict.file), await mergeWithClaude(client, model, conflict));
        }
      },
    },
    {
      display: "Checking the updated site",
      run: async ({ log, exec }) => {
        if (s.done) return;
        if (s.refreshLock) {
          const { code } = await exec({
            file: process.execPath,
            args: [npmCli(), "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
            display: "npm install --package-lock-only",
            timeoutMs: 10 * MINUTE,
            cwd: work,
            env,
          });
          if (code !== 0) throw new Error("Updating the list of the site's tools failed.");
        }
        s.installed = await installDependencies(dir, work, exec, env);
        if (existsSync(path.join(work, "scripts", "migrate.js"))) {
          const { code } = await exec({ file: process.execPath, args: ["scripts/migrate.js"], display: "node scripts/migrate.js", timeoutMs: 5 * MINUTE, cwd: work, env });
          if (code !== 0) throw new Error("Updating your site's content for the update failed. Nothing on your site has changed.");
        }
        const after = await checkSite(work, exec, env);
        if (!after) throw new Error("The updated site didn't build, so nothing was changed. Your site is exactly as it was.");
        if (after.ok) return;

        // Only problems the site didn't already have stop the update.
        log("The check found problems. Checking whether your site had them before the update…");
        await removeCheckout(dir, before);
        await git(dir, ["worktree", "add", "--quiet", "--detach", before, s.base]);
        await installDependencies(dir, before, exec, env);
        const was = await checkSite(before, exec, env);
        const known = new Set(was?.errors ?? []);
        const added = after.errors.filter((line) => !known.has(line));
        if (!was || added.length || !after.errors.length) {
          throw new Error(
            `The updated site didn't pass its check, so nothing was changed. Your site is exactly as it was.${added.length ? `\nNew problems:\n${added.join("\n")}` : ""}`,
          );
        }
        log("Your site had these problems before the update too, so they don't stop it.");
      },
    },
    {
      display: "Publishing the update",
      run: async ({ log }) => {
        if (s.done) return;
        const branch = s.meta.defaultBranch;
        await unlinkModules(work);
        await fs.rm(path.join(work, "dist"), { recursive: true, force: true });
        await git(work, ["add", "--all"]);
        const message = `Update the site's tools from the template\n\n${UPDATE_TRAILER}: ${s.incoming}`;
        await git(work, [...identity(user), "commit", "--quiet", "-m", message]);
        try {
          await git(work, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { accessToken });
        } catch (err) {
          if (/rejected|non-fast-forward|fetch first/i.test(err.message)) {
            throw new Error("Your site changed on GitHub while it was updating. Try the update again.");
          }
          throw err;
        }
        log("Your site is updated. It goes live in a minute or two.");
        // Published: from here on nothing may fail the job.
        try {
          const resolve = anthropicKey ? (conflict) => mergeWithClaude(anthropicClient(anthropicKey), model, conflict) : null;
          await syncEditor(dir, branch, accessToken, log, resolve);
          if (s.installed) await adoptDependencies(key, dir, work);
        } catch (err) {
          log(`The editor didn't catch up with the update (${err.message}). Open the site again to see it.`);
        }
      },
    },
  ];

  const cleanup = async () => {
    await removeCheckout(dir, work).catch(() => {});
    await removeCheckout(dir, before).catch(() => {});
    await tryGit(dir, ["update-ref", "-d", TEMPLATE_REF]);
  };
  return { steps, cleanup };
}

/**
 * Brings the editor's checkout up to the published update, keeping its unpublished changes. A
 * change to a file the update also changed keeps the owner's unpublished version.
 */
async function syncEditor(dir, branch, accessToken, log, resolve) {
  await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
  const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // On a work branch (a pull request), the update arrives with the next fresh change.
  if (current !== branch) return;
  await moveEditor(dir, `origin/${branch}`, ["merge", "--ff-only", "--quiet", `origin/${branch}`], log, resolve);
}

/**
 * Runs `args` (a fast-forward or reset of the editor's branch to `target`) without losing
 * unpublished changes: changes to files the move changes are set aside, then merged back onto
 * the moved file. Where they touch the same lines, `resolve` (Claude) combines them when given;
 * otherwise, or if it fails, the owner's unpublished version wins.
 */
async function moveEditor(dir, target, args, log, resolve = null) {
  const updated = new Set((await git(dir, ["diff", "--name-only", "-z", "HEAD", target])).split("\0").filter(Boolean));
  const saved = [];
  for (const change of await listChanges(dir)) {
    if (!updated.has(change.path)) continue;
    const full = path.join(dir, change.path);
    const sha = (await tryGit(dir, ["rev-parse", "--verify", "--quiet", `HEAD:${change.path}`]))?.trim();
    saved.push({ file: change.path, full, content: await fs.readFile(full).catch(() => null), old: sha ? await readBlob(dir, sha) : null });
    if (sha) await git(dir, ["checkout", "HEAD", "--", change.path]);
    else await fs.rm(full, { force: true });
  }
  try {
    await git(dir, args);
  } finally {
    const kept = [];
    for (const { file, full, content, old } of saved) {
      if (content === null) {
        await fs.rm(full, { force: true });
        continue;
      }
      const now = await fs.readFile(full).catch(() => null);
      const merged = old && now && !isBinary(content, old, now) ? await mergeFile(content, old, now) : null;
      await fs.mkdir(path.dirname(full), { recursive: true });
      let text = merged && !merged.conflicts ? merged.text : null;
      if (merged?.conflicts && resolve) {
        log(`  Claude is combining your unpublished changes to ${file} with the update…`);
        text = await resolve({ file, ours: content, base: old, theirs: now, marked: merged.text }).catch(() => null);
      }
      if (text !== null) await fs.writeFile(full, text);
      else {
        await fs.writeFile(full, content);
        kept.push(file);
      }
    }
    if (kept.length) log(`Kept your unpublished version of ${kept.join(", ")}.`);
  }
}

/** The update's freshly installed tools become the editor's, which now has the same lockfile. */
async function adoptDependencies(key, dir, work) {
  const [mine, theirs] = await Promise.all([readOptional(path.join(dir, "package-lock.json")), readOptional(path.join(work, "package-lock.json"))]);
  if (!mine || !theirs || !mine.equals(theirs) || !existsSync(path.join(work, "node_modules"))) return;
  await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true });
  await fs.rename(path.join(work, "node_modules"), path.join(dir, "node_modules"));
  await markInstalled(key);
}

/**
 * Takes the last update back off the published site, while it's still the latest thing published:
 * the default branch goes back to the commit before it. Unpublished changes in the editor stay.
 */
export async function undoSiteUpdate({ key, accessToken }) {
  const dir = workspaceDir(key);
  const meta = await readMeta(dir);
  const branch = meta.defaultBranch;
  await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
  const last = await lastUpdate(dir, branch);
  if (!last) throw new WorkspaceError("There's no update to undo: something was published after it.", 409);

  const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (current === branch) {
    const ahead = (await tryGit(dir, ["rev-list", "--count", `origin/${branch}..HEAD`]))?.trim();
    if (ahead && ahead !== "0") throw new WorkspaceError("Publish your changes first, then undo the update.", 409);
  }
  await git(dir, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${last.commit}`, "origin", `${last.previous}:refs/heads/${branch}`], { accessToken });
  await git(dir, ["fetch", "--quiet", "--prune", "origin"], { accessToken });
  if (current === branch) {
    try {
      await moveEditor(dir, `origin/${branch}`, ["reset", "--quiet", "--keep", `origin/${branch}`], () => {});
    } catch {
      throw new WorkspaceError("The update is undone on your live site. Open the site again to see it here.", 409);
    }
  }
  return { date: last.date };
}
