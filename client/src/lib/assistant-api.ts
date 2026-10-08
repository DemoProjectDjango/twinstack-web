// The "Ask Claude" conversation, as the server's routes/assistant.js returns it.

import { api, workspacePath, type WorkspaceStatus } from "./site-api";

/**
 * A file attached to a message. Claude reads "image", "pdf", "text" and "document" (a Word file's
 * text); a "file" it can't read, but it can still be added to the site. `note` says why not.
 */
export type Attachment = {
  id: string;
  name: string;
  kind: "image" | "pdf" | "text" | "document" | "file";
  mime: string;
  size: number;
  note: string | null;
};

/** A proposal's tool, as the server names it (server/src/assistant/tools.js). */
export type ActionTool =
  | "edit_page"
  | "create_page"
  | "delete_page"
  | "add_file_to_site"
  | "convert_page_from_html"
  | "update_site_plan"
  | "create_missing_pages"
  | "update_page_search_settings"
  | "write_search_text_for_all_pages"
  | "update_menu_and_footer"
  | "design_header_and_footer"
  | "update_site_details"
  | "update_logo_settings"
  | "update_stylesheet"
  | "update_notes_for_claude"
  | "schedule_page"
  | "publish_changes";

/**
 * A change Claude proposed. "proposed" until the owner acts; "running" while its commands run;
 * "ready" when a page Claude wrote is waiting to be kept or thrown away; then "applied", "skipped"
 * or "failed" (with `result` saying what happened).
 */
export type AssistantAction = {
  id: string;
  tool: ActionTool;
  title: string;
  /** "server": applied by the server. "client": runs the site's commands from the editor. */
  runs: "server" | "client";
  summary: string;
  continueAfter: boolean;
  // Each tool's own input and captured state; see tools.js prepareChange.
  input: Record<string, unknown>;
  meta: Record<string, unknown>;
  status: "proposed" | "running" | "ready" | "applied" | "skipped" | "failed";
  result: string | null;
  /** What a server-side change hands back: where add_file_to_site put the file. */
  data?: { path?: string } | null;
  createdAt: string;
};

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "activity"; label: string }
  | { type: "action"; id: string };

export type DisplayEntry =
  | { id: string; role: "user"; text: string; attachments?: Attachment[]; at: string }
  | { id: string; role: "notice"; text: string; at: string }
  | { id: string; role: "assistant"; parts: AssistantPart[]; error: string | null; at: string };

export type Turn = {
  id: string;
  status: "running" | "done" | "failed" | "stopped";
  parts: AssistantPart[];
  actions: AssistantAction[];
  error: string | null;
};

export type Conversation = {
  id: string;
  display: DisplayEntry[];
  actions: Record<string, AssistantAction>;
  usage: { input_tokens: number; output_tokens: number };
  runningTurn: Turn | null;
};

/** Where the owner is in the editor, so Claude knows what "this page" means. */
export type AssistantContext = { screen: string; page?: string | null };

const base = (owner: string, repo: string, rest = "") => workspacePath(owner, repo, `/assistant${rest}`);

export const assistantApi = {
  load: (owner: string, repo: string) => api<{ conversation: Conversation | null }>(base(owner, repo)),
  send: (owner: string, repo: string, body: { text?: string; continue?: boolean; attachments?: string[]; context: AssistantContext }) =>
    api<{ turn: Turn; conversation: Conversation }>(base(owner, repo, "/messages"), { method: "POST", body }),
  turn: (owner: string, repo: string, id: string) => api<{ turn: Turn }>(base(owner, repo, `/turns/${id}`)),
  stop: (owner: string, repo: string, id: string) => api<{ turn: Turn }>(base(owner, repo, `/turns/${id}/stop`), { method: "POST", body: {} }),
  startOver: (owner: string, repo: string) => api<{ conversation: null }>(base(owner, repo, "/new"), { method: "POST", body: {} }),
  apply: (owner: string, repo: string, id: string) =>
    api<{ action: AssistantAction; status: WorkspaceStatus }>(base(owner, repo, `/actions/${id}/apply`), { method: "POST", body: {} }),
  setStatus: (owner: string, repo: string, id: string, body: { status: AssistantAction["status"]; result?: string; file?: string }) =>
    api<{ action: AssistantAction }>(base(owner, repo, `/actions/${id}/status`), { method: "POST", body }),
  attach: (owner: string, repo: string, body: { name: string; data: string }) =>
    api<{ attachment: Attachment }>(base(owner, repo, "/attachments"), { method: "POST", body }),
};

/** Where the browser loads an attachment: shown for an image, downloaded for anything else. */
export const attachmentUrl = (owner: string, repo: string, id: string) => base(owner, repo, `/attachments/${encodeURIComponent(id)}`);

/** The same limits as the server's (assistant/attachments.js, routes/assistant.js). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;

/** Proposals still waiting on the owner or running. */
export const isOpenAction = (a: AssistantAction) => a.status === "proposed" || a.status === "running" || a.status === "ready";
