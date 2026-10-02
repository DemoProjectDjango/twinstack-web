// Browser-side client for the site workspace API (proxied to Express by the
// /api rewrite in next.config.ts).

export type Change = { path: string; status: "added" | "modified" | "deleted" | "renamed"; untracked: boolean };

export type WorkspaceStatus = {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  branch: string;
  onDefaultBranch: boolean;
  ahead: number | null;
  behind: number | null;
  changes: Change[];
  needsInstall: boolean;
  busy: string | null;
  activeJob: { id: string; command: string; label: string } | null;
  /** "empty" means the site built but has no homepage yet (no pages). */
  build: "none" | "empty" | "ready";
  previewUrl: string | null;
};

export type Job = {
  id: string;
  command: string;
  label: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  output: string;
  truncated: boolean;
  next: number;
};

export type SitePage = { file: string; slug: string; title: string; draft: boolean; date: string | null };

/** A stylesheet the Styles tab can edit. A declared global stylesheet may not exist yet. */
export type CssFile = { file: string; kind: "site" | "global" | "imported"; declared: boolean; exists: boolean };
export type CssSource = { file: string; exists: boolean; content: string; version: string };

export type Overview = {
  site: { name: string; url: string; model: string | null };
  /**
   * pageEditImages: the copy's edit-page.js supports --image and --proposal-out.
   * pageGenerate: it supports --generate (turn a hand-written draft into the finished page).
   * pageConvert: it supports --from-html (convert an existing HTML page into a page).
   * pageConvertStyles: it supports --keep-styles (copy that page as-is with its own CSS).
   * pageConvertScripts: such a copy keeps the page's scripts too, and takes --js uploads.
   * globalCss: --keep-styles applies the site tree's global stylesheets (listed in globalStylesheets).
   * mdEdit: it has scripts/edit-md.js (edit markdown outside content/, listed in markdownFiles).
   * memory: it has scripts/lib/knowledge.js (Claude reads knowledge/notes.md and the work log first).
   */
  features: {
    pageEditImages: boolean;
    pageGenerate: boolean;
    pageConvert: boolean;
    pageConvertStyles: boolean;
    pageConvertScripts: boolean;
    globalCss: boolean;
    mdEdit: boolean;
    memory: boolean;
  };
  /** Markdown files outside content/ that the "md-edit" command may change. Empty without mdEdit. */
  markdownFiles: string[];
  /** Global stylesheets declared in scripts/site-tree.md ("- css/style.css"), kept as styles/global/<path>. Empty without globalCss. */
  globalStylesheets: { path: string; file: string; exists: boolean }[];
  collections: { name: string; dir: string; label: string; pages: SitePage[] }[];
  navigation: {
    items: { label: string; url: string; collection: string | null; limit: number | null }[];
    cta: { label: string; url: string } | null;
  };
  otherEditable: string[];
};

export type ScheduleJob = {
  location: string;
  title: string;
  date: string;
  description?: string;
  content?: string;
  images?: string[];
  research?: boolean;
  source?: string;
  done?: boolean;
  completedDate?: string;
  [field: string]: unknown;
};

export type FileDiff = Change & { diff: string };

/** One host in GitHub's DNS check for a custom domain. */
export type DomainHealth = {
  host: string;
  isApex: boolean;
  resolves: boolean;
  pointsToGithub: boolean;
  httpsEligible: boolean;
  proxied: boolean;
  caaError: string | null;
};

/** GitHub's DNS check. `pending` while GitHub is still working it out. */
export type DomainCheck = { pending: boolean; domain?: DomainHealth | null; altDomain?: DomainHealth | null };

/** GitHub Pages for a site copy, and its latest deploy on the default branch. */
export type Publishing = {
  defaultBranch: string;
  /** "<owner>.github.io": where a custom domain's CNAME record points. */
  pagesHost: string;
  /** The custom domain set in Pages, or null for the github.io address. */
  domain: string | null;
  httpsEnforced: boolean;
  /** GitHub's certificate for the custom domain ("new", "approved", "issued", "errored"…), or null. */
  certificate: string | null;
  private: boolean;
  /** The user is an admin of the repo, so they can turn Pages on. */
  canConfigure: boolean;
  enabled: boolean;
  /** Pages builds with the repo's deploy workflow (not by publishing a branch as-is). */
  usesActions: boolean;
  url: string | null;
  /** The pushed deploy.yml publishes under /<repo>; older copies need the template's files. */
  workflowReady: boolean;
  run: {
    status: string;
    conclusion: string | null;
    url: string;
    commit: string | null;
    createdAt: string;
  } | null;
};

/** Claude's complete proposed page from a preview run. */
export type Proposal = {
  file: string;
  /**
   * "edit": a page changed by an instruction. "generate": written from the page's own draft.
   * "convert": converted from an uploaded HTML page. "markdown": a markdown file outside
   * content/ changed by an instruction.
   */
  mode: "edit" | "generate" | "convert" | "markdown";
  /** The file as it is on disk now, to diff the proposal against. Null if it's gone. */
  original: string | null;
  instruction: string;
  images: string[];
  /** The HTML file a converted page came from (its name), or null. */
  source: string | null;
  /** Other files applying writes (a converted page's own stylesheet, with --keep-styles). */
  files: { file: string; content: string }[];
  /** What an HTML conversion tested before showing this ("attempt 1: …", "pass 2, 1280px wide: …"). */
  checks: string[];
  /** Claude's summary of the change, recorded in the work log when it's applied. */
  summary: string[];
  content: string;
  /** Checks that failed: the script wouldn't have written this version itself. */
  problems: string[];
  /** Worth a look, but not blocking. */
  warnings: string[];
  createdAt: string | null;
};

/**
 * Claude's memory of earlier work: one entry per kept change, oldest first
 * ("- <date> · <command> · <file> · <instruction>", then any summary points on
 * their own "  - " lines, all in one string). Only the newest `sent` entries go
 * to Claude. `available` is false for copies whose scripts predate it.
 */
export type Memory = { available: boolean; lines: string[]; sent: number };

/** An uploaded HTML page, saved inside .git for the "page-convert" command. */
export type HtmlSource = {
  source: string;
  name: string;
  bytes: number;
  /** The stylesheets uploaded with it, for keeping its styles. */
  css: { source: string; name: string; bytes: number }[];
  /** The scripts uploaded with it (the ones the page loads from its own files). Older servers send none. */
  js?: { source: string; name: string; bytes: number }[];
};

/** A page's markdown; `version` must come back with a save. */
export type PageSource = { file: string; content: string; version: string };

/** The two ways the Claude tab works on a page. */
export type EditMode = "generate" | "edit";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type StaticSection = { id: string; label: string; file: string; description: string; data: Json };

/** URL of an image under assets/img/ in the workspace, for thumbnails. */
export function workspaceImageUrl(owner: string, repo: string, path: string) {
  return workspacePath(owner, repo, `/images/file?path=${encodeURIComponent(path)}`);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }

  get reauth() {
    return this.code === "reauth_required";
  }

  get needsAnthropicKey() {
    return this.code === "anthropic_key_required";
  }
}

export async function api<T>(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Network error. Check your connection and try again.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof data.error === "string" && /^[a-z_]+$/.test(data.error) ? data.error : undefined;
    const message =
      data.message ??
      (code === "reauth_required" ? "Your GitHub access has expired." : (data.error ?? `Request failed (${res.status}).`));
    throw new ApiError(message, res.status, code);
  }
  return data as T;
}

export function workspacePath(owner: string, repo: string, rest = "") {
  return `/api/workspaces/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${rest}`;
}
