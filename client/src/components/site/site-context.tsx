"use client";

import { createContext, useContext } from "react";
import type { EditMode, Job, Overview, WorkspaceStatus } from "@/lib/site-api";

export type SiteContextValue = {
  owner: string;
  repo: string;
  status: WorkspaceStatus;
  overview: Overview | null;
  hasKey: boolean;
  job: Job | null;
  /** True while any command or git operation holds the workspace. */
  busy: boolean;
  /** Bumps whenever files in the workspace may have changed; panels reload on it. */
  version: number;
  /** Starts a command; resolves to false (and shows the error) if it didn't start. */
  run: (command: string, input?: Record<string, unknown>) => Promise<boolean>;
  setStatus: (status: WorkspaceStatus) => void;
  /** Re-reads status and overview after a change made outside a command. */
  refresh: () => Promise<void>;
  /** Opens the Claude tab with this file selected: "generate" writes from its draft, "edit" (the default) takes an instruction. */
  editFile: (file: string, mode?: EditMode) => void;
  /** The Claude tab's hand-written draft reports whether it has unsaved edits. */
  setUnsavedDraft: (unsaved: boolean) => void;
  /** True if there are no unsaved draft edits, or the user agrees to lose them. */
  confirmDiscardDraft: () => boolean;
  /** Switches to another tab, e.g. from a hint that points there. */
  showTab: (tab: "build" | "pages" | "navigation" | "info" | "edit" | "tree" | "schedule" | "changes") => void;
};

export const SiteContext = createContext<SiteContextValue | null>(null);

export function useSite() {
  const value = useContext(SiteContext);
  if (!value) throw new Error("useSite must be used inside SiteManager");
  return value;
}
