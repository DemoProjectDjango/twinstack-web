import path from "node:path";
import { getNavigation } from "./navigation.js";
import { STARTER_TEXT, isDesigned } from "./next-steps.js";
import { readText } from "./site-files.js";
import { workspaceDir } from "./workspace.js";

// The site's first homepage, and its first header and footer, are written by Claude Opus whatever
// the account's model (Fable is kept: it's the more capable) and never by the cheaper model: they
// set the look every later page follows. Once they're written, the usual choice applies again.

export const FIRST_DESIGN_MODEL = "claude-opus-5-5";
const STRONGER = new Set(["claude-fable-5-1"]);

/** The model for a first design, given the account's own. */
export const firstDesignModel = (model) => (STRONGER.has(model) ? model : FIRST_DESIGN_MODEL);

const HOME_URL = /^url:\s*["']?\/["']?\s*$/m;

/**
 * What a Claude command is designing for the first time: "homepage" (a page edit or generation of
 * the homepage while it's still the starter skeleton), "header and footer" (neither designed nor
 * copied, as the "Next steps" step counts it), or null.
 */
export async function firstDesign(key, command, input) {
  if (command === "page-edit" || command === "page-generate") {
    const file = typeof input?.page === "string" ? input.page : "";
    if (!/^content\/[\w./-]+\.md$/.test(file) || file.split("/").includes("..")) return null;
    const text = (await readText(path.join(workspaceDir(key), file))) ?? "";
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    if (file !== "content/pages/home.md" && !HOME_URL.test(frontmatter)) return null;
    // A converted homepage (imported HTML and CSS) is written, whatever its markup looks like.
    if (/^stylesheet:\s*\/assets\/css\/imported\//m.test(frontmatter)) return null;
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    return !body || STARTER_TEXT.test(body) || !isDesigned(body) ? "homepage" : null;
  }
  if (command === "chrome-design") {
    const nav = await getNavigation(key);
    const done = (nav.designed?.header && nav.designed?.footer) || nav.copied?.header || nav.copied?.footer;
    return done ? null : "header and footer";
  }
  return null;
}
