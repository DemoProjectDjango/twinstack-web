"use client";

import { createContext, useContext } from "react";
import type { ClaudeAccess } from "@/lib/claude";
import type { EditMode, Job, Overview, Publishing, WorkspaceStatus } from "@/lib/site-api";

/** The site editor's screens: the everyday ones first, then the ones under Advanced. */
export type SiteSection =
  | "home"
  | "pages"
  | "design"
  | "details"
  | "publish"
  | "seo"
  | "tree"
  | "schedule"
  | "memory"
  | "styles"
  | "tools";

/** How a page editor opens: "convert" replaces the page with an uploaded web page. */
export type PageEditMode = EditMode | "convert";

/** GitHub Pages for the copy, polled while the editor is open (see usePublishing). */
export type PublishingState = {
  publishing: Publishing | null;
  error: unknown;
  working: "enable" | "deploy" | null;
  act: (kind: "enable" | "deploy") => Promise<void>;
  setPublishing: (next: Publishing) => void;
  /** Watch closely for a while: something was just pushed. */
  watch: () => void;
};

/** Template files an older copy lacks, which "Update site tools" copies in (see useSiteTools). */
export type SiteTools = {
  /** What's out of date, in words ("search settings"). Empty when everything is current or not yet known. */
  outdated: string[];
  updating: boolean;
  error: unknown;
  /** Files the last update wrote, null before one. */
  written: string[] | null;
  update: () => Promise<void>;
};

export type SiteContextValue = {
  owner: string;
  repo: string;
  status: WorkspaceStatus;
  overview: Overview | null;
  /** Whether Claude commands can run, and where to set Claude up when they can't. */
  claude: ClaudeAccess;
  job: Job | null;
  /** True while any command or git operation holds the workspace. */
  busy: boolean;
  /** Bumps whenever files in the workspace may have changed; panels reload on it. */
  version: number;
  /** Starts a command; resolves to false (and shows the error) if it didn't start. */
  run: (command: string, input?: Record<string, unknown>) => Promise<boolean>;
  /** Takes the status a change returned; the preview then rebuilds by itself. */
  setStatus: (status: WorkspaceStatus) => void;
  /** Re-reads status and overview after a change made outside a command; the preview then rebuilds by itself. */
  refresh: () => Promise<void>;
  /** Opens a page in the page editor: "generate" writes from its draft, "edit" (the default) takes an instruction. */
  editFile: (file: string, mode?: PageEditMode) => void;
  /** The page editor's hand-written draft reports whether it has unsaved edits. */
  setUnsavedDraft: (unsaved: boolean) => void;
  /** True if there are no unsaved draft edits, or the user agrees to lose them. */
  confirmDiscardDraft: () => boolean;
  /** Switches to another screen, e.g. from a hint that points there. */
  showSection: (section: SiteSection) => void;
  publishing: PublishingState;
  tools: SiteTools;
};

export const SiteContext = createContext<SiteContextValue | null>(null);

export function useSite() {
  const value = useContext(SiteContext);
  if (!value) throw new Error("useSite must be used inside SiteManager");
  return value;
}
