"use client";

import { createContext, useContext } from "react";
import type { Job, Overview, WorkspaceStatus } from "@/lib/site-api";

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
  /** Opens the Claude edit tab with this file selected. */
  editFile: (file: string) => void;
};

export const SiteContext = createContext<SiteContextValue | null>(null);

export function useSite() {
  const value = useContext(SiteContext);
  if (!value) throw new Error("useSite must be used inside SiteManager");
  return value;
}
