import path from "node:path";
import { getNavigation } from "./navigation.js";
import { STARTER_TEXT, isDesigned } from "./next-steps.js";
import { readText } from "./site-files.js";
import { workspaceDir } from "./workspace.js";

// The site's first homepage is written by Claude Opus whatever the account's model (Fable is kept:
// it's the more capable), and its first header and footer by Sonnet, which follows the homepage's
// look at half the price (their request carries ~27k tokens of rules and the homepage). Never the
// cheaper model: they set the look every later page follows. Once written, the usual choice applies.

export const FIRST_DESIGN_MODEL = "claude-opus-5-5";
export const FIRST_CHROME_MODEL = "claude-sonnet-5-5";
// Passed as TWINSTACK_EFFORT, which older copies ignore: at high, Opus spent most of a first design
// thinking (4 minutes and twice the credits for a homepage); the design review makes up for it.
export const FIRST_DESIGN_EFFORT = "medium";
// The page writer looks at screenshots of the site's first homepage once and fixes what's weak
// (TWINSTACK_DESIGN_REVIEW, edit-page.js's reviewDesign; older copies ignore it), on REVIEW_MODEL
// (TWINSTACK_REVIEW_MODEL), which answers with targeted fixes rather than the whole page.
export const FIRST_HOME_REVIEWS = 1;
export const REVIEW_MODEL = "claude-sonnet-5-5";
const STRONGER = new Set(["claude-fable-5-1"]);

/** The model for a first design (`first`, from firstDesign), given the account's own. */
export const firstDesignModel = (model, first) => (STRONGER.has(model) ? model : first === "header and footer" ? FIRST_CHROME_MODEL : FIRST_DESIGN_MODEL);

const HOME_URL = /^url:\s*["']?\/["']?\s*$/m;
const PAGE_FILE = /^content\/[\w./-]+\.md$/;

/**
 * What a Claude command is designing for the first time: "homepage" (a page edit or generation of
 * the homepage while it's still the starter skeleton), "header and footer" (neither designed nor
 * copied, as the "Next steps" step counts it), or null.
 */
export async function firstDesign(key, command, input) {
  if (command === "page-edit" || command === "page-generate") {
    const file = typeof input?.page === "string" ? input.page : "";
    if (!PAGE_FILE.test(file) || file.split("/").includes("..")) return null;
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

/** How many design reviews a page command gets: FIRST_HOME_REVIEWS for the site's first homepage, else none. */
export const designReviews = (command, first) => ((command === "page-edit" || command === "page-generate") && first === "homepage" ? FIRST_HOME_REVIEWS : 0);
