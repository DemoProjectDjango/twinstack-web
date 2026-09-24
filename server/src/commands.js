import { existsSync } from "node:fs";
import path from "node:path";
import { IMAGE_PATH, PROPOSAL_FILE, clearProposal } from "./site-files.js";
import { WorkspaceError, markInstalled } from "./workspace.js";

// Every command the site manager can run, mapped to the same scripts the
// site's package.json runs. User input only ever becomes separate argv
// entries for a fixed script (no shell), and values that could be read as a
// flag are rejected.

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
    // Even the preview asks Claude for the proposed file.
    needsKey: () => true,
    steps: (input) => {
      const page = text(input, "page", "Page", { max: 300 });
      if (!MARKDOWN_PAGE.test(page) || page.split("/").includes("..")) {
        throw new WorkspaceError("Pick a page: a .md file under content/.", 400);
      }
      const args = [page, text(input, "instruction", "Instruction", { max: 4000, multiline: true })];
      for (const image of images(input)) args.push(`--image=${image}`);
      // The preview is saved where the web UI reads it back (inside .git, so it's never a change).
      if (flag(input, "dryRun")) args.push("--dry-run", `--proposal-out=${PROPOSAL_FILE}`);
      return [script("edit-page.js", args)];
    },
    // A stale proposal must never be shown as this preview's result.
    prepare: (key, input) => (flag(input, "dryRun") ? clearProposal(key) : undefined),
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
const PASS_ENV = new Set(
  ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL"],
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
