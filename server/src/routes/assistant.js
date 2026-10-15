import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import express, { Router } from "express";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentBlock,
  attachmentView,
  deleteAttachments,
  describeAttachment,
  ensureUploaded,
  readAttachment,
  readAttachmentMeta,
  saveAttachment,
} from "../assistant/attachments.js";
import { composeUserMessage, knowledgeSection } from "../assistant/prompt.js";
import { TOOLSET_VERSION, applyServerAction } from "../assistant/tools.js";
import { anthropicClient, runTurn } from "../assistant/turn.js";
import { DETAILS_FAILED, runDetailsTurn } from "../assistant/details-turn.js";
import { runQuickTurn } from "../assistant/quick-turn.js";
import { archiveConversations, createConversation, findConversation, getAssistantModel, updateConversation } from "../db.js";
import { ClaudeAccessError, beginClaudeActivity, beginSpend, claudeFilesKeyFor, claudeKeyFor } from "../credits.js";
import { fastModelForSite, fastModelKey } from "../fast-model.js";
import { imageModelForSite } from "../image-model.js";
import { getAccessToken } from "../github.js";
import { logWork, readDataFile, recentWorkLog } from "../site-files.js";
import { WorkspaceError, getStatus, siteIdFor } from "../workspace.js";
import { handle, keyFor } from "./helpers.js";

// "Ask Claude": one continuing conversation per user and site. A message starts a turn that runs
// in the background (Claude may read several things and propose several changes); the browser
// polls the turn for progress, the way it polls jobs, because streaming responses don't survive
// the Next.js rewrite proxy. Proposed changes ("actions") wait for the owner: server-side ones are
// applied here, the others run the site's commands from the browser and report back.

// Messages about the site details (contact, social links, taglines, reviews, FAQ…) go to the cheaper
// model first wherever they're sent from (assistant/details-turn.js); it hands anything else to Claude.
const SITE_DETAILS_WORDS =
  /\b(e-?mail|phone|telephone|mobile|whats ?app|instagram|facebook|linkedin|youtube|tiktok|twitter|social (media|links?|pages?)|tagline|slogan|testimonials?|reviews?|faq|frequently asked|opening hours|business hours|address|booking link)\b/i;
// The Claude model for a site-details request the fast model couldn't do (DETAILS_FAILED), whatever
// the account's assistant model: filling in data doesn't need Opus or Fable.
const DETAILS_FALLBACK_MODEL = "claude-sonnet-5-5";
// How long Claude's 1-hour cache of a conversation counts as still there (a little under the hour).
const CACHE_FRESH_MS = 55 * 60 * 1000;

export const assistantRouter = Router({ mergeParams: true });

const MAX_MESSAGE_CHARS = 8000;
// The conversation document must stay well under MongoDB's 16 MB limit.
const MAX_HISTORY_CHARS = 6_000_000;
const MAX_SENT_ENTRIES = 300;
// The work log a conversation starts with (freshKnowledge): the newest entries, and the summary
// points of the newest of those.
const FIRST_LOG_ENTRIES = 20;
const DETAILED_LOG_ENTRIES = 8;
const MAX_NOTES_CHARS = 20_000;
const TURN_KEEP_MS = 30 * 60 * 1000;
const STATUSES = ["running", "ready", "applied", "skipped", "failed"];
const MAX_ATTACHMENTS = 5;

// Turns in progress (and finished ones, briefly), by id. Lost on restart, like jobs.
const turns = new Map();
setInterval(() => {
  const cutoff = Date.now() - TURN_KEEP_MS;
  for (const [id, turn] of turns) if (turn.finishedAt && turn.finishedAt < cutoff) turns.delete(id);
}, 5 * 60 * 1000).unref();

const runningTurnFor = (conversationId) =>
  [...turns.values()].find((t) => t.conversationId === conversationId && t.status === "running") ?? null;

function turnView(turn) {
  return {
    id: turn.id,
    status: turn.status,
    parts: turn.live.parts,
    actions: turn.live.actions,
    error: turn.error,
  };
}

/** What the browser shows: the chat, the proposals and the running turn, never the raw history. */
function conversationView(conversation) {
  if (!conversation) return null;
  const running = runningTurnFor(conversation.id);
  return {
    id: conversation.id,
    display: conversation.display,
    actions: conversation.actions,
    usage: conversation.usage,
    runningTurn: running ? turnView(running) : null,
  };
}

async function siteOf(req) {
  const key = keyFor(req);
  let siteId;
  try {
    siteId = await siteIdFor(key);
  } catch {
    throw new WorkspaceError("Open the site first.", 409);
  }
  return { key, siteId };
}

async function ownConversation(req, siteId) {
  const conversation = await findConversation(req.user.id, siteId);
  if (!conversation) throw new WorkspaceError("There's no conversation yet.", 404);
  return conversation;
}

/** The notes and work-log entries Claude hasn't been given yet in this conversation. */
async function freshKnowledge(key, conversation) {
  const first = conversation.messages.length === 0;
  const [notesFile, entries] = await Promise.all([
    readDataFile(key, "knowledge-notes").catch(() => ({ content: "" })),
    recentWorkLog(key).catch(() => []),
  ]);
  const notes = notesFile.content.replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, MAX_NOTES_CHARS);
  const sent = new Set(conversation.knowledge?.sent ?? []);
  const newEntries = first ? entries : entries.filter((e) => !sent.has(e));
  const notesChanged = first || notes !== (conversation.knowledge?.notes ?? "");
  // The assistant plans; the page writer reads the whole log itself (the site's knowledge.js). So a
  // conversation starts with the newest entries only, the older of them without their summary
  // points: the full log can be 60 entries of up to six lines, all of it sent on every request.
  const shown = first ? newEntries.slice(-FIRST_LOG_ENTRIES).map((entry, i, all) => (i < all.length - DETAILED_LOG_ENTRIES ? entry.split("\n")[0] : entry)) : newEntries;
  return {
    section: knowledgeSection({ notes: notesChanged ? notes : "", entries: shown, first }),
    state: { notes, sent: [...sent, ...newEntries].slice(-MAX_SENT_ENTRIES) },
  };
}

/** What happened to earlier proposals since Claude last heard, oldest first. Marks them as told. */
function pendingOutcomes(conversation) {
  const lines = [];
  const reported = {};
  for (const action of Object.values(conversation.actions ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (action.reported) continue;
    const what = `${action.title} (${action.summary})`;
    if (["applied", "skipped", "failed"].includes(action.status)) {
      lines.push(`${what}: ${action.status}${action.result ? `. ${action.result}` : ""}`);
      reported[`actions.${action.id}.reported`] = true;
    } else {
      lines.push(`${what}: not applied yet (still waiting for the owner)`);
    }
  }
  return { lines, reported };
}

function friendlyError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return "Stopped.";
  if (err instanceof Anthropic.AuthenticationError) return "Claude didn't accept the API key. If you added your own Anthropic key, check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Your Anthropic account can't use this Claude model.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is getting too many requests right now. Try again in a minute.";
  if (err instanceof Anthropic.InternalServerError) return "Claude is overloaded right now. Try again shortly.";
  if (err instanceof Anthropic.BadRequestError) return `Claude couldn't process this conversation (${err.message}). If it keeps happening, start a new conversation.`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Check the server's internet connection.";
  if (err instanceof WorkspaceError) return err.message;
  return "Something went wrong talking to Claude.";
}

assistantRouter.get(
  "/",
  handle(async (req, res) => {
    const { siteId } = await siteOf(req);
    res.json({ conversation: conversationView(await findConversation(req.user.id, siteId)) });
  }),
);

/** Starts a new conversation: the current one is archived. */
assistantRouter.post(
  "/new",
  handle(async (req, res) => {
    const { siteId } = await siteOf(req);
    const current = await findConversation(req.user.id, siteId);
    if (current && runningTurnFor(current.id)) throw new WorkspaceError("Wait for Claude to finish, or stop it first.", 409);
    await archiveConversations(req.user.id, siteId);
    if (current?.attachments?.length) {
      const apiKey = await claudeFilesKeyFor(req.user.id);
      await deleteAttachments(apiKey ? anthropicClient(apiKey) : null, keyFor(req), current.attachments);
    }
    res.json({ conversation: null });
  }),
);

/**
 * The owner's message (or `continue: true`, the automatic follow-up once proposals marked
 * continue_after were applied). Starts a turn and returns at once; poll /turns/:id.
 */
assistantRouter.post(
  "/messages",
  handle(async (req, res) => {
    const { key, siteId } = await siteOf(req);
    const userId = req.user.id;
    const continuing = req.body?.continue === true;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const attachmentIds = Array.isArray(req.body?.attachments) ? [...new Set(req.body.attachments)] : [];
    if (!continuing && !text && !attachmentIds.length) throw new WorkspaceError("Write a message first.", 400);
    if (text.length > MAX_MESSAGE_CHARS) throw new WorkspaceError(`Keep messages under ${MAX_MESSAGE_CHARS} characters.`, 400);
    const context = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const screen = typeof context.screen === "string" ? context.screen.slice(0, 40) : "";
    const page = typeof context.page === "string" && /^content\/[\w./-]+\.md$/.test(context.page) ? context.page : null;
    // The panel's "Make changes automatically" switch (on unless the browser says otherwise).
    const autoApply = context.autoApply !== false;
    if (attachmentIds.length > MAX_ATTACHMENTS) throw new WorkspaceError(`Attach at most ${MAX_ATTACHMENTS} files to a message.`, 400);
    if (continuing && attachmentIds.length) throw new WorkspaceError("Attach files to your own messages.", 400);

    let claude;
    try {
      claude = await claudeKeyFor(userId);
    } catch (err) {
      if (!(err instanceof ClaudeAccessError)) throw err;
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    const model = await getAssistantModel(userId);

    let conversation = await findConversation(userId, siteId);
    if (conversation && runningTurnFor(conversation.id)) throw new WorkspaceError("Claude is still answering. Wait for it, or stop it.", 409);
    // A conversation is bound to the tools it started with: when they've changed (Claude learnt
    // something new), it carries on as a fresh one.
    let notice = null;
    if (conversation && conversation.toolset !== TOOLSET_VERSION) {
      await archiveConversations(userId, siteId);
      conversation = null;
      notice = "Claude has been updated, so this is a fresh conversation. Your site keeps every change you applied.";
    }
    conversation ??= await createConversation({ userId, siteId, toolset: TOOLSET_VERSION });
    if (JSON.stringify(conversation.messages).length > MAX_HISTORY_CHARS) {
      throw new WorkspaceError("This conversation has got very long. Start a new conversation to carry on.", 409);
    }

    // Attached files go to Claude by reference (Files API): read once, never re-sent.
    const client = anthropicClient(claude.apiKey);
    const attachments = [];
    for (const id of attachmentIds) {
      const meta = await readAttachmentMeta(key, id);
      try {
        attachments.push(await ensureUploaded(client, key, meta));
      } catch (err) {
        if (!(err instanceof Anthropic.APIError)) throw err;
        throw new WorkspaceError(`${meta.name} couldn't be sent to Claude: ${friendlyError(err)}`, 502);
      }
    }

    const knowledge = await freshKnowledge(key, conversation);
    const outcomes = pendingOutcomes(conversation);
    const composed = composeUserMessage({
      text,
      context: { screen, page, autoApply },
      knowledge: knowledge.section,
      outcomes: outcomes.lines,
      continuing,
      attachments: attachments.map(describeAttachment),
    });
    const blocks = attachments.map(attachmentBlock).filter(Boolean);
    const userMessage = { role: "user", content: blocks.length ? [{ type: "text", text: composed }, ...blocks] : composed };
    const at = new Date().toISOString();
    const shown = continuing
      ? { id: randomUUID(), role: "notice", text: "Carrying on with the next step…", at }
      : { id: randomUUID(), role: "user", text, attachments: attachments.map(attachmentView), at };
    conversation = await updateConversation(conversation.id, userId, {
      $push: {
        messages: userMessage,
        display: { $each: [...(notice ? [{ id: randomUUID(), role: "notice", text: notice, at }] : []), shown] },
        ...(attachments.length && { attachments: { $each: attachments.map((a) => a.id) } }),
      },
      $set: { knowledge: knowledge.state, ...outcomes.reported },
    });

    const turn = {
      id: randomUUID(),
      conversationId: conversation.id,
      userId,
      status: "running",
      live: { parts: [], actions: [] },
      error: null,
      controller: new AbortController(),
      finishedAt: null,
    };
    turns.set(turn.id, turn);
    const endActivity = beginClaudeActivity(userId);

    (async () => {
      let result = null;
      // The Claude model this turn runs on, if Claude takes it: the account's, or Sonnet (below).
      let turnModel = model;
      const spending = () => beginSpend({ userId, siteId, runId: turn.id, kind: "assistant", charged: claude.charged });
      try {
        // A small change to one page needs no planning: it becomes the page edit straight away, with
        // no model request (assistant/quick-turn.js); null hands the turn on.
        if (!continuing && text && !attachments.length) {
          result = await runQuickTurn({ key, text, openPage: page, autoApply, live: turn.live }).catch((err) => {
            console.error("The quick page edit failed, so Claude takes the turn:", err.message);
            return null;
          });
          if (!result) turn.live = { parts: [], actions: [] };
        }
        // Site details asked for on their own screen are data to fill in: the app's cheaper model
        // (fast-model.js) does them (assistant/details-turn.js) when Claude runs on credits. null
        // hands the turn to Claude (not site details); DETAILS_FAILED hands it to Sonnet. The site may
        // choose its own fast model (fast-model.js).
        const fastModel = await fastModelForSite(siteId);
        if (!result && (screen === "details" || SITE_DETAILS_WORDS.test(text)) && !continuing && text && !attachments.length && claude.charged && fastModel) {
          result = await runDetailsTurn({
            key,
            text,
            model: fastModel,
            apiKey: fastModelKey(fastModel),
            live: turn.live,
            beginSpend: spending,
            signal: turn.controller.signal,
          }).catch((err) => {
            if (err instanceof Anthropic.APIUserAbortError) throw err;
            console.error("The site details model failed, so Claude takes the turn:", err.message);
            return DETAILS_FAILED;
          });
          if (result === DETAILS_FAILED) {
            result = null;
            turnModel = DETAILS_FALLBACK_MODEL;
          }
          if (!result) turn.live = { parts: [], actions: [] };
        }
        // Claude's cache lasts an hour and belongs to one model: past the hour, or on another model
        // than the last request's, the whole history is written to it again.
        const last = conversation.lastPrompt;
        const cacheWarm = Date.now() - Date.parse(last?.at ?? 0) < CACHE_FRESH_MS && (!last?.model || last.model === turnModel);
        result ??= await runTurn({
          client,
          key,
          model: turnModel,
          history: conversation.messages,
          live: turn.live,
          signal: turn.controller.signal,
          // Each request is capped to the balance, watched as it streams and charged as soon as it's
          // done, so the balance moves while Claude works and stops at the overdraft limit.
          beginSpend: spending,
          cachedTokens: cacheWarm ? (last?.tokens ?? 0) : 0,
          // Pictures are made with the site's image model, else the admin's.
          imageModel: await imageModelForSite(siteId),
          // read_analytics answers only the site's creator.
          userId,
        });
        turn.status = "done";
      } catch (err) {
        const stopped = turn.controller.signal.aborted;
        if (!stopped && !(err instanceof Anthropic.APIError) && !(err instanceof Anthropic.APIUserAbortError)) {
          console.error("Assistant turn failed:", err);
        }
        turn.status = stopped ? "stopped" : "failed";
        // Stopping while a picture is being made aborts a plain fetch, not a Claude request.
        turn.error = stopped ? "Stopped." : friendlyError(err);
        result = err.partial ?? null;
      }
      try {
        // What was said and proposed is kept even when the turn ended early.
        const entry = {
          id: turn.id,
          role: "assistant",
          parts: turn.live.parts,
          error: turn.error,
          at: new Date().toISOString(),
        };
        const actions = Object.fromEntries((result?.actions ?? []).map((a) => [`actions.${a.id}`, a]));
        const usage = result?.usage;
        await updateConversation(conversation.id, userId, {
          $push: { display: entry, ...(result?.appended.length && { messages: { $each: result.appended } }) },
          $set: { ...actions, ...(result?.lastPrompt && { lastPrompt: { tokens: result.lastPrompt, model: turnModel, at: new Date().toISOString() } }) },
          ...(usage && { $inc: Object.fromEntries(Object.entries(usage).map(([k, v]) => [`usage.${k}`, v])) }),
        });
      } catch (err) {
        console.error("Couldn't save the assistant turn:", err);
        turn.status = "failed";
        turn.error = "Claude's answer couldn't be saved.";
      } finally {
        turn.finishedAt = Date.now();
        endActivity();
      }
    })();

    res.status(202).json({ turn: turnView(turn), conversation: conversationView(conversation) });
  }),
);

assistantRouter.get(
  "/turns/:id",
  handle(async (req, res) => {
    const turn = turns.get(req.params.id);
    if (!turn || turn.userId !== req.user.id) throw new WorkspaceError("This answer has expired. Reload the conversation.", 404);
    res.json({ turn: turnView(turn) });
  }),
);

assistantRouter.post(
  "/turns/:id/stop",
  handle(async (req, res) => {
    const turn = turns.get(req.params.id);
    if (!turn || turn.userId !== req.user.id) throw new WorkspaceError("This answer has expired.", 404);
    turn.controller.abort();
    res.json({ turn: turnView(turn) });
  }),
);

// The work log gets an entry for each change the owner keeps, so later Claude requests know about
// it. Page edits are logged when their preview is kept (applyProposal) and the search writer logs
// its own; publishing isn't a change to the site.
const LOGGED_FILE = {
  delete_page: (a) => a.input.file,
  update_site_plan: () => "scripts/site-tree.md",
  update_menu_and_footer: () => "content/data/navigation.json",
  update_site_details: (a) => a.meta.file ?? "content/data",
  update_logo_settings: () => "site.config.json",
  update_stylesheet: (a) => a.input.file,
  schedule_page: () => "scripts/scaffold-schedule.md",
  create_page: (a, file) => (a.input.brief ? null : file),
  create_missing_pages: () => "scripts/site-tree.md",
  update_page_search_settings: (a) => a.input.file,
  add_file_to_site: (a, file) => file,
  create_image: (a, file) => file,
};

async function logApplied(key, action, file) {
  const target = LOGGED_FILE[action.tool]?.(action, file);
  if (!target) return;
  await logWork(key, { command: `assistant:${action.tool.replace(/_/g, "-")}`, file: target, instruction: action.summary, summary: [] });
}

/** Applies a server-side proposal. */
assistantRouter.post(
  "/actions/:id/apply",
  handle(async (req, res) => {
    const { key, siteId } = await siteOf(req);
    const conversation = await ownConversation(req, siteId);
    const action = conversation.actions?.[req.params.id];
    if (!action) throw new WorkspaceError("That change isn't in this conversation.", 404);
    if (action.runs !== "server") throw new WorkspaceError("This change runs from the editor.", 400);
    if (action.status === "applied") throw new WorkspaceError("That change was already applied.", 409);

    let result;
    let data = null;
    let status = "applied";
    try {
      const accessToken = action.tool === "publish_changes" ? await getAccessToken(req, res) : null;
      const applied = await applyServerAction(key, action, { accessToken, user: req.user.github });
      ({ result, data = null } = typeof applied === "string" ? { result: applied } : applied);
      await logApplied(key, action, data?.path);
    } catch (err) {
      if (!(err instanceof WorkspaceError)) throw err;
      status = "failed";
      result = err.message;
    }
    const updated = await updateConversation(conversation.id, req.user.id, {
      $set: {
        [`actions.${action.id}.status`]: status,
        [`actions.${action.id}.result`]: result,
        [`actions.${action.id}.data`]: data,
        [`actions.${action.id}.reported`]: false,
      },
    });
    res.json({ action: updated.actions[action.id], status: await getStatus(key) });
  }),
);

/**
 * A proposal's progress from the browser: "running" while its commands run, "ready" when a page
 * preview is waiting to be kept, then "applied", "skipped" or "failed" with a short result.
 * Skipping works for every proposal.
 */
assistantRouter.post(
  "/actions/:id/status",
  handle(async (req, res) => {
    const { key, siteId } = await siteOf(req);
    const conversation = await ownConversation(req, siteId);
    const action = conversation.actions?.[req.params.id];
    if (!action) throw new WorkspaceError("That change isn't in this conversation.", 404);
    const { status, result, file } = req.body ?? {};
    if (!STATUSES.includes(status)) throw new WorkspaceError("Unknown status.", 400);
    if (status !== "skipped" && action.runs !== "client") throw new WorkspaceError("This change is applied on the server.", 400);
    if (["applied", "skipped"].includes(action.status)) throw new WorkspaceError("That change is already finished.", 409);
    const note = typeof result === "string" ? result.slice(0, 1000) : null;
    if (status === "applied") await logApplied(key, action, typeof file === "string" ? file : null);
    const updated = await updateConversation(conversation.id, req.user.id, {
      $set: { [`actions.${action.id}.status`]: status, [`actions.${action.id}.result`]: note, [`actions.${action.id}.reported`]: false },
    });
    res.json({ action: updated.actions[action.id] });
  }),
);

/* ------------------------------------------------------------ attachments */

// A file attached to the next message: { name, data } with the bytes in base64. This route parses
// its own JSON body (index.js skips the global 100 KB parser for it). Uploaded to Claude straight
// away, so sending is quick.
assistantRouter.post(
  "/attachments",
  express.json({ limit: `${Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3 / 1024 / 1024) + 2}mb` }),
  handle(async (req, res) => {
    const { key } = await siteOf(req);
    let claude;
    try {
      claude = await claudeKeyFor(req.user.id);
    } catch (err) {
      if (!(err instanceof ClaudeAccessError)) throw err;
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    const { meta, publicMeta } = await saveAttachment(key, req.body ?? {});
    // If this fails it's tried again when the message is sent.
    await ensureUploaded(anthropicClient(claude.apiKey), key, meta).catch((err) => console.error(`Couldn't upload ${meta.id} to Claude:`, err.message));
    res.status(201).json({ attachment: publicMeta });
  }),
);

/** An attachment's bytes: images to show in the chat, anything else as a download. */
assistantRouter.get(
  "/attachments/:id",
  handle(async (req, res) => {
    const { key } = await siteOf(req);
    const { meta, file } = await readAttachment(key, req.params.id);
    const inline = meta.kind === "image";
    res.set({
      // Never run or render anything from an attachment as part of this app.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    });
    // The file is kept inside .git, which sendFile refuses unless told.
    res.type(inline ? meta.mime : "application/octet-stream").sendFile(file, { dotfiles: "allow" });
  }),
);
