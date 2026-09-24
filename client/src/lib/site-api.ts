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

export type Overview = {
  site: { name: string; url: string; model: string | null };
  /** pageEditImages: the copy's edit-page.js supports --image and --proposal-out. */
  features: { pageEditImages: boolean };
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

/** Claude's complete proposed page from a "Preview change" run. */
export type Proposal = {
  file: string;
  instruction: string;
  images: string[];
  content: string;
  problems: string[];
  createdAt: string | null;
};

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
