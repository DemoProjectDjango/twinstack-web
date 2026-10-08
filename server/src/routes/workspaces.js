import express, { Router } from "express";
import { COMMANDS, jobEnv } from "../commands.js";
import { config } from "../config.js";
import { getAnthropicKey, getClaudeModel } from "../db.js";
import { getAccessToken, readRepoFile } from "../github.js";
import { cancelJob, getJob, serializeJob, startJob } from "../jobs.js";
import {
  PUBLISHING_FILES,
  checkDomain,
  enablePages,
  getPublishing,
  normalizeDomain,
  setDomain,
  setHttps,
  startDeploy,
} from "../publishing.js";
import { requireAuth, requireGithub } from "../session.js";
import { assistantRouter } from "./assistant.js";
import { handle, keyFor, requireJson } from "./helpers.js";
import {
  applyProposal,
  clearMemory,
  clearProposal,
  collectWorkLog,
  createHomepage,
  createListingPage,
  createPageAt,
  deletePage,
  forgetMemoryLine,
  MD_EDIT_FILES,
  getOverview,
  installMdEdit,
  listCss,
  listImages,
  readCss,
  readDataFile,
  readImage,
  readMemory,
  readPage,
  readProposal,
  readSchedule,
  savePage,
  prepareWorkLog,
  replaceMemoryLine,
  saveCss,
  saveHtmlSource,
  saveUpload,
  updateFromTemplate,
  WORK_LOG_FOR_RUN,
  writeDataFile,
  writeSchedule,
} from "../site-files.js";
import { getStaticInfo, saveStaticInfo } from "../static-info.js";
import { getBrand, saveBrand, saveBrandImage } from "../brand.js";
import { APPEARANCE_MARKER, HEADER_FOOTER_FILES, HEADER_FOOTER_MARKERS, getNavigation, saveNavigation, setPageMenu } from "../navigation.js";
import { SEO_FILES, SEO_MARKERS, installSeo, readSeo } from "../seo.js";
import { readCheckReport } from "../site-check.js";
import { readMissingPages } from "../missing-pages.js";
import {
  WorkspaceError,
  acquire,
  commitAndPush,
  discardChanges,
  getDiff,
  getStatus,
  openWorkspace,
  resetToDefault,
  workspaceDir,
} from "../workspace.js";

/* ------------------------------------------------------------- workspaces */

export const workspacesRouter = Router();
// Who may open which site is decided in openWorkspace: a copy recorded by
// Duplicate (see sites.js) that the user can push to on GitHub.
workspacesRouter.use(requireAuth, requireGithub, requireJson);
// "Ask Claude": the site's conversation and the changes it proposes (routes/assistant.js).
workspacesRouter.use("/:owner/:repo/assistant", assistantRouter);

workspacesRouter.post(
  "/:owner/:repo/open",
  handle(async (req, res) => {
    keyFor(req);
    const accessToken = await getAccessToken(req, res);
    res.json(await openWorkspace({ accessToken, userId: req.user.id, owner: req.params.owner, repo: req.params.repo }));
  }),
);

workspacesRouter.get(
  "/:owner/:repo",
  handle(async (req, res) => res.json(await getStatus(keyFor(req)))),
);

workspacesRouter.get(
  "/:owner/:repo/overview",
  handle(async (req, res) => res.json(await getOverview(keyFor(req)))),
);

workspacesRouter.get(
  "/:owner/:repo/diff",
  handle(async (req, res) => res.json({ files: await getDiff(keyFor(req)) })),
);

workspacesRouter.post(
  "/:owner/:repo/discard",
  handle(async (req, res) => {
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string")) {
      throw new WorkspaceError("Choose at least one file to discard.", 400);
    }
    res.json(await discardChanges(keyFor(req), paths));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/commit",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { message, mode, branch } = req.body ?? {};
    // May be empty when only retrying a push; commitAndPush requires it when there's something to commit.
    if (typeof message !== "string" || message.length > 5000) throw new WorkspaceError("Invalid commit message.", 400);
    if (mode !== "pr" && mode !== "direct") throw new WorkspaceError("Choose how to publish the changes.", 400);
    if (branch !== undefined && typeof branch !== "string") throw new WorkspaceError("Invalid branch name.", 400);
    const accessToken = await getAccessToken(req, res);
    const result = await commitAndPush({ key, accessToken, user: req.user.github, message: message.trim(), mode, branch });
    res.json({ ...result, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/reset",
  handle(async (req, res) => {
    const accessToken = await getAccessToken(req, res);
    res.json(await resetToDefault({ key: keyFor(req), accessToken }));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/commands/:command",
  handle(async (req, res) => {
    const key = keyFor(req);
    const name = req.params.command;
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
    if (!command) throw new WorkspaceError("Unknown command.", 404);

    const status = await getStatus(key);
    if (status.needsInstall && name !== "install") {
      throw new WorkspaceError("Install dependencies first.", 409);
    }
    const input = req.body?.input ?? {};
    const steps = command.steps(input);
    const needsKey = command.needsKey?.(input) ?? false;
    const anthropicKey = needsKey ? await getAnthropicKey(req.user.id) : null;
    if (needsKey && !anthropicKey) {
      return res.status(400).json({
        error: "anthropic_key_required",
        message: "Add your Anthropic API key on the dashboard to run Claude commands.",
      });
    }

    const release = acquire(key, command.label);
    const env = jobEnv(anthropicKey, needsKey ? await getClaudeModel(req.user.id) : null);
    let workLog = null;
    try {
      await command.prepare?.(key, input);
      // Claude reads the site's latest work log before every run, merged or not.
      if (command.claude) workLog = await prepareWorkLog(key);
      if (workLog) env.TWINSTACK_WORK_LOG = WORK_LOG_FOR_RUN;
    } catch (err) {
      release();
      throw err;
    }
    const job = startJob({
      key,
      userId: req.user.id,
      command: name,
      label: command.label,
      steps,
      cwd: workspaceDir(key),
      env,
      // Saved before the lock is released, so no later run rewrites the file first. A
      // failed queue run may still have written (and logged) the edits before it failed.
      release: workLog ? () => collectWorkLog(key, workLog).finally(release) : release,
      onSuccess: command.onSuccess && (() => command.onSuccess(key)),
      onEnd: command.onEnd && ((result) => command.onEnd(key, result)),
    });
    res.status(202).json({ job });
  }),
);

workspacesRouter.get(
  "/:owner/:repo/files/:name",
  handle(async (req, res) => res.json(await readDataFile(keyFor(req), req.params.name))),
);

workspacesRouter.put(
  "/:owner/:repo/files/:name",
  handle(async (req, res) => res.json(await writeDataFile(keyFor(req), req.params.name, req.body?.content))),
);

/* A page's markdown, written by hand as the draft Claude turns into the finished page. */

workspacesRouter.get(
  "/:owner/:repo/pages/source",
  handle(async (req, res) => res.json(await readPage(keyFor(req), req.query.file))),
);

workspacesRouter.put(
  "/:owner/:repo/pages/source",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file, content, version } = req.body ?? {};
    const page = await savePage(key, file, content, version);
    res.json({ page, status: await getStatus(key) });
  }),
);

/* The homepage and collection listing pages (the Blog page), which "Add a page" can't make: their address isn't their name. */

workspacesRouter.post(
  "/:owner/:repo/pages/homepage",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file } = await createHomepage(key, { title: req.body?.title });
    res.json({ file, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/pages/listing",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file } = await createListingPage(key, req.body?.collection, { title: req.body?.title });
    res.json({ file, status: await getStatus(key) });
  }),
);

/* A page at the exact address a link already points to (a missing page the editor offers to make). */

workspacesRouter.post(
  "/:owner/:repo/pages/at",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file } = await createPageAt(key, { url: req.body?.url, title: req.body?.title });
    res.json({ file, status: await getStatus(key) });
  }),
);

/* Removes one page (the Pages screen's "Delete"). It can be undone on the Publish screen until it's published. */

workspacesRouter.delete(
  "/:owner/:repo/pages/source",
  handle(async (req, res) => {
    const key = keyFor(req);
    await deletePage(key, req.query.file);
    res.json({ status: await getStatus(key) });
  }),
);

/* The pages the site links to but doesn't have, as the last build found them, with the pages nothing links to. */

workspacesRouter.get(
  "/:owner/:repo/missing-pages",
  handle(async (req, res) => res.json(await readMissingPages(keyFor(req)))),
);

/* What the last "Build and check" found (the deploy's own check), and whether the site changed since. */

workspacesRouter.get(
  "/:owner/:repo/check",
  handle(async (req, res) => res.json(await readCheckReport(keyFor(req)))),
);

/* Stylesheets: the Tailwind source, the site tree's global stylesheets, converted pages' own. */

workspacesRouter.get(
  "/:owner/:repo/css",
  handle(async (req, res) => res.json({ files: await listCss(keyFor(req)) })),
);

workspacesRouter.get(
  "/:owner/:repo/css/source",
  handle(async (req, res) => res.json(await readCss(keyFor(req), req.query.file))),
);

workspacesRouter.put(
  "/:owner/:repo/css/source",
  // Stylesheets up to 2 MB, and JSON escaping adds to it.
  express.json({ limit: "3mb" }),
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file, content, version } = req.body ?? {};
    const css = await saveCss(key, file, content, version);
    res.json({ css, status: await getStatus(key) });
  }),
);

/* Adds scripts/edit-md.js (markdown edits with Claude) to a copy made before it existed, from the template. */

workspacesRouter.post(
  "/:owner/:repo/install/md-edit",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const files = {};
    for (const file of MD_EDIT_FILES) {
      const content = await readRepoFile(accessToken, config.siteTemplate, file);
      if (content === null) {
        throw new WorkspaceError(`The template (${config.siteTemplate}) doesn't have ${file} yet. Push it to GitHub first.`, 409);
      }
      files[file] = content;
    }
    const result = await installMdEdit(key, files);
    res.json({ ...result, status: await getStatus(key) });
  }),
);

/* Publishing with GitHub Pages: the copy's deploy workflow publishes every push to its default branch. */

const repoName = (req) => `${req.params.owner}/${req.params.repo}`;

workspacesRouter.get(
  "/:owner/:repo/publishing",
  handle(async (req, res) => {
    keyFor(req);
    res.json(await getPublishing(await getAccessToken(req, res), repoName(req)));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/publishing/enable",
  handle(async (req, res) => {
    keyFor(req);
    const accessToken = await getAccessToken(req, res);
    await enablePages(accessToken, repoName(req));
    res.json(await getPublishing(accessToken, repoName(req)));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/publishing/deploy",
  handle(async (req, res) => {
    keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const before = await getPublishing(accessToken, repoName(req));
    if (!before.workflowReady) {
      throw new WorkspaceError("Update the publishing files and push them first, or the site's links will break.", 409);
    }
    await startDeploy(accessToken, repoName(req), before.defaultBranch);
    res.json(before);
  }),
);

/* A custom domain for the published site: set or remove it, HTTPS, and GitHub's DNS check. */

workspacesRouter.put(
  "/:owner/:repo/publishing/domain",
  handle(async (req, res) => {
    keyFor(req);
    const raw = req.body?.domain;
    const domain = raw === null || raw === "" ? null : normalizeDomain(raw);
    res.json(await setDomain(await getAccessToken(req, res), repoName(req), domain));
  }),
);

workspacesRouter.put(
  "/:owner/:repo/publishing/https",
  handle(async (req, res) => {
    keyFor(req);
    if (typeof req.body?.enforced !== "boolean") throw new WorkspaceError("Say whether to enforce HTTPS.", 400);
    res.json(await setHttps(await getAccessToken(req, res), repoName(req), req.body.enforced));
  }),
);

workspacesRouter.get(
  "/:owner/:repo/publishing/domain-check",
  handle(async (req, res) => {
    keyFor(req);
    res.json(await checkDomain(await getAccessToken(req, res), repoName(req)));
  }),
);

/* Brings the template's publishing files into a copy made before it could publish under /<repo>. */

workspacesRouter.post(
  "/:owner/:repo/install/publishing",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const files = {};
    for (const file of PUBLISHING_FILES) {
      const content = await readRepoFile(accessToken, config.siteTemplate, file);
      if (content === null || (file.endsWith("deploy.yml") && !content.includes("BASE_PATH"))) {
        throw new WorkspaceError(`The template (${config.siteTemplate}) doesn't have the new ${file} yet. Push it to GitHub first.`, 409);
      }
      files[file] = content;
    }
    const result = await updateFromTemplate(key, files, "updating the publishing files");
    res.json({ ...result, status: await getStatus(key) });
  }),
);

/* SEO: the audit scripts/seo.js saved, and the files older copies need for it. */

workspacesRouter.get(
  "/:owner/:repo/seo",
  handle(async (req, res) => res.json(await readSeo(keyFor(req)))),
);

workspacesRouter.post(
  "/:owner/:repo/install/seo",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const files = {};
    for (const file of SEO_FILES) {
      const content = await readRepoFile(accessToken, config.siteTemplate, file);
      if (content === null || (SEO_MARKERS[file] && !content.includes(SEO_MARKERS[file]))) {
        throw new WorkspaceError(`The template (${config.siteTemplate}) doesn't have the new ${file} yet. Push it to GitHub first.`, 409);
      }
      files[file] = content;
    }
    const result = await installSeo(key, files);
    res.json({ ...result, status: await getStatus(key) });
  }),
);

/* Claude edit previews: the full proposed page, applied as-is or after the user edits it. */

workspacesRouter.get(
  "/:owner/:repo/proposal",
  handle(async (req, res) => res.json({ proposal: await readProposal(keyFor(req)) })),
);

workspacesRouter.post(
  "/:owner/:repo/proposal/apply",
  handle(async (req, res) => {
    const key = keyFor(req);
    const applied = await applyProposal(key, req.body?.content);
    res.json({ ...applied, status: await getStatus(key) });
  }),
);

/* Claude's memory of earlier work: the work log every Claude command reads first. */

workspacesRouter.get(
  "/:owner/:repo/memory",
  handle(async (req, res) => res.json(await readMemory(keyFor(req)))),
);

workspacesRouter.post(
  "/:owner/:repo/memory/forget",
  handle(async (req, res) => {
    const key = keyFor(req);
    const memory = await forgetMemoryLine(key, req.body?.line);
    res.json({ ...memory, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/memory/replace",
  handle(async (req, res) => {
    const key = keyFor(req);
    const memory = await replaceMemoryLine(key, req.body?.line, req.body?.replacement);
    res.json({ ...memory, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/memory/clear",
  handle(async (req, res) => {
    const key = keyFor(req);
    const memory = await clearMemory(key);
    res.json({ ...memory, status: await getStatus(key) });
  }),
);

workspacesRouter.delete(
  "/:owner/:repo/proposal",
  handle(async (req, res) => {
    await clearProposal(keyFor(req));
    res.json({ proposal: null });
  }),
);

/* Images Claude can see and place in a page. */

workspacesRouter.get(
  "/:owner/:repo/images",
  handle(async (req, res) => res.json({ images: await listImages(keyFor(req)) })),
);

workspacesRouter.get(
  "/:owner/:repo/images/file",
  handle(async (req, res) => {
    const { file, type } = await readImage(keyFor(req), req.query.path);
    // Raster images only (no SVG), and never rendered as anything else.
    res.set({ "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    res.type(type).sendFile(file);
  }),
);

workspacesRouter.post(
  "/:owner/:repo/uploads",
  express.json({ limit: "8mb" }),
  handle(async (req, res) => res.status(201).json(await saveUpload(keyFor(req), req.body ?? {}))),
);

/* An existing HTML page for Claude to convert into one of the site's pages. */

workspacesRouter.post(
  "/:owner/:repo/html-source",
  // Up to 6 MB of HTML and CSS, and JSON escaping adds to it.
  express.json({ limit: "8mb" }),
  handle(async (req, res) => res.status(201).json(await saveHtmlSource(keyFor(req), req.body ?? {}))),
);

/* The site's logo, favicon and name (site.config.json → brand), with uploads to assets/img/brand/. */

workspacesRouter.get(
  "/:owner/:repo/brand",
  handle(async (req, res) => res.json(await getBrand(keyFor(req)))),
);

workspacesRouter.put(
  "/:owner/:repo/brand",
  handle(async (req, res) => {
    const key = keyFor(req);
    const brand = await saveBrand(key, req.body?.brand);
    res.json({ ...brand, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/brand/image",
  // Logos up to 2 MB, and base64 adds a third.
  express.json({ limit: "3mb" }),
  handle(async (req, res) => res.status(201).json(await saveBrandImage(keyFor(req), req.body ?? {}))),
);

/* The header and footer (content/data/navigation.json): menus, button, footer columns, legal links and their look. */

workspacesRouter.get(
  "/:owner/:repo/navigation",
  handle(async (req, res) => res.json(await getNavigation(keyFor(req)))),
);

workspacesRouter.put(
  "/:owner/:repo/navigation",
  handle(async (req, res) => {
    const key = keyFor(req);
    const navigation = await saveNavigation(key, req.body?.navigation, req.body?.version);
    res.json({ ...navigation, status: await getStatus(key) });
  }),
);

/* A page that adds itself to the header menu, the footer or both (its frontmatter `menu`). */

workspacesRouter.put(
  "/:owner/:repo/navigation/page-menu",
  handle(async (req, res) => {
    const key = keyFor(req);
    await setPageMenu(key, req.body?.file, req.body?.menu ?? null);
    res.json({ status: await getStatus(key) });
  }),
);

/* Brings the template's header, footer and content.js into a copy made before they had appearance settings. */

workspacesRouter.post(
  "/:owner/:repo/install/header-footer",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const files = {};
    for (const file of HEADER_FOOTER_FILES) {
      const content = await readRepoFile(accessToken, config.siteTemplate, file);
      const marker = HEADER_FOOTER_MARKERS[file] ?? APPEARANCE_MARKER;
      if (content === null || !content.includes(marker)) {
        throw new WorkspaceError(`The template (${config.siteTemplate}) doesn't have the new ${file} yet. Push it to GitHub first.`, 409);
      }
      files[file] = content;
    }
    const result = await updateFromTemplate(key, files, "updating the header and footer templates");
    res.json({ ...result, status: await getStatus(key) });
  }),
);

/* Static information: site-wide facts in site.config.json and content/data/. */

workspacesRouter.get(
  "/:owner/:repo/static-info",
  handle(async (req, res) => res.json(await getStaticInfo(keyFor(req)))),
);

workspacesRouter.put(
  "/:owner/:repo/static-info/:section",
  handle(async (req, res) => res.json(await saveStaticInfo(keyFor(req), req.params.section, req.body?.data))),
);

workspacesRouter.get(
  "/:owner/:repo/schedule",
  handle(async (req, res) => res.json(await readSchedule(keyFor(req)))),
);

workspacesRouter.put(
  "/:owner/:repo/schedule",
  handle(async (req, res) => res.json(await writeSchedule(keyFor(req), req.body?.jobs))),
);

/* ------------------------------------------------------------------- jobs */

export const jobsRouter = Router();
jobsRouter.use(requireAuth, requireJson);

jobsRouter.get(
  "/:id",
  handle(async (req, res) => {
    const job = getJob(req.params.id, req.user.id);
    if (!job) throw new WorkspaceError("Job not found. It may have expired or the server restarted.", 404);
    const since = Number(req.query.since ?? 0);
    res.json({ job: serializeJob(job, Number.isFinite(since) && since > 0 ? since : 0) });
  }),
);

jobsRouter.post(
  "/:id/cancel",
  handle(async (req, res) => {
    const job = getJob(req.params.id, req.user.id);
    if (!job) throw new WorkspaceError("Job not found.", 404);
    cancelJob(job);
    res.json({ job: serializeJob(job, Number.MAX_SAFE_INTEGER) });
  }),
);
