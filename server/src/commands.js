import { existsSync } from "node:fs";
import path from "node:path";
import {
  CSS_SOURCE_PATH,
  HTML_SOURCE_PATH,
  IMAGE_PATH,
  JS_SOURCE_PATH,
  PROPOSAL_FILE,
  clearProposal,
  htmlSourceExists,
  isEditableMarkdown,
} from "./site-files.js";
import { WorkspaceError, markInstalled } from "./workspace.js";
import { SEO_REPORT } from "./seo.js";

// Every command the site manager can run, mapped to the same scripts the
// site's package.json runs. User input only ever becomes separate argv
// entries for a fixed script (no shell), and values that could be read as a
// flag are rejected.
//
// `claude: true` marks the commands that call Claude: the route hands each of
// them the site's latest work log first (prepareWorkLog in site-files.js) and
// saves what it logged afterwards.

const NODE = process.execPath;
const MINUTE = 60 * 1000;
const NEW_TYPES = ["page", "product", "service", "post", "case"];

function npmCli() {
  const dir = path.dirname(NODE);
  const candidates = [
    process.env.npm_execpath,
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((c) => c?.endsWith("npm-cli.js") && existsSync(c));
  if (!found) throw new WorkspaceError("npm isn't available on the server.", 500);
  return found;
}

function script(name, args = [], timeoutMs = 10 * MINUTE) {
  const file = `scripts/${name}`;
  return { file: NODE, args: [file, ...args], display: ["node", file, ...args.map(quote)].join(" "), timeoutMs };
}

function quote(arg) {
  return /^[\w./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function text(input, name, label, { max = 200, multiline = false, optional = false } = {}) {
  const raw = input?.[name];
  if (raw === undefined || raw === null || raw === "") {
    if (optional) return null;
    throw new WorkspaceError(`${label} is required.`, 400);
  }
  if (typeof raw !== "string") throw new WorkspaceError(`${label} must be text.`, 400);
  const value = raw.trim();
  if (!value && !optional) throw new WorkspaceError(`${label} is required.`, 400);
  if (value.length > max) throw new WorkspaceError(`${label} must be at most ${max} characters.`, 400);
  if (value.startsWith("-")) throw new WorkspaceError(`${label} can't start with "-".`, 400);
  if (value.includes("\0") || (!multiline && /[\r\n]/.test(value))) {
    throw new WorkspaceError(`${label} must be a single line.`, 400);
  }
  return value || null;
}

const flag = (input, name) => input?.[name] === true;

const MARKDOWN_PAGE = /^content\/[\w./-]+\.md$/;
const MAX_IMAGES = 6;

function markdownPage(input) {
  const page = text(input, "page", "Page", { max: 300 });
  if (!MARKDOWN_PAGE.test(page) || page.split("/").includes("..")) {
    throw new WorkspaceError("Pick a page: a .md file under content/.", 400);
  }
  return page;
}

/** --image flags, and for a preview the flags that save it where the web UI reads it back. */
function claudeFlags(input) {
  const args = images(input).map((image) => `--image=${image}`);
  // Inside .git, so the preview is never a change.
  if (flag(input, "dryRun")) args.push("--dry-run", `--proposal-out=${PROPOSAL_FILE}`);
  return args;
}

/** Uploaded stylesheets (saveHtmlSource) for a --keep-styles conversion. */
function cssSources(input) {
  const list = input?.css ?? [];
  if (!Array.isArray(list) || list.length > 10) throw new WorkspaceError("Add at most 10 CSS files.", 400);
  return list.map((entry) => {
    if (typeof entry !== "string" || !CSS_SOURCE_PATH.test(entry) || entry.split("/").includes("..")) {
      throw new WorkspaceError("Upload the CSS files again.", 400);
    }
    return entry;
  });
}

/** Uploaded scripts (saveHtmlSource) the page loads from its own files, kept with it (--js). */
function jsSources(input) {
  const list = input?.js ?? [];
  if (!Array.isArray(list) || list.length > 10) throw new WorkspaceError("Add at most 10 JavaScript files.", 400);
  return list.map((entry) => {
    if (typeof entry !== "string" || !JS_SOURCE_PATH.test(entry) || entry.split("/").includes("..")) {
      throw new WorkspaceError("Upload the JavaScript files again.", 400);
    }
    return entry;
  });
}

/** Images for a Claude edit: https URLs, or image files under assets/img/ in the repo. */
function images(input) {
  const list = input?.images ?? [];
  if (!Array.isArray(list) || list.length > MAX_IMAGES) {
    throw new WorkspaceError(`Attach at most ${MAX_IMAGES} images.`, 400);
  }
  return list.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) throw new WorkspaceError("Invalid image.", 400);
    const value = entry.trim();
    if (/^https?:\/\//i.test(value)) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new WorkspaceError(`"${value}" isn't a valid URL.`, 400);
      }
      if (value.length > 2000 || !["http:", "https:"].includes(url.protocol)) {
        throw new WorkspaceError(`"${value}" isn't a usable image URL.`, 400);
      }
      return url.href;
    }
    if (!IMAGE_PATH.test(value) || value.split("/").includes("..")) {
      throw new WorkspaceError(`"${value}" must be an image under assets/img/ or an http(s) URL.`, 400);
    }
    return value;
  });
}

// The SEO fields the seo-set command takes, the flag the copy's scripts/seo.js reads for each,
// and the longest value accepted. An empty string removes the field (the site's default applies).
const SEO_FIELDS = {
  metaTitle: { flag: "title", label: "SEO title", max: 200 },
  metaDescription: { flag: "description", label: "Meta description", max: 400 },
  focusKeyword: { flag: "keyword", label: "Focus keyphrase", max: 100 },
  ogImage: { flag: "image", label: "Social image", max: 500 },
  ogImageAlt: { flag: "image-alt", label: "Social image alt text", max: 300 },
  canonical: { flag: "canonical", label: "Canonical URL", max: 500 },
};

function seoFieldFlags(input) {
  const fields = input?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new WorkspaceError("Nothing to save.", 400);
  const args = [];
  for (const [name, spec] of Object.entries(SEO_FIELDS)) {
    const value = fields[name];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new WorkspaceError(`${spec.label} must be text.`, 400);
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length > spec.max) throw new WorkspaceError(`${spec.label} must be at most ${spec.max} characters.`, 400);
    if (clean.includes("\0")) throw new WorkspaceError(`${spec.label} has an invalid character.`, 400);
    if (name === "ogImage" && clean && !/^(\/(?!\/)|https?:\/\/)\S+$/.test(clean)) {
      throw new WorkspaceError("Social image must be a site path (/assets/img/…) or an http(s) URL.", 400);
    }
    if (name === "canonical" && clean && !/^(\/(?!\/)|https?:\/\/)\S+$/.test(clean)) {
      throw new WorkspaceError("Canonical URL must start with / or http(s)://.", 400);
    }
    // One argv entry: the value can't be read as a separate flag whatever it starts with.
    args.push(`--${spec.flag}=${clean}`);
  }
  if (fields.noindex !== undefined) {
    if (typeof fields.noindex !== "boolean") throw new WorkspaceError("Hide from search engines must be yes or no.", 400);
    args.push(fields.noindex ? "--noindex" : "--index");
  }
  if (!args.length) throw new WorkspaceError("Nothing to save.", 400);
  return args;
}

export const COMMANDS = {
  install: {
    label: "Install dependencies",
    steps: () => [
      {
        file: NODE,
        // --ignore-scripts: the site needs no install scripts, and skipping
        // them avoids running package lifecycle hooks on this server.
        args: [npmCli(), "ci", "--no-audit", "--no-fund", "--ignore-scripts"],
        display: "npm ci --no-audit --no-fund --ignore-scripts",
        timeoutMs: 15 * MINUTE,
      },
    ],
    onSuccess: markInstalled,
  },

  check: {
    label: "Build and check",
    steps: () => [script("build.js"), script("check.js")],
  },

  preview: {
    label: "Build preview",
    steps: () => [script("build.js", ["--drafts"])],
  },

  new: {
    label: "New page",
    steps: (input) => {
      if (!NEW_TYPES.includes(input?.type)) throw new WorkspaceError("Pick a page type.", 400);
      const title = text(input, "title", "Title");
      const slug = text(input, "slug", "Slug", { optional: true, max: 70 });
      if (slug && !/^[a-z0-9-]+$/.test(slug)) {
        throw new WorkspaceError("Slug may only use lowercase letters, numbers and '-'.", 400);
      }
      const args = [input.type, title];
      if (flag(input, "draft")) args.push("--draft");
      if (slug) args.push(`--slug=${slug}`);
      return [script("new.js", args)];
    },
  },

  "nav-add": {
    label: "Add navigation item",
    steps: (input) => {
      const label = text(input, "label", "Label", { max: 60 });
      const url = text(input, "url", "URL", { max: 300 });
      if (!url.startsWith("/") && !/^https?:\/\//.test(url)) {
        throw new WorkspaceError("URL must start with /, http:// or https://.", 400);
      }
      const args = [label, url];
      const collection = text(input, "collection", "Collection", { optional: true, max: 60 });
      if (collection) {
        if (!/^[A-Za-z0-9-]+$/.test(collection)) {
          throw new WorkspaceError("Collection may only use letters, numbers and '-'.", 400);
        }
        args.push(`--collection=${collection}`);
        const limit = Number(input.limit ?? 8);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new WorkspaceError("Limit must be a whole number from 1 to 100.", 400);
        }
        args.push(`--limit=${limit}`);
      } else if (flag(input, "plain")) {
        args.push("--plain");
      }
      return [script("nav.js", args)];
    },
  },

  "nav-remove": {
    label: "Remove navigation item",
    steps: (input) => [script("nav-remove.js", [text(input, "identifier", "Label or URL", { max: 300 })])],
  },

  "page-edit": {
    label: "Edit with Claude",
    claude: true,
    // Even the preview asks Claude for the proposed file.
    needsKey: () => true,
    steps: (input) => {
      const args = [markdownPage(input), text(input, "instruction", "Instruction", { max: 4000, multiline: true })];
      return [script("edit-page.js", [...args, ...claudeFlags(input)])];
    },
    // A stale proposal must never be shown as this preview's result.
    prepare: (key, input) => (flag(input, "dryRun") ? clearProposal(key) : undefined),
  },

  // The user writes the page's draft by hand; Claude turns it into the finished page.
  "page-generate": {
    label: "Generate page with Claude",
    claude: true,
    needsKey: () => true,
    steps: (input) => {
      const args = [markdownPage(input), "--generate"];
      const direction = text(input, "instruction", "Direction", { max: 4000, multiline: true, optional: true });
      if (direction) args.push(direction);
      return [script("edit-page.js", [...args, ...claudeFlags(input)])];
    },
    prepare: (key, input) => (flag(input, "dryRun") ? clearProposal(key) : undefined),
  },

  // An existing HTML page (uploaded into .git by saveHtmlSource) converted into the page's markdown.
  "page-convert": {
    label: "Convert HTML with Claude",
    claude: true,
    needsKey: () => true,
    steps: (input) => {
      const source = text(input, "source", "HTML file", { max: 200 });
      if (!HTML_SOURCE_PATH.test(source)) throw new WorkspaceError("Upload the HTML file again.", 400);
      const args = [markdownPage(input), `--from-html=${source}`];
      // The page is copied as-is with its own CSS, scoped to it, unless markdown is asked for
      // (keepStyles: false). --keep-styles is passed for copies made before that was the default;
      // --markdown is ignored by those copies, whose default was markdown anyway.
      if (input?.keepStyles === false) args.push("--markdown");
      else {
        args.push("--keep-styles", ...cssSources(input).map((css) => `--css=${css}`), ...jsSources(input).map((js) => `--js=${js}`));
      }
      const direction = text(input, "instruction", "Direction", { max: 4000, multiline: true, optional: true });
      if (direction) args.push(direction);
      // Up to three Claude requests (the conversion, a review, a correction) and, with styles kept,
      // a browser check at three widths.
      return [script("edit-page.js", [...args, ...claudeFlags(input)], 20 * MINUTE)];
    },
    prepare: async (key, input) => {
      if (!htmlSourceExists(key, input.source)) throw new WorkspaceError("The uploaded HTML file is gone. Upload it again.", 409);
      if (input?.keepStyles !== false && ![...cssSources(input), ...jsSources(input)].every((file) => htmlSourceExists(key, file))) {
        throw new WorkspaceError("An uploaded CSS or JavaScript file is gone. Upload the files again.", 409);
      }
      if (flag(input, "dryRun")) await clearProposal(key);
    },
  },

  // Markdown outside content/ (the site tree, the schedule, the docs), via the copy's scripts/edit-md.js.
  "md-edit": {
    label: "Edit markdown with Claude",
    claude: true,
    needsKey: () => true,
    steps: (input) => {
      const file = text(input, "file", "File", { max: 300 });
      if (!isEditableMarkdown(file)) {
        throw new WorkspaceError("Pick a markdown file outside content/, dist/ and node_modules/.", 400);
      }
      const args = [file, text(input, "instruction", "Instruction", { max: 4000, multiline: true })];
      if (flag(input, "dryRun")) args.push("--dry-run", `--proposal-out=${PROPOSAL_FILE}`);
      return [script("edit-md.js", args)];
    },
    prepare: (key, input) => (flag(input, "dryRun") ? clearProposal(key) : undefined),
  },

  // SEO (scripts/seo.js): every run also saves the audit where the SEO tab reads it (readSeo in seo.js).
  "seo-audit": {
    label: "Check SEO",
    steps: () => [script("seo.js", [`--report=${SEO_REPORT}`])],
  },

  "seo-set": {
    label: "Save SEO",
    steps: (input) => [script("seo.js", [markdownPage(input), ...seoFieldFlags(input), `--report=${SEO_REPORT}`])],
  },

  // One page (with a preview proposal, mode "seo"), or every page without its own SEO title or
  // description (all: true; force: true for every page). Claude only writes the title, the
  // description and the focus keyphrase.
  "seo-claude": {
    label: "Write SEO with Claude",
    claude: true,
    needsKey: () => true,
    steps: (input) => {
      const direction = text(input, "instruction", "Direction", { max: 2000, multiline: true, optional: true });
      if (flag(input, "all")) {
        const args = ["--all", "--claude"];
        if (direction) args.push(direction);
        if (flag(input, "force")) args.push("--force");
        if (flag(input, "dryRun")) args.push("--dry-run");
        // A request per page, and up to two corrections each.
        return [script("seo.js", [...args, `--report=${SEO_REPORT}`], 30 * MINUTE)];
      }
      const args = [markdownPage(input), "--claude"];
      if (direction) args.push(direction);
      if (flag(input, "dryRun")) args.push("--dry-run", `--proposal-out=${PROPOSAL_FILE}`);
      return [script("seo.js", [...args, `--report=${SEO_REPORT}`])];
    },
    prepare: (key, input) => (flag(input, "dryRun") && !flag(input, "all") ? clearProposal(key) : undefined),
  },

  scaffold: {
    label: "Scaffold site tree",
    steps: (input) => {
      const args = [];
      if (flag(input, "dryRun")) args.push("--dry-run");
      if (flag(input, "force")) args.push("--force");
      return [script("scaffold-tree.js", args)];
    },
  },

  schedule: {
    label: "Run scheduled jobs",
    claude: true,
    // The preview prints the prompts instead of calling Claude.
    needsKey: (input) => !flag(input, "dryRun"),
    steps: (input) => [script("scaffold-schedule.js", flag(input, "dryRun") ? ["--dry-run"] : [], 30 * MINUTE)],
  },

  changelog: {
    label: "Regenerate changelog",
    steps: () => [script("changelog.js")],
  },
};

// Only these reach the site's scripts. In particular the server's own secrets
// and the user's GitHub token are never visible to repo code.
// CHROME_PATH lets an HTML conversion's render check find a browser that isn't on PATH.
const PASS_ENV = new Set(
  ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "CHROME_PATH"],
);

export function jobEnv(anthropicKey) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (PASS_ENV.has(name.toUpperCase())) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.NO_COLOR = "1";
  env.npm_config_update_notifier = "false";
  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
    // Lets the server route Claude calls through a proxy (or a mock in tests).
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  }
  return env;
}
