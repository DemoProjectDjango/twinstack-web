"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  assistantApi,
  attachmentUrl,
  isOpenAction,
  type AssistantAction,
  type Attachment,
  type AssistantContext,
  type Conversation,
  type DisplayEntry,
  type Turn,
} from "@/lib/assistant-api";
import { confirmModal } from "@/lib/confirm";
import { api, workspacePath, type HtmlSource, type Overview, type Proposal, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "../site-context";

// "Ask Claude": the site's conversation, shared by the side panel and the boxes on each screen.
// A message starts a turn on the server; this polls it until Claude has answered. Claude's
// proposals then wait here for the owner: server-side ones are applied with one call, the others
// run the site's commands (as jobs, like the rest of the editor) and report back.

const POLL_MS = 600;
// How much of a failed command's output to show on its card.
const OUTPUT_TAIL_LINES = 8;

type AssistantValue = {
  /** Where the owner is in the editor; sent with each message. */
  context: AssistantContext;
  conversation: Conversation | null;
  turn: Turn | null;
  loading: boolean;
  error: unknown;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Sends the owner's message with any attached files (and opens the panel). Resolves to whether it was sent. */
  send: (text: string, attachments?: Attachment[]) => Promise<boolean>;
  stop: () => Promise<void>;
  startOver: () => Promise<void>;
  /** Every proposal by id: the conversation's, and the running turn's. */
  actions: Record<string, AssistantAction>;
  /** Proposals being worked on in this browser right now. */
  working: Set<string>;
  apply: (action: AssistantAction) => Promise<void>;
  skip: (action: AssistantAction) => Promise<void>;
  keep: (action: AssistantAction) => Promise<void>;
  throwAway: (action: AssistantAction) => Promise<void>;
  /** Applies a message's open proposals in order, pausing when a page waits to be kept. */
  applyAll: (entry: DisplayEntry) => void;
  applyingAll: boolean;
};

const AssistantCtx = createContext<AssistantValue | null>(null);

export function useAssistant() {
  const value = useContext(AssistantCtx);
  if (!value) throw new Error("useAssistant must be used inside AssistantProvider");
  return value;
}

/** The assistant, or null outside the site editor's provider (its loading and error screens). */
export function useOptionalAssistant() {
  return useContext(AssistantCtx);
}

const tail = (output: string) => output.trim().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AssistantProvider({ context, children }: { context: AssistantContext; children: ReactNode }) {
  const { owner, repo, runAndWait, setStatus, refresh, siteCheck } = useSite();
  // The latest check found problems that would keep the live site from updating.
  const problemsLeft = siteCheck.fresh && siteCheck.report?.ok === false;
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<string[]>([]);
  // The assistant messages whose proposals have already led to an automatic "carry on".
  const continued = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const { conversation: loaded } = await assistantApi.load(owner, repo);
      setConversation(loaded);
      setTurn(loaded?.runningTurn ?? null);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);

  useEffect(() => {
    let cancelled = false;
    assistantApi
      .load(owner, repo)
      .then(({ conversation: loaded }) => {
        if (cancelled) return;
        setConversation(loaded);
        setTurn(loaded?.runningTurn ?? null);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  // Poll the running turn until Claude has finished, then reload the conversation it was saved to.
  const runningId = turn?.status === "running" ? turn.id : null;
  useEffect(() => {
    if (!runningId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { turn: next } = await assistantApi.turn(owner, repo, runningId);
        if (cancelled) return;
        setTurn(next);
        if (next.status !== "running") await load();
      } catch (err) {
        if (cancelled) return;
        setError(err);
        await load();
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runningId, turn, owner, repo, load]);

  const sendBody = useCallback(
    async (body: { text?: string; continue?: boolean; attachments?: string[] }) => {
      setError(null);
      setOpen(true);
      try {
        const result = await assistantApi.send(owner, repo, { ...body, context });
        setConversation(result.conversation);
        setTurn(result.turn);
        return true;
      } catch (err) {
        setError(err);
        return false;
      }
    },
    [owner, repo, context],
  );

  const send = useCallback(
    (text: string, attachments: Attachment[] = []) => sendBody({ text, attachments: attachments.map((a) => a.id) }),
    [sendBody],
  );

  const stop = useCallback(async () => {
    if (!runningId) return;
    await assistantApi.stop(owner, repo, runningId).catch(() => {});
  }, [owner, repo, runningId]);

  const startOver = useCallback(async () => {
    if (conversation && !(await confirmModal("Start a new conversation? Claude won't remember this one, but your site keeps every change you applied.", { title: "New conversation", confirmLabel: "Start over" }))) return;
    try {
      await assistantApi.startOver(owner, repo);
      continued.current.clear();
      setQueued([]);
      setConversation(null);
      setTurn(null);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [conversation, owner, repo]);

  const actions = useMemo(() => {
    const all: Record<string, AssistantAction> = { ...(conversation?.actions ?? {}) };
    for (const a of turn?.actions ?? []) all[a.id] ??= a;
    return all;
  }, [conversation, turn]);

  /** Records a proposal's new state on the server and here. */
  const record = useCallback(
    async (action: AssistantAction, status: AssistantAction["status"], result?: string, file?: string) => {
      const { action: saved } = await assistantApi.setStatus(owner, repo, action.id, { status, result, file });
      setConversation((c) => (c ? { ...c, actions: { ...c.actions, [saved.id]: saved } } : c));
    },
    [owner, repo],
  );

  const setBusy = useCallback(
    (id: string, busy: boolean) =>
      setWorking((prev) => {
        const next = new Set(prev);
        if (busy) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );

  /**
   * The images a page edit was given, as the site's paths: an attached photo (att_…) is wherever
   * its "Add a file to the site" put it, so that has to be applied first.
   */
  const sitePaths = useCallback(
    (images: unknown) =>
      (Array.isArray(images) ? images : []).map((image: string) => {
        if (!image.startsWith("att_")) return image;
        const added = Object.values(actions).find((a) => a.tool === "add_file_to_site" && a.input.attachment === image && a.status === "applied");
        if (!added?.data?.path) throw new Error("Add the photo to the site first: apply its \"Add a file to the site\" card above.");
        return added.data.path;
      }),
    [actions],
  );

  /** Has Claude's writer produce a new version of the page, ready to keep: the same preview as the page editor's. */
  const writePage = useCallback(
    async (file: string, instruction: string, images: string[] = []) => {
      const job = await runAndWait("page-edit", { page: file, instruction, images, dryRun: true });
      if (job.status !== "succeeded") throw new Error(`Claude couldn't write the page.\n${tail(job.output)}`);
      const { proposal } = await api<{ proposal: Proposal | null }>(workspacePath(owner, repo, "/proposal"));
      if (!proposal || proposal.file !== file) throw new Error("Claude didn't come back with a new version of the page.");
    },
    [owner, repo, runAndWait],
  );

  /** Runs a proposal that's carried out from the browser. */
  const runClientAction = useCallback(
    async (action: AssistantAction) => {
      const input = action.input as Record<string, never>;
      // Only one page preview can wait at a time: it's the same slot the page editor uses.
      const writes = action.tool === "edit_page" || action.tool === "convert_page_from_html" || (action.tool === "create_page" && input.brief);
      if (writes && Object.values(actions).some((a) => a.status === "ready" && a.id !== action.id)) {
        throw new Error("Keep or throw away the page that's waiting first.");
      }
      // Before anything runs, so a missing photo stops it cleanly.
      const images = sitePaths(input.images);
      await record(action, "running");
      switch (action.tool) {
        case "edit_page":
          await writePage(input.file, input.instruction, images);
          await record(action, "ready", "The new version is ready to look at.");
          return;
        case "create_page": {
          let file: string | undefined;
          if (input.type === "homepage" || input.type === "listing") {
            // Their address isn't their name, so they're made the site plan's way, not with "new".
            const made = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, input.type === "homepage" ? "/pages/homepage" : "/pages/listing"), {
              method: "POST",
              body: { title: input.title, ...(input.type === "listing" && { collection: input.collection }) },
            });
            setStatus(made.status);
            file = made.file;
          } else {
            const before = await api<Overview>(workspacePath(owner, repo, "/overview"));
            const known = new Set(before.collections.flatMap((c) => c.pages.map((p) => p.file)));
            const job = await runAndWait("new", { type: input.type, title: input.title, slug: input.slug || undefined, draft: input.hidden === true });
            if (job.status !== "succeeded") throw new Error(`The page couldn't be created.\n${tail(job.output)}`);
            const after = await api<Overview>(workspacePath(owner, repo, "/overview"));
            file = after.collections.flatMap((c) => c.pages.map((p) => p.file)).find((f) => !known.has(f));
          }
          if (!file) throw new Error("The page was created, but it couldn't be found afterwards.");
          if (!input.brief) {
            await record(action, "applied", `Created ${file} (empty, ready to write).`, file);
            return;
          }
          await writePage(file, `This is a new, empty page. Write it from scratch.\n\n${input.brief}`, images);
          await record(action, "ready", `Created ${file}; its first version is ready to look at.`, file);
          return;
        }
        case "convert_page_from_html": {
          // The attached page (and its stylesheets and scripts) go where the page editor's upload puts them.
          const text = async (id: string) => {
            const res = await fetch(attachmentUrl(owner, repo, id));
            if (!res.ok) throw new Error("An attached file is gone. Attach it again.");
            return res.text();
          };
          const extraIds = (Array.isArray(input.extraFiles) ? input.extraFiles : []) as string[];
          const extras = await Promise.all(extraIds.map(async (id, i) => ({ name: (action.meta.extras as string[])[i], content: await text(id) })));
          const keepStyles = input.keepStyles === true;
          const saved = await api<HtmlSource>(workspacePath(owner, repo, "/html-source"), {
            method: "POST",
            body: {
              name: action.meta.source,
              content: await text(input.attachment),
              css: keepStyles ? extras.filter((f) => /\.css$/i.test(f.name)) : [],
              js: keepStyles && action.meta.scripts ? extras.filter((f) => /\.m?js$/i.test(f.name)) : [],
            },
          });
          const job = await runAndWait("page-convert", {
            page: input.file,
            source: saved.source,
            keepStyles,
            css: saved.css.map((c) => c.source),
            js: (saved.js ?? []).map((c) => c.source),
            instruction: input.direction || undefined,
            dryRun: true,
          });
          if (job.status !== "succeeded") throw new Error(`The page couldn't be brought in.\n${tail(job.output)}`);
          const { proposal } = await api<{ proposal: Proposal | null }>(workspacePath(owner, repo, "/proposal"));
          if (!proposal || proposal.file !== input.file) throw new Error("Claude didn't come back with the converted page.");
          await record(action, "ready", "The converted page is ready to look at.");
          return;
        }
        case "create_missing_pages": {
          const job = await runAndWait("scaffold", {});
          if (job.status !== "succeeded") throw new Error(`The pages couldn't be created.\n${tail(job.output)}`);
          // The scaffold script lists each file it creates as "  + <file>".
          const created = [...job.output.matchAll(/^\s*\+ (\S+\.md)\b/gm)].map((m) => m[1]);
          await record(
            action,
            "applied",
            created.length ? `Created ${created.length} new page${created.length === 1 ? "" : "s"}: ${created.join(", ")}.` : "Every page in the plan already exists.",
          );
          return;
        }
        case "update_page_search_settings": {
          const job = await runAndWait("seo-set", { page: input.file, fields: input.fields });
          if (job.status !== "succeeded") throw new Error(`The search settings couldn't be saved.\n${tail(job.output)}`);
          await record(action, "applied", "Saved the search settings.");
          return;
        }
        case "write_search_text_for_all_pages": {
          const job = await runAndWait("seo-claude", { all: true, force: input.force === true, instruction: input.direction || undefined });
          if (job.status !== "succeeded") throw new Error(`The search text couldn't be written.\n${tail(job.output)}`);
          await record(action, "applied", `Done. ${tail(job.output)}`);
          return;
        }
        default:
          throw new Error("This change can't be run from here.");
      }
    },
    [actions, owner, repo, record, runAndWait, writePage, sitePaths, setStatus],
  );

  const apply = useCallback(
    async (action: AssistantAction) => {
      if (action.tool === "delete_page" && !(await confirmModal(`Remove "${(action.meta.title as string) ?? action.input.file}" from your site? You can still undo it on the Publish screen until you publish.`, { title: "Remove page", confirmLabel: "Remove page", danger: true }))) return;
      if (
        action.tool === "publish_changes" &&
        !(await confirmModal(
          problemsLeft
            ? "Your site still has problems that stop it from updating (see the Publish screen). If you publish now, your changes are saved, but your live site stays as it is until they're fixed."
            : "Publish every unpublished change to your live site?",
          problemsLeft ? { title: "Publish with problems?", confirmLabel: "Publish anyway", danger: true } : { title: "Publish", confirmLabel: "Publish now" },
        ))
      ) {
        return;
      }
      setBusy(action.id, true);
      setError(null);
      try {
        if (action.runs === "server") {
          const { action: saved, status } = await assistantApi.apply(owner, repo, action.id);
          setConversation((c) => (c ? { ...c, actions: { ...c.actions, [saved.id]: saved } } : c));
          if (saved.status === "applied") {
            setStatus(status as WorkspaceStatus);
            await refresh();
          }
        } else {
          try {
            await runClientAction(action);
          } catch (err) {
            await record(action, "failed", message(err)).catch(() => {});
          }
          await refresh().catch(() => {});
        }
      } catch (err) {
        setError(err);
      } finally {
        setBusy(action.id, false);
      }
    },
    [owner, repo, record, refresh, runClientAction, setStatus, setBusy, problemsLeft],
  );

  const skip = useCallback(
    async (action: AssistantAction) => {
      setQueued((q) => q.filter((id) => id !== action.id));
      await record(action, "skipped").catch(setError);
    },
    [record],
  );

  /** Keeps the page Claude's writer produced for a proposal. */
  const keep = useCallback(
    async (action: AssistantAction) => {
      setBusy(action.id, true);
      try {
        const { proposal } = await api<{ proposal: Proposal | null }>(workspacePath(owner, repo, "/proposal"));
        if (!proposal) {
          await record(action, "failed", "The new version isn't there any more (it may have been kept or thrown away in the page editor).");
          return;
        }
        const result = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, "/proposal/apply"), {
          method: "POST",
          body: { content: proposal.content },
        });
        setStatus(result.status);
        await record(action, "applied", `Kept the new version of ${result.file}.`, result.file);
        await refresh();
      } catch (err) {
        setError(err);
      } finally {
        setBusy(action.id, false);
      }
    },
    [owner, repo, record, refresh, setStatus, setBusy],
  );

  const throwAway = useCallback(
    async (action: AssistantAction) => {
      setBusy(action.id, true);
      try {
        await api(workspacePath(owner, repo, "/proposal"), { method: "DELETE" });
        await record(action, "skipped", "Threw away the new version.");
      } catch (err) {
        setError(err);
      } finally {
        setBusy(action.id, false);
      }
    },
    [owner, repo, record, setBusy],
  );

  const applyAll = useCallback(
    (entry: DisplayEntry) => {
      if (entry.role !== "assistant") return;
      const ids = entry.parts.flatMap((p) => (p.type === "action" && actions[p.id]?.status === "proposed" ? [p.id] : []));
      setQueued(ids);
    },
    [actions],
  );

  // "Apply all" works through the queue one proposal at a time, skipping settled ones. A page
  // waiting to be kept pauses it (the owner decides); a failure stops it.
  const queueHead = useMemo(() => {
    for (const id of queued) {
      const a = actions[id];
      if (a && a.status !== "applied" && a.status !== "skipped") return a;
    }
    return null;
  }, [queued, actions]);
  const applyingAll = queueHead !== null && queueHead.status !== "failed";
  useEffect(() => {
    if (queueHead?.status !== "proposed" || working.size) return;
    const timer = setTimeout(() => void apply(queueHead), 0);
    return () => clearTimeout(timer);
  }, [queueHead, working, apply]);

  // When the newest message's proposals are all settled and one of them asked to continue (pages
  // to write once they exist, say), Claude carries on by itself.
  useEffect(() => {
    if (!conversation || turn?.status === "running" || applyingAll || working.size) return;
    const last = conversation.display.at(-1);
    if (!last || last.role !== "assistant" || continued.current.has(last.id)) return;
    const own = last.parts.flatMap((p) => (p.type === "action" && actions[p.id] ? [actions[p.id]] : []));
    if (!own.length || own.some(isOpenAction)) return;
    if (!own.some((a) => a.continueAfter && a.status === "applied")) return;
    // A moment's pause, so the owner sees the last card settle before Claude carries on.
    const timer = setTimeout(() => {
      continued.current.add(last.id);
      void sendBody({ continue: true });
    }, 600);
    return () => clearTimeout(timer);
  }, [conversation, turn, applyingAll, working, actions, sendBody]);

  const value: AssistantValue = {
    context,
    conversation,
    turn,
    loading,
    error,
    open,
    setOpen,
    send,
    stop,
    startOver,
    actions,
    working,
    apply,
    skip,
    keep,
    throwAway,
    applyAll,
    applyingAll,
  };

  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}
