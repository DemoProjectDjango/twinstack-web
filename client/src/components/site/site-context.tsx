"use client";

import { createContext, useContext } from "react";
import type { ClaudeAccess } from "@/lib/claude";
import type { EditMode, Job, Overview, Publishing, SiteCheckReport, SiteUpdateInfo, WorkspaceStatus } from "@/lib/site-api";

/**
 * The site editor's screens: the everyday ones in the menu ("home" is Edit site, "design" Look &
 * logo, "details" Business info, "analytics" Visitors), "publish" (What's changed, from the top
 * bar), then "more" (More tools) and the tools it opens.
 */
export type SiteSection =
  | "home"
  | "pages"
  | "design"
  | "details"
  | "publish"
  | "analytics"
  | "more"
  | "seo"
  | "redirects"
  | "sections"
  | "tree"
  | "schedule"
  | "memory"
  | "styles"
  | "models"
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

/**
 * The deploy's own check ("check" command), which the editor runs by itself while the Publish
 * screen is open and after each change (see SiteProblems).
 */
export type SiteCheckState = {
  report: SiteCheckReport | null;
  /** Nothing has changed since `report`. */
  fresh: boolean;
  /** A check is running or about to. */
  checking: boolean;
  /** Runs the check now. */
  checkNow: () => void;
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

/** One-click updates to the template's newest release (see useSiteUpdate). */
export type SiteUpdateState = {
  /** null until loaded, or when it couldn't be loaded. */
  info: SiteUpdateInfo | null;
  working: "update" | "undo" | null;
  error: unknown;
  /** What the last update or undo here did, in words, until the next one. */
  done: string | null;
  update: () => Promise<void>;
  undo: () => Promise<void>;
};

/**
 * The top bar's Publish button. One press checks the site (the deploy's own check, run first unless
 * a fresh report exists), asks before publishing with problems, then publishes straight to the live
 * branch. A first publish (site details not looked at yet) or a site on a review branch opens the
 * Publish screen instead, which has the details step and the review options.
 */
export type PublishNowState = {
  /** Something to publish: changes, an earlier push that didn't reach GitHub, or a review branch. */
  available: boolean;
  working: "checking" | "publishing" | null;
  publish: () => Promise<void>;
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
  /** Starts a command and resolves with the finished job (its whole output); throws if it couldn't start. */
  runAndWait: (command: string, input?: Record<string, unknown>) => Promise<Job>;
  /** Takes the status a change returned; the preview then rebuilds by itself. */
  setStatus: (status: WorkspaceStatus) => void;
  /** Re-reads status and overview after a change made outside a command; the preview then rebuilds by itself. */
  refresh: () => Promise<void>;
  /** Opens a page in the page editor: "generate" writes from its draft, "edit" (the default) takes an instruction. */
  editFile: (file: string, mode?: PageEditMode) => Promise<void>;
  /** The page editor's hand-written draft reports whether it has unsaved edits. */
  setUnsavedDraft: (unsaved: boolean) => void;
  /** True if there are no unsaved draft edits, or the user agrees to lose them. */
  confirmDiscardDraft: () => Promise<boolean>;
  /** Switches to another screen, e.g. from a hint that points there. */
  showSection: (section: SiteSection) => void;
  /** Opens Edit site on the page at this address (as the site builds it, e.g. "/about.html"). */
  showOnSite: (url: string) => void;
  /** The page Edit site was last asked to show (`n` tells two requests for one page apart). */
  previewTarget: { url: string; n: number } | null;
  /** Edit site reports the page its preview shows (its file, or null), which the AI gets as the open page. */
  setShownPage: (file: string | null) => void;
  /** Publishes every change straight to the live site, as the Publish button does (see usePublishNow). */
  publishNow: PublishNowState;
  publishing: PublishingState;
  tools: SiteTools;
  siteUpdate: SiteUpdateState;
  siteCheck: SiteCheckState;
};

export const SiteContext = createContext<SiteContextValue | null>(null);

export function useSite() {
  const value = useContext(SiteContext);
  if (!value) throw new Error("useSite must be used inside SiteManager");
  return value;
}
