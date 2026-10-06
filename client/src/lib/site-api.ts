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

/** `url` is set when the page's frontmatter chooses its address: "/" is the homepage. Older servers send none. */
export type SitePage = { file: string; slug: string; title: string; url?: string | null; draft: boolean; date: string | null };

/**
 * The homepage: the page at "/" (index.html in the site tree, content/pages/home.md when scaffolded).
 * Only a server too old to send `url` leaves it to the file name: a home.md without `url: /` is an
 * ordinary page at /home.html.
 */
export const isHomePage = (page: SitePage) => page.url === "/" || (page.url === undefined && page.file === "content/pages/home.md");

/** site.config.json → brand: images are site paths ("/assets/img/…"), "" when not set. */
export type Brand = { logoText: string; logo: string; logoDark: string; logoMark: string; favicon: string };
/** The brand with data: URL previews of its images (null when missing or large); `supported` is false for copies whose templates only show the mark and name. */
export type BrandInfo = { brand: Brand; previews: Partial<Record<"logo" | "logoDark" | "logoMark" | "favicon", string | null>>; supported: boolean };

/**
 * content/data/navigation.json as the Header & footer tab edits it. Items keep any other fields
 * the file has. A header item is a link, a dropdown (`children`), or a collection menu
 * (`type: "collection"`, which lists that collection's pages itself, up to `limit`). An unlabelled
 * collection entry in a footer column lists the pages as the column's links.
 */
export type NavLink = { label: string; url: string; description?: string; [field: string]: unknown };
export type NavItem = {
  label: string;
  url?: string;
  type?: "collection";
  collection?: string;
  limit?: number;
  children?: NavLink[];
  description?: string;
  [field: string]: unknown;
};
export type FooterColumn = { title: string; links: NavItem[]; [field: string]: unknown };
export type HeaderTheme = "light" | "dark" | "brand";
export type FooterTheme = "dark" | "light" | "brand";
export type MenuLayout = "right" | "center" | "left";
export type NavAppearance = {
  header: { theme: HeaderTheme; layout: MenuLayout; sticky: boolean };
  /** `copyright` follows "© <year>"; empty shows the site name and "All rights reserved." */
  footer: { theme: FooterTheme; showTagline: boolean; showContact: boolean; copyright: string };
};
export type Navigation = {
  header: { items: NavItem[]; cta: { label: string; url: string; [field: string]: unknown } | null };
  footer: FooterColumn[];
  legal: NavLink[];
  appearance: NavAppearance;
};
/**
 * The header and footer with what the editor needs around them. `supportsAppearance` is false for
 * copies whose header.html, footer.html and content.js predate the appearance settings. `version`
 * must come back with a save. `pages` is every page the site builds (drafts marked), for picking
 * links and spotting ones the build would leave out.
 */
export type NavigationInfo = {
  navigation: Navigation;
  supportsAppearance: boolean;
  version: string;
  collections: { name: string; label: string }[];
  pages: { url: string; title: string; collection: string; draft: boolean }[];
  site: { name: string; footerTagline: string; foundedYear: number | string | null; email: string; phone: string };
};

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
   * seo: it has scripts/seo.js (the SEO tab). seoTemplate: its base.html renders the tags seo.js sets.
   * Older servers send neither.
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
    seo?: boolean;
    seoTemplate?: boolean;
    /** Its build.js takes --proposal, so a Claude proposal can be shown as the built page. */
    proposalPreview?: boolean;
  };
  /** Markdown files outside content/ that the "md-edit" command may change. Empty without mdEdit. */
  markdownFiles: string[];
  /** Global stylesheets declared in scripts/site-tree.md ("- css/style.css"), kept as styles/global/<path>. Empty without globalCss. */
  globalStylesheets: { path: string; file: string; exists: boolean }[];
  collections: { name: string; dir: string; label: string; pages: SitePage[] }[];
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
  mode: "edit" | "generate" | "convert" | "markdown" | "seo";
  /** The file as it is on disk now, to diff the proposal against. Null if it's gone. */
  original: string | null;
  instruction: string;
  images: string[];
  /** The HTML file a converted page came from (its name), or null. */
  source: string | null;
  /**
   * Other files applying writes: a converted page's own stylesheet and scripts, or the shared data
   * files (content/data/*.json) an edit of a page like the homepage changes. `original` is the file's
   * current text, null if it doesn't exist yet (older servers send none).
   */
  files: { file: string; content: string; original?: string | null }[];
  /**
   * The site built with this proposal applied ("proposal-preview"): `url` opens the page in the
   * sandboxed preview, `edited` when it was built from the user's edited text. Null until built.
   */
  preview?: { url: string; edited: boolean; builtAt: string } | null;
  /** For mode "seo" (the SEO tab's suggestion for a page): the fields Claude suggests. Older servers send none. */
  seo?: SeoSuggestion | null;
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

/** A page's own SEO fields (frontmatter); "" means not set, so the site's default applies. */
export type SeoFields = {
  metaTitle: string;
  metaDescription: string;
  focusKeyword: string;
  ogImage: string;
  ogImageAlt: string;
  canonical: string;
  noindex: boolean;
};
export type SeoSuggestion = Pick<SeoFields, "metaTitle" | "metaDescription" | "focusKeyword">;
export type SeoIssue = { level: "error" | "warning" | "tip" | "note"; field: string; message: string };
/** One page in the copy's SEO audit (scripts/seo.js --report). `seo` is what search engines get. */
export type SeoPage = {
  file: string;
  url: string;
  absoluteUrl: string;
  collection: string;
  title: string;
  draft: boolean;
  date: string | null;
  fields: SeoFields;
  seo: {
    title: string;
    /** The title when metaTitle is empty, from the site's title template. */
    defaultTitle: string;
    description: string;
    /** The description when metaDescription is empty: the page's description, or the start of its text. */
    defaultDescription: string;
    descriptionSource: "seo" | "page" | "body";
    socialTitle: string;
    image: string;
    imagePath: string;
    /** The social image when ogImage is empty: the page's image, or the site's default. Older copies send none. */
    defaultImagePath?: string;
    imageAlt: string;
    canonical: string;
    robots: string;
    type: "article" | "website";
  };
  score: number;
  issues: SeoIssue[];
};
export type SeoReport = {
  createdAt: string;
  site: { name: string; shortName: string; url: string };
  summary: { pages: number; average: number; errors: number; warnings: number };
  pages: SeoPage[];
};
/**
 * The SEO tab's data. `available`: the copy has scripts/seo.js. `template`: its base.html renders
 * the tags. `report` is the latest audit (null before the first), `stale` once a page changed since.
 */
export type SeoInfo = { available: boolean; template: boolean; report: SeoReport | null; stale: boolean };

/** A page a problem is about. */
export type ProblemPage = { file: string; title: string };

/**
 * One problem the site check found (server/src/site-check.js): the deploy runs the same check, so
 * while any is left the live site doesn't update.
 */
export type SiteProblem =
  | {
      kind: "missing-link";
      message: string;
      /** Where the link points, e.g. "/" or "/pricing.html". */
      href: string;
      /**
       * home: the site has no homepage. listing: a collection has no listing page (`listing`).
       * hidden: the page is hidden (`hiddenPage`). page: no such page. file: no such image or file.
       */
      target: "home" | "listing" | "hidden" | "page" | "file";
      hiddenPage?: ProblemPage;
      listing?: { collection: string; label: string };
      /** The page the link is on, or null if it couldn't be matched. */
      page: (ProblemPage & { url: string }) | null;
      /** In the page's own text; otherwise the site's design makes it (logo, menu, footer, a layout or shared data). */
      inPageText: boolean;
    }
  | { kind: "duplicate"; message: string; url: string; pages: ProblemPage[] }
  | { kind: "no-date"; message: string; page: ProblemPage }
  | { kind: "other"; message: string };

export type SiteCheckReport = {
  checkedAt: string;
  /** Passed: nothing stops the live site from updating. */
  ok: boolean;
  /** The site couldn't be built, so the check never ran; `failure` has the error. */
  buildFailed: boolean;
  failure: string | null;
  problems: SiteProblem[];
  /** Problems beyond the first 100, left out. */
  moreProblems: number;
  warnings: string[];
};

/** The latest check and whether it's current: `fresh` is false once a file changed since. */
export type SiteCheck = { report: SiteCheckReport | null; fresh: boolean };

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

/** The two ways Claude works on a page's own text in the page editor. */
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

// Runs before every request that changes something (not job polling or cancelling): the site
// editor uses it to stop its own preview rebuild, which would otherwise hold the workspace lock.
let beforeChange: (() => Promise<void>) | null = null;

export function setBeforeChange(hook: (() => Promise<void>) | null) {
  beforeChange = hook;
}

export async function api<T>(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<T> {
  if (method !== "GET" && beforeChange && !path.startsWith("/api/jobs/")) await beforeChange();
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
