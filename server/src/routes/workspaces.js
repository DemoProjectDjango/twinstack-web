import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { Router } from "express";
import { COMMANDS, jobEnv } from "../commands.js";
import { describeTaskSize, taskSize } from "../task-size.js";
import { usageTarget } from "../usage-history.js";
import { publicJobView } from "../model-words.js";
import { listOriginalPages, prepareOriginalPage } from "../original-pages.js";
import { importZip, newZipUpload, receiveZipChunk } from "../site-zip.js";
import { DEFAULT_PAGES, MAX_PAGES, clearCopiedWebsite, copiedPageShot, copyWebsiteStep, finishCopiedWebsite, normaliseStartUrl, prepareCopiedPage, readCopiedWebsite } from "../copy-website.js";
import { config } from "../config.js";
import { getClaudeModel, getSiteDisplayName, noteSetupPublished, noteSetupSignal } from "../db.js";
import { issueProxyToken } from "../claude-proxy.js";
import { ClaudeAccessError, beginClaudeActivity, beginSpend, claudeKeyFor } from "../credits.js";
import { FastModelError, chooseSiteFastModel, fastModelForSite, siteFastModelView } from "../fast-model.js";
import { ImageModelError, chooseSiteImageModel, siteImageModelView } from "../image-model.js";
import { fastModelForTier, imageModelForTier, neutralFastView, neutralImageView } from "../model-tiers.js";
import { acceptIncoming, incomingChanges } from "../github-changes.js";
import { clashForAi, resolveForPublish, syncForPublish } from "../publish-sync.js";
import { syncSiteTree } from "../site-tree-sync.js";
import { getAccessToken } from "../github.js";
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
import { getNextSteps, sampleContent } from "../next-steps.js";
import { FIRST_DESIGN_EFFORT, REVIEW_MODEL, designReviews, firstDesign, firstDesignModel } from "../first-design.js";
import { analyticsRouter } from "./analytics.js";
import { agentRouter } from "./site-agent.js";
import { assistantRouter } from "./assistant.js";
import { handle, keyFor, requireJson } from "./helpers.js";
import {
  applyProposal,
  clearProposal,
  collectWorkLog,
  createHomepage,
  createListingPage,
  createPageAt,
  deletePage,
  MD_EDIT_FILES,
  getOverview,
  installMdEdit,
  listCss,
  listImages,
  readCss,
  readScripts,
  readDataFile,
  readImage,
  readMemory,
  readPage,
  readProposal,
  readSchedule,
  savePage,
  prepareWorkLog,
  saveCss,
  saveScripts,
  saveHtmlSource,
  saveUpload,
  setPageDraft,
  updateFromTemplate,
  WORK_LOG_FOR_RUN,
  writeDataFile,
  writeSchedule,
  logOwnerEdit,
  logQuote,
  logWork,
  pageAddresses,
  frontmatter,
} from "../site-files.js";
import { getStaticInfo, saveStaticInfo, staticInfoSection } from "../static-info.js";
import { getBrand, replaceHeaderLogo, saveBrand, saveBrandImage } from "../brand.js";
import { stepHistory, undoState } from "../undo-history.js";
import { fileUsage, listRepoFiles, prepareUploadedPage, removeConvertedPage, removeRepoFile, uploadRepoFile } from "../repo-files.js";
import { planSetup, saveSetup } from "../site-setup.js";
import { pendingBuild } from "../setup-build.js";
import { APPEARANCE_MARKER, HEADER_FOOTER_FILES, HEADER_FOOTER_MARKERS, getNavigation, saveNavigation, setPageMenu } from "../navigation.js";
import { SEO_FILES, SEO_MARKERS, installSeo, readSeo } from "../seo.js";
import { readCheckReport } from "../site-check.js";
import { readMissingPages } from "../missing-pages.js";
import { editPreviewText, stylePreviewText } from "../text-edit.js";
import { claudeResolver, getUpdateStatus, siteUpdateSteps, undoSiteUpdate } from "../site-update.js";
import { readTemplateFile, templateToken } from "../sites.js";
import { listVersions, restoreVersion } from "../versions.js";
import {
  WorkspaceError,
  acquire,
  commitAndPush,
  discardChanges,
  getDiff,
  getStatus,
  openWorkspace,
  resetToDefault,
  siteIdFor,
  workspaceDir,
} from "../workspace.js";

/* ------------------------------------------------------------- workspaces */

export const workspacesRouter = Router();
// Who may open which site is decided in openWorkspace: a copy recorded by
// Duplicate (see sites.js) that the user can push to on GitHub.
workspacesRouter.use(requireAuth, requireGithub, requireJson);
// "Ask Claude": the site's conversation and the changes it proposes (routes/assistant.js).
workspacesRouter.use("/:owner/:repo/assistant", assistantRouter);
// The site's visits, for its creator only (routes/analytics.js).
workspacesRouter.use("/:owner/:repo/analytics", analyticsRouter);
// The site agent's settings and history, for its creator only (routes/site-agent.js).
workspacesRouter.use("/:owner/:repo/agent", agentRouter);

workspacesRouter.post(
  "/:owner/:repo/open",
  handle(async (req, res) => {
    keyFor(req);
    const accessToken = await getAccessToken(req, res);
    res.json(await openWorkspace({ accessToken, userId: req.user.id, owner: req.params.owner, repo: req.params.repo, editor: req.editorId }));
  }),
);

workspacesRouter.get(
  "/:owner/:repo",
  handle(async (req, res) => res.json(await getStatus(keyFor(req)))),
);

workspacesRouter.get(
  "/:owner/:repo/overview",
  handle(async (req, res) => {
    const key = keyFor(req);
    const [overview, displayName] = await Promise.all([getOverview(key), siteIdFor(key).then(getSiteDisplayName).catch(() => null)]);
    res.json({ ...overview, displayName });
  }),
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
    const key = keyFor(req);
    const result = await discardChanges(key, paths);
    // Throwing changes away in a new site's first week: a sign its setup missed something.
    siteIdFor(key).then((siteId) => noteSetupSignal(siteId, "discards"), () => {});
    res.json(result);
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
    siteIdFor(key).then(noteSetupPublished, () => {});
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

// Site commands that can make or remove pages (`new`, the site plan's scaffold, a new section, the
// schedule, the setup's build): the page plan (scripts/site-tree.md) is brought in step after them.
const PAGE_COMMANDS = new Set(["new", "scaffold", "nav-add", "schedule", "site-build"]);

// Before publishing (publish-sync.js): catch up with what others published, combining it with this
// browser's unpublished work; files both changed in the same places are shown to the owner to settle.
const PUBLISHED_SHA = /^[a-f0-9]{40}$/;

workspacesRouter.post(
  "/:owner/:repo/publish/sync",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const result = await syncForPublish({ key, accessToken });
    if (!result.clashes && result.subjects.length) await logIncoming(key, result.subjects);
    res.json({ ...result, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/publish/resolve",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { sha, resolutions } = req.body ?? {};
    if (typeof sha !== "string" || !PUBLISHED_SHA.test(sha)) throw new WorkspaceError("Unknown changes.", 400);
    const accessToken = await getAccessToken(req, res);
    const result = await resolveForPublish({ key, accessToken, sha, resolutions });
    await logIncoming(key, result.subjects);
    res.json(result);
  }),
);

// Claude's suggestion for one clashing file: shown to the owner to keep or change, never written here.
workspacesRouter.post(
  "/:owner/:repo/publish/combine",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { sha, file } = req.body ?? {};
    if (typeof sha !== "string" || !PUBLISHED_SHA.test(sha) || typeof file !== "string" || file.length > 500) throw new WorkspaceError("Unknown file.", 400);
    const clash = await clashForAi({ key, sha, file });
    const userId = req.user.id;
    let claude;
    try {
      claude = await claudeKeyFor(userId);
    } catch (err) {
      if (!(err instanceof ClaudeAccessError)) throw err;
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    const model = await getClaudeModel(userId);
    const siteId = await siteIdFor(key).catch(() => null);
    const runId = randomUUID();
    const resolve = claudeResolver(claude.apiKey, model, () => beginSpend({ userId, siteId, runId, kind: "publish-combine", charged: claude.charged }));
    const endActivity = beginClaudeActivity(userId);
    try {
      const content = await resolve(clash);
      res.json({ content: Buffer.isBuffer(content) ? content.toString("utf8") : content });
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(`The AI couldn't combine ${file} (${err.message.replace(/\.$/, "")}). Choose what to keep yourself.`, 502);
    } finally {
      endActivity();
    }
  }),
);

/** So the AI knows the site changed without it. */
async function logIncoming(key, subjects) {
  if (!subjects.length) return;
  await logWork(key, { command: "github-changes", file: "the site's repository", instruction: `Brought in changes published elsewhere: ${subjects.join("; ")}`.slice(0, 1000), summary: [] }).catch((err) =>
    console.error("Couldn't log the published changes:", err.message),
  );
}

// Changes pushed to GitHub from outside the editor: what they are, and bringing them in.
workspacesRouter.get(
  "/:owner/:repo/incoming",
  handle(async (req, res) => {
    res.json({ incoming: await incomingChanges(keyFor(req)) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/incoming/accept",
  handle(async (req, res) => {
    const key = keyFor(req);
    const sha = req.body?.sha;
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new WorkspaceError("Unknown changes.", 400);
    const accessToken = await getAccessToken(req, res);
    // Brought in only when it combines by itself; a clash waits for Publish (publish-sync.js).
    const accepted = await acceptIncoming({ key, accessToken, sha });
    const { subjects, ...result } = accepted;
    await logIncoming(key, subjects);
    res.json(result);
  }),
);

/** Whether the copy's page editor reads TWINSTACK_TASK_SIZE (task-size.js). */
async function supportsTaskSize(key) {
  const script = await readFile(path.join(workspaceDir(key), "scripts", "edit-page.js"), "utf8").catch(() => "");
  return script.includes("TWINSTACK_TASK_SIZE");
}

/** The title and own address of the page a command works on (`input.page`), or null. */
async function pageFields(key, input) {
  if (typeof input?.page !== "string") return null;
  const { content } = await readPage(key, input.page);
  const fields = frontmatter(content);
  return { title: fields.title || null, url: fields.url || null };
}

workspacesRouter.post(
  "/:owner/:repo/commands/:command",
  handle(async (req, res) => {
    const key = keyFor(req);
    const name = req.params.command;
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
    if (!command) throw new WorkspaceError("Unknown command.", 404);

    const status = await getStatus(key);
    if (status.needsInstall && name !== "install") {
      // The editor installs and runs the command again by itself (SiteManager's `start`).
      throw new WorkspaceError("Your site's tools need setting up first. It takes a minute or two.", 409, "needs_install");
    }
    const input = req.body?.input ?? {};
    const steps = command.steps(input);
    const needsKey = command.needsKey?.(input) ?? false;
    let claude = null;
    if (needsKey) {
      try {
        claude = await claudeKeyFor(req.user.id);
      } catch (err) {
        if (!(err instanceof ClaudeAccessError)) throw err;
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
    }

    const release = acquire(key, command.label);
    let env = jobEnv(null, null);
    // On credits the script gets a job token for the metering proxy, never the app's key.
    let proxy = null;
    let endActivity = () => {};
    let workLog = null;
    let pagesBefore = null;
    // How big the request is (task-size.js), when the cheaper model is in play at all.
    let sized = null;
    // The site's first homepage or header and footer (first-design.js), and the model that writes it.
    let first = null;
    // How many times the page writer looks at screenshots of its page and improves it.
    let reviews = 0;
    try {
      if (claude) {
        let model = await getClaudeModel(req.user.id);
        first = command.claude ? await firstDesign(key, name, input).catch(() => null) : null;
        if (first) model = firstDesignModel(model, first);
        if (claude.charged) {
          const siteId = await siteIdFor(key).catch(() => null);
          // What the job works on, so the owner's usage history can name the part of the site.
          const target = usageTarget(name, input, await pageFields(key, input).catch(() => null));
          proxy = issueProxyToken({ userId: req.user.id, siteId, command: name, target });
          // The site's own choice of the cheaper model, else the admin's.
          let fastModel = first ? null : await fastModelForSite(siteId);
          if (fastModel && command.sized) {
            sized = taskSize(command.sized(input));
            // Copies made before sizing ignore TWINSTACK_TASK_SIZE: keep complex work off the
            // cheaper model by not offering it to them.
            if (sized.size === "complex" && !(await supportsTaskSize(key))) fastModel = null;
          }
          env = jobEnv(proxy.apiKey, model, proxy.baseUrl, fastModel, sized?.size);
        } else {
          env = jobEnv(claude.apiKey, model);
        }
        if (first) env.TWINSTACK_EFFORT = FIRST_DESIGN_EFFORT;
        reviews = designReviews(name, first);
        if (reviews) {
          env.TWINSTACK_DESIGN_REVIEW = String(reviews);
          env.TWINSTACK_REVIEW_MODEL = REVIEW_MODEL;
        }
        endActivity = beginClaudeActivity(req.user.id);
      }
      await command.prepare?.(key, input);
      // Claude reads the site's latest work log before every run, merged or not.
      if (command.claude) workLog = await prepareWorkLog(key);
      if (workLog) env.TWINSTACK_WORK_LOG = WORK_LOG_FOR_RUN;
      // Commands that can make or remove pages: the page plan follows what they did.
      if (PAGE_COMMANDS.has(name) && !input?.dryRun) pagesBefore = await pageAddresses(key).catch(() => null);
    } catch (err) {
      proxy?.revoke();
      endActivity();
      release();
      throw err;
    }
    const finish = async () => {
      try {
        if (pagesBefore) {
          const after = await pageAddresses(key).catch(() => null);
          if (after) await syncSiteTree(workspaceDir(key), pagesBefore, after);
        }
      } finally {
        proxy?.revoke();
        endActivity();
        release();
      }
    };
    // A command whose steps need the job's env and who's paying (site-build's picture).
    const commandSteps = command.withContext
      ? command.withContext({ env, userId: req.user.id, siteId: await siteIdFor(key).catch(() => null), charged: Boolean(claude?.charged) })
      : steps;
    const job = startJob({
      key,
      userId: req.user.id,
      command: name,
      label: command.label,
      // The size, and a first design's model, go at the top of the job's log, so the Build tools
      // screen shows why a model ran.
      steps: [
        ...(sized ? [{ display: describeTaskSize(sized), run: () => {} }] : []),
        ...(first ? [{ display: `The site's first ${first}: written by ${env.TWINSTACK_MODEL ?? "the site's own model"} at ${FIRST_DESIGN_EFFORT} effort, never the cheaper model.`, run: () => {} }] : []),
        ...(reviews ? [{ display: `Then looked at in a browser and improved by ${REVIEW_MODEL}, up to ${reviews} time${reviews === 1 ? "" : "s"}.`, run: () => {} }] : []),
        ...commandSteps,
      ],
      cwd: workspaceDir(key),
      env,
      // Saved before the lock is released, so no later run rewrites the file first. A
      // failed queue run may still have written (and logged) the edits before it failed.
      release: workLog ? () => collectWorkLog(key, workLog).finally(finish) : finish,
      onSuccess: command.onSuccess && (() => command.onSuccess(key)),
      onEnd: command.onEnd && ((result) => command.onEnd(key, result)),
    });
    // Claude work in a new site's first week, for the setup numbers.
    if (command.claude) siteIdFor(key).then((siteId) => noteSetupSignal(siteId, "commands"), () => {});
    res.status(202).json({ job: publicJobView(job, { admin: req.user.admin }) });
  }),
);

workspacesRouter.get(
  "/:owner/:repo/files/:name",
  handle(async (req, res) => res.json(await readDataFile(keyFor(req), req.params.name))),
);

workspacesRouter.put(
  "/:owner/:repo/files/:name",
  handle(async (req, res) => {
    const key = keyFor(req);
    const file = await writeDataFile(key, req.params.name, req.body?.content);
    await logOwnerEdit(key, { command: "owner:edit-file", file: file.path, instruction: "The owner edited the file by hand" });
    res.json(file);
  }),
);

/*
 * The site's own AI models: the fast model for routine work (fast-model.js) and the image model for
 * pictures (image-model.js). "default" follows the admin's choice on /admin/models.
 */

async function openSiteId(req) {
  try {
    return await siteIdFor(keyFor(req));
  } catch {
    throw new WorkspaceError("Open the site first.", 409);
  }
}

// Owners see neutral choices (model-tiers.js: "Best quality", "Balanced", "Fastest and cheapest"),
// never a model's name; admins also get the names behind them.
const aiModels = async (siteId, user) => {
  const admin = user?.admin === true;
  return {
    fast: neutralFastView(await siteFastModelView(siteId), { admin }),
    image: neutralImageView(await siteImageModelView(siteId), { admin }),
  };
};

workspacesRouter.get(
  "/:owner/:repo/ai-models",
  handle(async (req, res) => res.json(await aiModels(await openSiteId(req), req.user))),
);

/** `{ kind: "fast" | "image", choice }`: "default" or a tier id (model-tiers.js). */
workspacesRouter.put(
  "/:owner/:repo/ai-models",
  handle(async (req, res) => {
    const siteId = await openSiteId(req);
    const { kind } = req.body ?? {};
    // `model` is the name older pages sent the choice under.
    const choice = req.body?.choice ?? req.body?.model;
    if (kind !== "fast" && kind !== "image") throw new WorkspaceError("Choose which setting to change.", 400);
    if (typeof choice !== "string" || !choice) throw new WorkspaceError("Choose one of the options.", 400);
    try {
      const model = kind === "fast" ? fastModelForTier(choice, await siteFastModelView(siteId)) : imageModelForTier(choice, await siteImageModelView(siteId));
      if (model === undefined) throw new WorkspaceError("Choose one of the options.", 400);
      if (model === null) throw new WorkspaceError("That option isn't available right now. Choose another.", 400);
      if (kind === "fast") await chooseSiteFastModel(siteId, model, req.user.id);
      else await chooseSiteImageModel(siteId, model, req.user.id);
    } catch (err) {
      // Their messages can name a model or a server setting: owners get plain words.
      if (err instanceof FastModelError || err instanceof ImageModelError) throw new WorkspaceError(req.user.admin ? err.message : "That option couldn't be saved. Try again, or choose another.", 400);
      throw err;
    }
    res.json(await aiModels(siteId, req.user));
  }),
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
    await logOwnerEdit(key, { command: "owner:edit-page", file, instruction: "The owner edited the page by hand" });
    res.json({ page, status: await getStatus(key) });
  }),
);

/* Text typed straight into the preview (the Home screen's "Edit text"): one element's text before and after. */

workspacesRouter.post(
  "/:owner/:repo/pages/text",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { address, before, after, index, count, tag } = req.body ?? {};
    const { file } = await editPreviewText(key, { address, before, after, index, count, tag });
    await logOwnerEdit(key, {
      command: "owner:edit-text",
      file,
      instruction: "The owner changed text on the site",
      point: `“${logQuote(before, 60)}” → “${logQuote(after, 60)}”`,
    });
    res.json({ file, status: await getStatus(key), history: await undoState(key) });
  }),
);

/* The preview's style bar: bold/italic/underline on picked words, or a text's alignment or colour (text-edit.js). No AI, no credits. */

workspacesRouter.post(
  "/:owner/:repo/pages/style",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { address, text, index, count, tag, selection, style } = req.body ?? {};
    const { file } = await stylePreviewText(key, { address, text, index, count, tag, selection, style });
    const what = { bold: "made words bold", italic: "made words italic", underline: "underlined words", align: `aligned text ${style?.value}`, color: style?.value ? `coloured text ${style.value}` : "reset a text colour" }[style?.kind] ?? "styled text";
    await logOwnerEdit(key, { command: "owner:style-text", file, instruction: `The owner ${what} on the site`, point: `“${logQuote(text, 60)}”` });
    res.json({ file, status: await getStatus(key), history: await undoState(key) });
  }),
);

/* Undo and redo of the owner's own edits in the preview (undo-history.js): Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y. */

workspacesRouter.get(
  "/:owner/:repo/pages/history",
  handle(async (req, res) => res.json({ history: await undoState(keyFor(req)) })),
);

for (const direction of ["undo", "redo"]) {
  workspacesRouter.post(
    `/:owner/:repo/pages/${direction}`,
    handle(async (req, res) => {
      const key = keyFor(req);
      const result = await stepHistory(key, direction);
      await logOwnerEdit(key, { command: `owner:${direction}`, file: result.file, instruction: `The owner ${direction === "undo" ? "undid" : "redid"} a ${result.label}` });
      res.json({ ...result, status: await getStatus(key) });
    }),
  );
}

/* Hides a page from visitors, or shows it again (the Pages list's page menu). */

workspacesRouter.put(
  "/:owner/:repo/pages/draft",
  handle(async (req, res) => {
    const key = keyFor(req);
    await setPageDraft(key, req.body?.file, req.body?.draft);
    await logOwnerEdit(key, {
      command: "owner:page-visibility",
      file: req.body?.file,
      instruction: req.body?.draft ? "The owner hid the page from visitors" : "The owner showed the page to visitors again",
    });
    res.json({ status: await getStatus(key) });
  }),
);

/* The homepage and collection listing pages (the Blog page), which "Add a page" can't make: their address isn't their name. */

workspacesRouter.post(
  "/:owner/:repo/pages/homepage",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file } = await createHomepage(key, { title: req.body?.title });
    await logOwnerEdit(key, { command: "owner:new-page", file, instruction: "The owner made the homepage" });
    res.json({ file, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/pages/listing",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file } = await createListingPage(key, req.body?.collection, { title: req.body?.title });
    await logOwnerEdit(key, { command: "owner:new-page", file, instruction: "The owner made the listing page" });
    res.json({ file, status: await getStatus(key) });
  }),
);

/* A page at the exact address a link already points to (a missing page the editor offers to make). */

workspacesRouter.post(
  "/:owner/:repo/pages/at",
  handle(async (req, res) => {
    const key = keyFor(req);
    const { file } = await createPageAt(key, { url: req.body?.url, title: req.body?.title });
    await logOwnerEdit(key, { command: "owner:new-page", file, instruction: `The owner made a page at ${logQuote(req.body?.url, 120)}` });
    res.json({ file, status: await getStatus(key) });
  }),
);

/* A repo's own .html pages, from before the site tools were added (original-pages.js), and getting one ready for page-convert. */

workspacesRouter.get(
  "/:owner/:repo/original-pages",
  handle(async (req, res) => res.json({ pages: await listOriginalPages(keyFor(req)) })),
);

/* Upload a website (.zip) (site-zip.js): pieces of the zip, then unpacking it into the site. */

workspacesRouter.post(
  "/:owner/:repo/site-zip/start",
  handle(async (req, res) => {
    keyFor(req);
    res.json(newZipUpload());
  }),
);

workspacesRouter.post(
  "/:owner/:repo/site-zip/chunk",
  // Pieces of up to 8 MB, and base64 adds a third (its own limit: see UPLOAD_PATH in index.js).
  express.json({ limit: "12mb" }),
  handle(async (req, res) => res.json(await receiveZipChunk(keyFor(req), req.body ?? {}))),
);

workspacesRouter.post(
  "/:owner/:repo/site-zip/finish",
  handle(async (req, res) => {
    const key = keyFor(req);
    const result = await importZip(key, req.body ?? {});
    await logOwnerEdit(key, { command: "owner:files", file: "static/", instruction: `The owner uploaded a website as a zip: ${result.pages.length} pages and ${result.files} files` });
    res.json({ ...result, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/original-pages/prepare",
  handle(async (req, res) => {
    const key = keyFor(req);
    const prepared = await prepareOriginalPage(key, req.body?.file);
    res.json({ ...prepared, status: await getStatus(key) });
  }),
);

/*
 * Copy a website (copy-website.js): a job opens the website's pages in a browser and keeps them,
 * with their pictures, fonts and styles; each page is then brought in with page-convert, like an
 * original page, and "finish" points links to pages that didn't come in back at the old website.
 */

workspacesRouter.get(
  "/:owner/:repo/copy-website",
  handle(async (req, res) => res.json({ copy: await readCopiedWebsite(keyFor(req)), limits: { pages: DEFAULT_PAGES, maxPages: MAX_PAGES } })),
);

workspacesRouter.post(
  "/:owner/:repo/copy-website",
  handle(async (req, res) => {
    const key = keyFor(req);
    const url = normaliseStartUrl(req.body?.url);
    // The owner says the website is theirs, or that they may copy it: its words, pictures and
    // design belong to someone.
    if (req.body?.permission !== true) throw new WorkspaceError("Confirm that the website is yours or that you have permission to copy it.", 400);
    const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(req.body?.maxPages) || DEFAULT_PAGES));
    const release = acquire(key, "copying a website");
    try {
      const job = startJob({
        key,
        userId: req.user.id,
        command: "copy-website",
        label: "Copy a website",
        steps: [copyWebsiteStep(key, { url, maxPages })],
        cwd: workspaceDir(key),
        env: jobEnv(null, null),
        release,
      });
      res.status(202).json({ job: publicJobView(job, { admin: req.user.admin }) });
    } catch (err) {
      release();
      throw err;
    }
  }),
);

workspacesRouter.post(
  "/:owner/:repo/copy-website/prepare",
  handle(async (req, res) => {
    const key = keyFor(req);
    const id = String(req.body?.id ?? "");
    if (!/^\d{2}$/.test(id)) throw new WorkspaceError("Which copied page?", 400);
    const prepared = await prepareCopiedPage(key, id);
    res.json({ ...prepared, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/copy-website/finish",
  handle(async (req, res) => {
    const key = keyFor(req);
    const result = await finishCopiedWebsite(key);
    res.json({ ...result, status: await getStatus(key) });
  }),
);

workspacesRouter.get(
  "/:owner/:repo/copy-website/shots/:id/:screen",
  handle(async (req, res) => {
    const bytes = await copiedPageShot(keyFor(req), req.params.id, req.params.screen);
    if (!bytes) throw new WorkspaceError("There's no picture of that page.", 404);
    res.set("cache-control", "private, max-age=300").type("image/jpeg").send(bytes);
  }),
);

workspacesRouter.delete(
  "/:owner/:repo/copy-website",
  handle(async (req, res) => {
    await clearCopiedWebsite(keyFor(req));
    res.json({ ok: true });
  }),
);

/* Removes one page (the Pages screen's "Delete"). It can be undone on the Publish screen until it's published. */

workspacesRouter.delete(
  "/:owner/:repo/pages/source",
  handle(async (req, res) => {
    const key = keyFor(req);
    await deletePage(key, req.query.file);
    await logOwnerEdit(key, { command: "owner:delete-page", file: String(req.query.file ?? ""), instruction: "The owner deleted the page" });
    res.json({ status: await getStatus(key) });
  }),
);

/* The pages the site links to but doesn't have, as the last build found them, with the pages nothing links to. */

workspacesRouter.get(
  "/:owner/:repo/missing-pages",
  handle(async (req, res) => res.json(await readMissingPages(keyFor(req)))),
);

/* What the site still needs, for the Ask Claude panel's "Next steps" (next-steps.js; no Claude). */

workspacesRouter.get(
  "/:owner/:repo/next-steps",
  handle(async (req, res) => res.json(await getNextSteps(keyFor(req)))),
);

/* What the last "Build and check" found (the deploy's own check), and whether the site changed since. */

workspacesRouter.get(
  "/:owner/:repo/check",
  // With the sample items still on the site, which publishing warns about (next-steps.js).
  handle(async (req, res) => {
    const key = keyFor(req);
    const [check, samples] = await Promise.all([readCheckReport(key), sampleContent(key).catch(() => null)]);
    res.json({ ...check, samples });
  }),
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
    await logOwnerEdit(key, { command: "owner:edit-css", file, instruction: "The owner edited the stylesheet by hand" });
    res.json({ css, status: await getStatus(key) });
  }),
);

/* The repo's folders, and a file uploaded into one (repo-files.js). */

workspacesRouter.get(
  "/:owner/:repo/files",
  handle(async (req, res) => res.json(await listRepoFiles(keyFor(req)))),
);

workspacesRouter.post(
  "/:owner/:repo/files",
  // Files up to 10 MB, and base64 adds a third.
  express.json({ limit: "15mb" }),
  handle(async (req, res) => {
    const key = keyFor(req);
    const saved = await uploadRepoFile(key, req.body ?? {});
    await logOwnerEdit(key, {
      command: "owner:upload",
      file: saved.file,
      instruction: saved.replaced ? "The owner replaced the file" : "The owner added the file",
    });
    res.status(201).json({ saved, status: await getStatus(key) });
  }),
);

/* Removing a file, or a page made from an HTML file. The first says what still uses it, for the question asked before. */

workspacesRouter.get(
  "/:owner/:repo/file-usage",
  handle(async (req, res) => res.json({ usedBy: await fileUsage(keyFor(req), req.query.address, typeof req.query.page === "string" ? req.query.page : null) })),
);

workspacesRouter.delete(
  "/:owner/:repo/files",
  handle(async (req, res) => {
    const key = keyFor(req);
    await removeRepoFile(key, req.query.file);
    await logOwnerEdit(key, { command: "owner:remove-file", file: String(req.query.file ?? ""), instruction: "The owner removed the file" });
    res.json({ status: await getStatus(key) });
  }),
);

workspacesRouter.delete(
  "/:owner/:repo/files/page",
  handle(async (req, res) => {
    const key = keyFor(req);
    await removeConvertedPage(key, req.query.file);
    await logOwnerEdit(key, { command: "owner:delete-page", file: String(req.query.file ?? ""), instruction: "The owner deleted the page" });
    res.json({ status: await getStatus(key) });
  }),
);

/* An uploaded HTML file the owner wants as a page: made ready for the page-convert command. */

workspacesRouter.post(
  "/:owner/:repo/files/page",
  // The HTML with its stylesheets and scripts: 6 MB together, and JSON escaping adds to it.
  express.json({ limit: "8mb" }),
  handle(async (req, res) => {
    const key = keyFor(req);
    const prepared = await prepareUploadedPage(key, req.body ?? {});
    res.json({ ...prepared, status: await getStatus(key) });
  }),
);

/* Code from other services on the site's published pages (content/data/scripts.json). */

workspacesRouter.get(
  "/:owner/:repo/scripts",
  handle(async (req, res) => res.json(await readScripts(keyFor(req)))),
);

workspacesRouter.put(
  "/:owner/:repo/scripts",
  // Up to 20 scripts of 50 KB each, and JSON escaping adds to it.
  express.json({ limit: "3mb" }),
  handle(async (req, res) => {
    const key = keyFor(req);
    const scripts = await saveScripts(key, req.body?.items, req.body?.version);
    await logOwnerEdit(key, { command: "owner:scripts", file: "content/data/scripts.json", instruction: "The owner changed the scripts on the site" });
    res.json({ scripts, status: await getStatus(key) });
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
      const content = await readTemplateFile(req.user, accessToken, file);
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
      const content = await readTemplateFile(req.user, accessToken, file);
      if (content === null || (file.endsWith("deploy.yml") && !content.includes("BASE_PATH"))) {
        throw new WorkspaceError(`The template (${config.siteTemplate}) doesn't have the new ${file} yet. Push it to GitHub first.`, 409);
      }
      files[file] = content;
    }
    const result = await updateFromTemplate(key, files, "updating the publishing files");
    res.json({ ...result, status: await getStatus(key) });
  }),
);

/* One-click site updates: the template's newest release merged into the published site, keeping the owner's work (site-update.js). */

workspacesRouter.get(
  "/:owner/:repo/site-update",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    res.json(await getUpdateStatus(key, accessToken, templateToken(req.user, accessToken)));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/site-update",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    // Only for Claude combining files both sides changed, in this process; never handed to the site's scripts.
    // Without Claude the update still runs, and stops only if it needs a merge.
    const userId = req.user.id;
    const model = await getClaudeModel(userId);
    let claude = null;
    let noClaude = null;
    try {
      claude = await claudeKeyFor(userId);
    } catch (err) {
      if (!(err instanceof ClaudeAccessError)) throw err;
      noClaude = err.message;
    }
    const siteId = await siteIdFor(key).catch(() => null);
    // Every merge Claude does for this update is one entry in the credits history.
    const runId = randomUUID();
    const startSpend = () => beginSpend({ userId, siteId, runId, kind: "site-update", charged: claude.charged });
    const release = acquire(key, "updating the site");
    const endActivity = claude ? beginClaudeActivity(userId) : () => {};
    try {
      const { steps, cleanup } = siteUpdateSteps({ key, accessToken, templateToken: templateToken(req.user, accessToken), user: req.user.github, anthropicKey: claude?.apiKey ?? null, model, noClaude, beginSpend: startSpend });
      const job = startJob({
        key,
        userId: req.user.id,
        command: "site-update",
        label: "Update the site",
        steps,
        cwd: workspaceDir(key),
        env: jobEnv(null, null),
        release: () =>
          cleanup().finally(() => {
            endActivity();
            release();
          }),
      });
      res.status(202).json({ job: publicJobView(job, { admin: req.user.admin }) });
    } catch (err) {
      endActivity();
      release();
      throw err;
    }
  }),
);

workspacesRouter.post(
  "/:owner/:repo/site-update/undo",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const release = acquire(key, "undoing the site update");
    let result;
    try {
      result = await undoSiteUpdate({ key, accessToken });
    } finally {
      release();
    }
    res.json({ ...result, status: await getStatus(key) });
  }),
);

/* Earlier published versions, and restoring one as unpublished changes (versions.js). */

workspacesRouter.get(
  "/:owner/:repo/versions",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    // Only reads (and fetches), so it doesn't wait for the preview build.
    res.json(await listVersions({ key, accessToken }));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/versions/restore",
  handle(async (req, res) => {
    const key = keyFor(req);
    const accessToken = await getAccessToken(req, res);
    const release = acquire(key, "restoring an earlier version");
    let result;
    try {
      result = await restoreVersion({ key, accessToken, sha: req.body?.sha });
    } finally {
      release();
    }
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
      const content = await readTemplateFile(req.user, accessToken, file);
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
    await logOwnerEdit(key, { command: "owner:logo", file: "site.config.json", instruction: "The owner changed the logo and tab icon" });
    res.json({ ...brand, status: await getStatus(key) });
  }),
);

// A designed or copied header draws its own logo (brand.js headerLogoOf): this swaps that image.
workspacesRouter.put(
  "/:owner/:repo/brand/header-logo",
  handle(async (req, res) => {
    const key = keyFor(req);
    const brand = await replaceHeaderLogo(key, req.body?.path);
    await logOwnerEdit(key, { command: "owner:logo", file: "templates/partials/header.html", instruction: "The owner changed the logo in the header" });
    res.json({ ...brand, status: await getStatus(key) });
  }),
);

workspacesRouter.post(
  "/:owner/:repo/brand/image",
  // Logos up to 2 MB, and base64 adds a third.
  express.json({ limit: "3mb" }),
  handle(async (req, res) => res.status(201).json(await saveBrandImage(keyFor(req), req.body ?? {}))),
);

/*
 * A new site's setup (site-setup.js): the AI's analysis for a site opened without answers, and
 * saving the answers. `setup` is what the client's SetupFlow collected; `options` what the site
 * already has, for the build request it returns.
 */

workspacesRouter.post(
  "/:owner/:repo/setup/plan",
  handle(async (req, res) => {
    const siteId = await openSiteId(req);
    const { name, what, brief } = req.body ?? {};
    // The pages the site has, for the plan to update or keep rather than create again.
    const overview = await getOverview(keyFor(req));
    // By `address`: most pages have no `url` of their own and are built at their collection's pattern.
    const existing = overview.collections
      .flatMap((c) => c.pages)
      .filter((p) => typeof p.address === "string")
      .slice(0, 40)
      .map((p) => ({ url: p.address, title: p.title ?? p.address }));
    res.json(await planSetup({ userId: req.user.id, siteId, name, what, brief, existing: existing.length ? existing : undefined }));
  }),
);

workspacesRouter.post(
  "/:owner/:repo/setup",
  handle(async (req, res) => {
    const key = keyFor(req);
    const siteId = await openSiteId(req);
    const { setup, options } = req.body ?? {};
    const has = options && typeof options === "object" ? { hasHome: options.hasHome === true, chrome: options.chrome !== false, fresh: options.fresh === true } : {};
    const saved = await saveSetup({ key, siteId, userId: req.user.id, body: setup, options: has });
    res.json({ ...saved, status: await getStatus(key) });
  }),
);

/* Whether the site's build from its setup answers stopped before it finished (setup-build.js), so the editor can offer to carry on. */
workspacesRouter.get(
  "/:owner/:repo/setup/build",
  handle(async (req, res) => res.json({ pending: await pendingBuild(keyFor(req)) })),
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
    await logOwnerEdit(key, { command: "owner:menu", file: "content/data/navigation.json", instruction: "The owner changed the menu, header or footer" });
    res.json({ ...navigation, status: await getStatus(key) });
  }),
);

/* A page that adds itself to the header menu, the footer or both (its frontmatter `menu`). */

workspacesRouter.put(
  "/:owner/:repo/navigation/page-menu",
  handle(async (req, res) => {
    const key = keyFor(req);
    await setPageMenu(key, req.body?.file, req.body?.menu ?? null);
    await logOwnerEdit(key, {
      command: "owner:menu",
      file: req.body?.file,
      instruction: req.body?.menu ? `The owner put the page in the ${req.body.menu === "both" ? "header and footer" : req.body.menu} menu` : "The owner took the page out of the menus",
    });
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
      const content = await readTemplateFile(req.user, accessToken, file);
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
  handle(async (req, res) => {
    const key = keyFor(req);
    const info = await saveStaticInfo(key, req.params.section, req.body?.data);
    const section = staticInfoSection(req.params.section);
    await logOwnerEdit(key, { command: "owner:business-info", file: section.file, instruction: `The owner updated ${section.label}` });
    res.json(info);
  }),
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
    res.json({ job: publicJobView(serializeJob(job, Number.isFinite(since) && since > 0 ? since : 0), { admin: req.user.admin }) });
  }),
);

jobsRouter.post(
  "/:id/cancel",
  handle(async (req, res) => {
    const job = getJob(req.params.id, req.user.id);
    if (!job) throw new WorkspaceError("Job not found.", 404);
    cancelJob(job);
    res.json({ job: publicJobView(serializeJob(job, Number.MAX_SAFE_INTEGER), { admin: req.user.admin }) });
  }),
);
