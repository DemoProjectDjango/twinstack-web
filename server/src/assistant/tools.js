import { createHash } from "node:crypto";
import path from "node:path";
import { addAttachmentToSite, readAttachmentMeta, sitePathFor } from "./attachments.js";
import { getBrand, saveBrand } from "../brand.js";
import { getNavigation, saveNavigation } from "../navigation.js";
import { readSeo } from "../seo.js";
import {
  IMAGE_PATH,
  deletePage,
  getOverview,
  listCss,
  listImages,
  listingOf,
  readCss,
  readDataFile,
  readPage,
  readSchedule,
  readSiteConfig,
  saveCss,
  writeDataFile,
  writeSchedule,
} from "../site-files.js";
import { readCheckReport } from "../site-check.js";
import { getStaticInfo, saveStaticInfo } from "../static-info.js";
import { WorkspaceError, commitAndPush, getStatus } from "../workspace.js";
import { SYSTEM_PROMPT } from "./prompt.js";

// The assistant's tools. Read tools run on the server as soon as Claude calls them. Change tools
// never change anything when called: they're checked, the site's current state is captured for
// the card, and the change becomes an "action" the user applies or skips in the chat. Actions
// marked `runs: "server"` are applied by applyServerAction; `runs: "client"` ones run the site's
// commands from the browser (as jobs, like the rest of the editor) and report back.
//
// The list is fixed and in a fixed order: it's part of every request's cached prefix, and a
// conversation's thinking blocks are bound to the exact tool set it started with.

const PAGE_FILE = /^content\/[\w./-]+\.md$/;
const PAGE_TYPES = ["page", "post", "service", "product", "case"];
// "Add a page" types, and the pages only the site plan's rules can make: the homepage and a
// collection's listing page (createHomepage, createListingPage).
const CREATE_TYPES = [...PAGE_TYPES, "homepage", "listing"];
const MAX_READ_CHARS = 80_000;
const SEO_FIELD_NAMES = ["metaTitle", "metaDescription", "focusKeyword", "ogImage", "ogImageAlt", "canonical", "noindex"];
const LOGO_FIELDS = ["logoText", "logo", "logoDark", "logoMark", "favicon"];
const ATTACHMENT_ID = /^att_[a-f0-9]{16}$/;
const MAX_IMAGES = 6;

const imagesField = {
  images: {
    type: "array",
    items: { type: "string" },
    description: "Optional, up to 6 images for the writer to look at and place: an attached image's id (att_…, after add_file_to_site for it), a photo already on the site (assets/img/…, from list_images) or an https URL.",
  },
};

const summaryField = {
  summary: {
    type: "string",
    description: "What this change does, in one or two short plain-language sentences for the site owner (no file paths or technical words). Shown on the card they apply.",
  },
};
const continueField = {
  continue_after: {
    type: "boolean",
    description: "True when you need this change's result before proposing the next step (for example, pages must exist before you can write them). You'll get the result and can continue.",
  },
};

/** Builds a tool definition; every input streams as it's generated (eager_input_streaming). */
function tool(name, description, properties, required = [], extra = {}) {
  return {
    definition: {
      name,
      description,
      input_schema: { type: "object", properties, required, additionalProperties: false },
      eager_input_streaming: true,
    },
    ...extra,
  };
}

const TOOLS = [
  // ------------------------------------------------------------------ read
  tool(
    "get_site_overview",
    "The site's name and address, every page (file, title, address, whether it's hidden from the published site) grouped by collection, the stylesheets, and the changes not yet published. Call this first when you need to know what pages exist.",
    {},
    [],
    { kind: "read", activity: () => "Looking at your pages" },
  ),
  tool(
    "read_page",
    "The full source of one page: its settings block (frontmatter between --- lines: title, description, layout, address, hidden) and its text in Markdown.",
    { file: { type: "string", description: "The page's file, from get_site_overview, e.g. content/pages/about.md" } },
    ["file"],
    { kind: "read", activity: (input) => `Reading ${input.file ?? "a page"}` },
  ),
  tool(
    "read_site_plan",
    "The site plan (scripts/site-tree.md): the list of every page the site should have. Each bullet is a path (index.html is the homepage, about.html → content/pages/about.md, services/index.html → the Services listing, services/x.html → content/services/x.md; a first folder that matches a collection puts the page in it). Text after \" — \" on a line is a note about that page. Read it before proposing a new plan.",
    {},
    [],
    { kind: "read", activity: () => "Reading the site plan" },
  ),
  tool(
    "read_navigation",
    "The header menu (items, dropdowns, automatic collection menus, the button), the footer's link columns, the legal links and the header/footer appearance, plus every page's address for linking. Read it before proposing a menu change.",
    {},
    [],
    { kind: "read", activity: () => "Looking at the menu and footer" },
  ),
  tool(
    "read_site_details",
    "Site-wide facts in sections (site name and taglines, contact details, social links, company facts, FAQ, testimonials, homepage sections…). Each section has an id and its current data.",
    {},
    [],
    { kind: "read", activity: () => "Reading the site details" },
  ),
  tool(
    "read_logo_settings",
    "The logo settings: the name shown beside the icon (logoText) and the image paths for the logo, the logo on dark backgrounds, the small icon and the favicon (\"\" when not set).",
    {},
    [],
    { kind: "read", activity: () => "Looking at the logo settings" },
  ),
  tool(
    "read_search_report",
    "How pages show up in search results: each page's score out of 100, its search title, description and focus keyphrase (own and effective), and what to fix. Pass file for one page in full; leave it out for every page.",
    { file: { type: "string", description: "Optional: one page's file for its full details." } },
    [],
    { kind: "read", activity: (input) => (input.file ? `Checking how ${input.file} shows up in search` : "Checking how your pages show up in search") },
  ),
  tool(
    "read_site_problems",
    "What the last check before publishing found: the check the live site runs before it updates, so while any problem is left, publishing doesn't change the live site. Each problem has a kind: missing-link (page links to href, which isn't in the published site; target home means the site has no homepage, listing that a collection has no listing page yet (listing names it), hidden a hidden page, page no such page, file no such image or file; inPageText false means the link comes from the site's design, such as the logo, menu, footer or a layout), duplicate (two pages at one address), no-date (a blog post without a date) or other. buildFailed means the site couldn't be built at all (failure has the error). outOfDate means the site changed since; the Publish screen checks again by itself.",
    {},
    [],
    { kind: "read", activity: () => "Checking what stops your site from publishing" },
  ),
  tool(
    "read_stylesheet",
    "One of the site's stylesheets (from get_site_overview's stylesheets list).",
    { file: { type: "string" } },
    ["file"],
    { kind: "read", activity: (input) => `Reading ${input.file ?? "a stylesheet"}` },
  ),
  tool(
    "read_schedule",
    "The scheduled pages: dated jobs where a page is written (from a brief) on a given day.",
    {},
    [],
    { kind: "read", activity: () => "Reading the schedule" },
  ),
  tool(
    "list_images",
    "The images already in the site (paths under assets/img/), for using one on a page, as a social image or as the logo.",
    {},
    [],
    { kind: "read", activity: () => "Looking at your photos" },
  ),

  // ---------------------------------------------------------------- change
  tool(
    "edit_page",
    "Proposes changing one existing page's wording or layout. A writer that knows the site's house style rewrites the page from your instruction, and the finished page is kept. The writer can't see this conversation: make the instruction complete and self-contained, with every fact, name, number and the tone the owner gave you.",
    {
      file: { type: "string", description: "The page's file, e.g. content/pages/about.md" },
      instruction: { type: "string", description: "What to change, fully specified (up to 4000 characters)." },
      ...imagesField,
      ...summaryField,
      ...continueField,
    },
    ["file", "instruction", "summary"],
    { kind: "change", runs: "client", title: "Change a page" },
  ),
  tool(
    "create_page",
    "Proposes adding a new page. With a brief, the writer then writes it and it is kept; without one it starts as an empty page. Types: page (About, Contact…), post (dated blog/news article), service, product, case (case study), homepage (the page at the site's main address, only when the site has none), listing (a collection's own page that lists its pages, such as the Blog page; give collection). slug and hidden don't apply to homepage and listing.",
    {
      type: { type: "string", enum: CREATE_TYPES },
      collection: { type: "string", description: "For type listing: the collection it lists, by name from get_site_overview (e.g. blog)." },
      title: { type: "string" },
      slug: { type: "string", description: "Optional web address: lowercase letters, numbers and dashes. Made from the title when left out." },
      address: {
        type: "string",
        description: "For type page only: the exact address the page must have, when a link already points there (e.g. /pricing or /services/design.html). Overrides slug. Use it for missing pages the site links to.",
      },
      hidden: { type: "boolean", description: "Keep it off the published site until the owner unhides it." },
      brief: { type: "string", description: "Optional: what the page should say, complete and self-contained (facts, names, tone). Up to 4000 characters." },
      ...imagesField,
      ...summaryField,
      ...continueField,
    },
    ["type", "title", "summary"],
    { kind: "change", runs: "client", title: "Add a page" },
  ),
  tool(
    "delete_page",
    "Proposes removing a page from the site. Menu and footer links to it are left out of the published site automatically.",
    { file: { type: "string" }, ...summaryField, ...continueField },
    ["file", "summary"],
    { kind: "change", runs: "server", title: "Remove a page" },
  ),
  tool(
    "add_file_to_site",
    "Proposes adding a file the owner attached (att_…) to the site. Images go with the site's photos (assets/img/uploads/); any other file (a PDF menu, a price list…) goes in assets/files/ and is published at /assets/files/<name>, ready to link to. To show an attached photo on a page, propose this first and then edit_page with the same att_… id in images.",
    {
      attachment: { type: "string", description: "The attachment's id, att_…" },
      name: { type: "string", description: "Optional file name to use on the site, e.g. summer-menu.pdf." },
      ...summaryField,
      ...continueField,
    },
    ["attachment", "summary"],
    { kind: "change", runs: "server", title: "Add a file to the site" },
  ),
  tool(
    "convert_page_from_html",
    "Proposes replacing an existing page with a web page the owner attached as an .html file (saved from their old website). The old site's header, menu and footer are removed; by default the rest keeps its own look. Attach its stylesheets and scripts too if the owner sent them. The owner sees the result before keeping it. To bring it in as a new page, create_page first (continue_after), then convert into that page.",
    {
      file: { type: "string", description: "The page it becomes, e.g. content/pages/about.md" },
      attachment: { type: "string", description: "The .html attachment's id, att_…" },
      extra_files: { type: "array", items: { type: "string" }, description: "Optional: att_… ids of the page's .css and .js files." },
      keep_styles: { type: "boolean", description: "Keep the page looking as it did (default). False rewrites it in the site's own design." },
      direction: { type: "string", description: "Optional guidance, e.g. what to call the page." },
      ...summaryField,
      ...continueField,
    },
    ["file", "attachment", "summary"],
    { kind: "change", runs: "client", title: "Bring in a page" },
  ),
  tool(
    "update_site_plan",
    "Proposes a new site plan: the complete new text of scripts/site-tree.md (read it first and keep its introduction and format). Adding a line doesn't create the page: follow with create_missing_pages.",
    { content: { type: "string", description: "The complete new file." }, ...summaryField, ...continueField },
    ["content", "summary"],
    { kind: "change", runs: "server", title: "Change the site plan" },
  ),
  tool(
    "create_missing_pages",
    "Proposes creating every page in the site plan that doesn't exist yet, as empty pages ready to write. Set continue_after to write them next with edit_page.",
    { ...summaryField, ...continueField },
    ["summary"],
    { kind: "change", runs: "client", title: "Create the missing pages" },
  ),
  tool(
    "update_page_search_settings",
    "Proposes one page's search settings. Include only the fields that change; \"\" removes a field so the page's own title/description is used. Titles about 50-60 characters, descriptions about 120-155.",
    {
      file: { type: "string" },
      fields: {
        type: "object",
        properties: {
          metaTitle: { type: "string", description: "The title in search results." },
          metaDescription: { type: "string", description: "The description in search results." },
          focusKeyword: { type: "string", description: "The search phrase this page should be found for." },
          ogImage: { type: "string", description: "Social image: a site path (/assets/img/…) or an https URL." },
          ogImageAlt: { type: "string" },
          canonical: { type: "string", description: "Only when another address has the same content." },
          noindex: { type: "boolean", description: "Hide the page from search engines." },
        },
        additionalProperties: false,
      },
      ...summaryField,
      ...continueField,
    },
    ["file", "fields", "summary"],
    { kind: "change", runs: "client", title: "Change search settings" },
  ),
  tool(
    "write_search_text_for_all_pages",
    "Proposes having the search-text writer write the search title, description and focus keyphrase for every page that hasn't got its own (or every page), one at a time, so none repeat.",
    {
      direction: { type: "string", description: "Optional guidance for every page, e.g. the audience or area." },
      include_pages_that_have_it: { type: "boolean", description: "Rewrite pages that already have their own search text too." },
      ...summaryField,
      ...continueField,
    },
    ["summary"],
    { kind: "change", runs: "client", title: "Write search text for every page" },
  ),
  tool(
    "update_menu_and_footer",
    "Proposes the complete new navigation object (read_navigation first, change only what's asked, keep every other field and item as it is). Links start with /, #, mailto:, tel: or https://. A header item is a link ({label, url}), a dropdown ({label, children: [links]}) or a collection menu ({label, type: \"collection\", collection, limit}). appearance.header: theme light|dark|brand, layout right|center|left, sticky, style bar|floating, transparent (see-through over the top of the page until scrolled), shrink (lower once scrolled). appearance.footer: theme dark|light|brand, layout columns|centered|minimal, showTagline, showContact, showSocial (icons for the social links in Site details), cta {title, text, label, url} (a call-to-action strip above the footer; null for none), copyright. When read_navigation says supportsStyles is false the site's templates predate style, transparent, shrink, layout, showSocial and cta; when copied says a header or footer was copied from a page, the menu and appearance don't change it.",
    { navigation: { type: "object", description: "The full navigation: header {items, cta}, footer [columns], legal [links], appearance." }, ...summaryField, ...continueField },
    ["navigation", "summary"],
    { kind: "change", runs: "server", title: "Change the menu and footer" },
  ),
  tool(
    "design_header_and_footer",
    "Proposes a new design for the header and footer, which every page shows. A designer that knows the site designs both together in the look of its pages, and they are kept. Their content stays the site's: the menu, button and footer links (update_menu_and_footer), logo and copyright. Use it to change how they look; the designer can't see this conversation, so put the look the owner described in the instruction.",
    {
      instruction: { type: "string", description: "Optional: the look wanted, complete and self-contained (up to 4000 characters). Leave out to match the site's pages." },
      ...summaryField,
      ...continueField,
    },
    ["summary"],
    { kind: "change", runs: "client", title: "Design the header and footer" },
  ),
  tool(
    "update_site_details",
    "Proposes new data for one site-details section (read_site_details first). Send the section's complete data with the same fields and types; only change the values asked for.",
    { section: { type: "string", description: "The section id." }, data: { description: "The section's complete new data." }, ...summaryField, ...continueField },
    ["section", "data", "summary"],
    { kind: "change", runs: "server", title: "Change the site details" },
  ),
  tool(
    "update_logo_settings",
    "Proposes logo settings: logoText (the name), or an image path for logo, logoDark, logoMark or favicon. Images must already be in the site (list_images); \"\" removes one (not logoMark).",
    {
      brand: {
        type: "object",
        properties: Object.fromEntries(LOGO_FIELDS.map((f) => [f, { type: "string" }])),
        additionalProperties: false,
      },
      ...summaryField,
      ...continueField,
    },
    ["brand", "summary"],
    { kind: "change", runs: "server", title: "Change the logo" },
  ),
  tool(
    "update_stylesheet",
    "Proposes the complete new text of one of the site's stylesheets (read it first; change only what's needed).",
    { file: { type: "string" }, content: { type: "string" }, ...summaryField, ...continueField },
    ["file", "content", "summary"],
    { kind: "change", runs: "server", title: "Change the styles" },
  ),
  tool(
    "update_notes_for_claude",
    "Proposes the complete new standing notes every Claude request follows (voice, audience, decisions, things to avoid). Use when the owner says to always do something, or to remember something.",
    { content: { type: "string", description: "The complete new notes file (Markdown)." }, ...summaryField, ...continueField },
    ["content", "summary"],
    { kind: "change", runs: "server", title: "Change Claude's notes" },
  ),
  tool(
    "schedule_page",
    "Proposes a scheduled page: on the date, the page is written from the brief and added to the site.",
    {
      location: { type: "string", description: "Where it goes: a collection folder such as content/blog, or a folder under content/pages/." },
      title: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
      brief: { type: "string", description: "What the page is for and who it's for." },
      notes: { type: "string", description: "Optional facts, quotes or copy to write from." },
      ...summaryField,
      ...continueField,
    },
    ["location", "title", "date", "brief", "summary"],
    { kind: "change", runs: "server", title: "Schedule a page" },
  ),
  tool(
    "publish_changes",
    "Proposes publishing every unpublished change to the live site. Only when the owner asks to publish or put changes live.",
    { message: { type: "string", description: "A short note for the site's history, e.g. \"Add the careers page\"." }, ...summaryField },
    ["message", "summary"],
    { kind: "change", runs: "server", title: "Publish" },
  ),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.definition.name, t]));

/** The tool definitions for every request (the same list, in the same order, every time). */
export const TOOL_DEFINITIONS = TOOLS.map((t) => t.definition);

/**
 * Identifies this tool list and the system prompt. A conversation is bound to both (its thinking
 * blocks are), so one started with a different list or prompt is replaced by a fresh conversation.
 */
export const TOOLSET_VERSION = createHash("sha256").update(JSON.stringify(TOOL_DEFINITIONS)).update(SYSTEM_PROMPT).digest("hex").slice(0, 12);

export function toolInfo(name) {
  return BY_NAME.get(name) ?? null;
}

/* ------------------------------------------------------------- validation */

class ToolInputError extends Error {}

function str(input, name, { max = 4000, optional = false } = {}) {
  const value = input?.[name];
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new ToolInputError(`${name} is required.`);
  }
  if (typeof value !== "string") throw new ToolInputError(`${name} must be a string.`);
  if (value.length > max) throw new ToolInputError(`${name} must be at most ${max} characters.`);
  if (value.includes("\0")) throw new ToolInputError(`${name} has an invalid character.`);
  return value;
}

function pageFileOf(input) {
  const file = str(input, "file", { max: 300 });
  if (!PAGE_FILE.test(file) || file.split("/").includes("..")) {
    throw new ToolInputError(`"${file}" isn't a page file. Use a file from get_site_overview (content/…/*.md).`);
  }
  return file;
}

/** Images for the writer: attachment ids (checked to be images), site image paths or https URLs. */
async function imagesOf(input, key) {
  const list = input?.images;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_IMAGES) throw new ToolInputError(`images must be a list of at most ${MAX_IMAGES}.`);
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string" || !raw.trim()) throw new ToolInputError("Each image must be a string.");
    const value = raw.trim().replace(/^\//, "");
    if (ATTACHMENT_ID.test(value)) {
      const meta = await attachmentOf(value, key);
      if (!sitePathFor(meta).dir.startsWith("assets/img")) throw new ToolInputError(`${value} (${meta.name}) isn't a PNG, JPEG, GIF or WebP image.`);
    } else if (!/^https:\/\/\S+$/i.test(value) && !(IMAGE_PATH.test(value) && !value.split("/").includes(".."))) {
      throw new ToolInputError(`"${raw}" isn't an attachment id, a photo under assets/img/ or an https URL.`);
    }
    out.push(value);
  }
  return out;
}

async function attachmentOf(id, key) {
  if (typeof id !== "string" || !ATTACHMENT_ID.test(id)) throw new ToolInputError(`"${id}" isn't an attachment id (att_…).`);
  try {
    return await readAttachmentMeta(key, id);
  } catch {
    throw new ToolInputError(`There's no attachment ${id}.`);
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function capped(text) {
  return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n[…cut off: ${text.length - MAX_READ_CHARS} more characters]` : text;
}

/* ----------------------------------------------------------- read tools */

async function runRead(name, input, key) {
  switch (name) {
    case "get_site_overview": {
      const [overview, status, css] = await Promise.all([getOverview(key), getStatus(key), listCss(key).catch(() => [])]);
      return {
        site: { name: overview.site.name, address: overview.site.url },
        collections: overview.collections.map((c) => ({
          name: c.name,
          label: c.label,
          folder: c.dir,
          pages: c.pages.map((p) => ({ file: p.file, title: p.title, address: p.url ?? null, hidden: p.draft, date: p.date })),
        })),
        stylesheets: css.map((f) => f.file),
        unpublishedChanges: status.changes.map((c) => `${c.untracked ? "added" : c.status}: ${c.path}`),
        searchSettingsAvailable: overview.features.seo !== false,
      };
    }
    case "read_page":
      return capped((await readPage(key, pageFileOf(input))).content);
    case "read_site_plan": {
      const plan = await readDataFile(key, "site-tree");
      return plan.exists ? capped(plan.content) : "The site has no site plan file yet (scripts/site-tree.md).";
    }
    case "read_navigation": {
      const info = await getNavigation(key);
      return {
        navigation: info.navigation,
        appearanceSupported: info.supportsAppearance,
        supportsStyles: info.supportsStyles,
        copied: info.copied,
        collections: info.collections,
        pages: info.pages,
      };
    }
    case "read_site_details":
      return (await getStaticInfo(key)).sections;
    case "read_logo_settings": {
      const info = await getBrand(key);
      return { brand: info.brand, logoSupported: info.supported };
    }
    case "read_search_report": {
      const info = await readSeo(key);
      if (!info.available) return "This site's tools are older than the search settings. Ask the owner to press \"Update site tools\" on the Home screen first.";
      if (!info.report) return "No search check has run yet. It runs when the owner opens the Search overview screen.";
      const file = str(input, "file", { max: 300, optional: true });
      if (file) {
        const page = info.report.pages.find((p) => p.file === file);
        if (!page) return `${file} isn't in the search check (hidden pages are left out).`;
        return { ...page, checkedAt: info.report.createdAt, outOfDate: info.stale };
      }
      return {
        checkedAt: info.report.createdAt,
        outOfDate: info.stale,
        summary: info.report.summary,
        pages: info.report.pages.map((p) => ({
          file: p.file,
          address: p.url,
          title: p.title,
          score: p.score,
          ownFields: Object.fromEntries(Object.entries(p.fields).filter(([, v]) => v !== "" && v !== false)),
          searchTitle: p.seo.title,
          issues: p.issues.filter((i) => i.level === "error" || i.level === "warning").map((i) => i.message),
        })),
      };
    }
    case "read_site_problems": {
      const { report, fresh } = await readCheckReport(key);
      if (!report) return "The site hasn't been checked yet. The Publish screen checks it by itself when the owner opens it.";
      return {
        checkedAt: report.checkedAt,
        outOfDate: !fresh,
        readyToPublish: report.ok,
        buildFailed: report.buildFailed,
        failure: report.failure,
        problems: report.problems,
        moreProblems: report.moreProblems,
      };
    }
    case "read_stylesheet":
      return capped((await readCss(key, str(input, "file", { max: 300 }))).content);
    case "read_schedule":
      return await readSchedule(key);
    case "list_images":
      return await listImages(key);
    default:
      throw new ToolInputError(`Unknown tool ${name}.`);
  }
}

/* --------------------------------------------------------- change tools */

/**
 * Checks a proposed change and captures what it needs: `meta.before` (the current state, for the
 * card's before/after) and anything the apply step needs (a version to detect edits in between).
 * Returns the normalised input and meta, or throws ToolInputError for Claude to fix.
 */
async function prepareChange(name, input, key) {
  const summary = str(input, "summary", { max: 600 });
  const continueAfter = input?.continue_after === true;
  const base = { summary, continueAfter };

  switch (name) {
    case "design_header_and_footer": {
      const overview = await getOverview(key);
      if (!overview.features?.chromeDesign) {
        throw new ToolInputError("This site's tools are older than header and footer design, so it can't be done here. Tell the owner.");
      }
      return { ...base, input: { instruction: str(input, "instruction", { optional: true }) }, meta: {} };
    }
    case "edit_page": {
      const file = pageFileOf(input);
      const page = await readPage(key, file);
      return {
        ...base,
        input: { file, instruction: str(input, "instruction"), images: await imagesOf(input, key) },
        meta: { title: titleOf(page.content) ?? file },
      };
    }
    case "create_page": {
      if (!CREATE_TYPES.includes(input?.type)) throw new ToolInputError(`type must be one of ${CREATE_TYPES.join(", ")}.`);
      const title = str(input, "title", { max: 200 }).trim();
      if (title.startsWith("-") || /[\r\n]/.test(title)) throw new ToolInputError("title must be a single line that doesn't start with \"-\".");
      const brief = str(input, "brief", { optional: true });
      if (input.type === "homepage" || input.type === "listing") {
        const overview = await getOverview(key);
        let url = "/";
        let collection = null;
        if (input.type === "listing") {
          collection = str(input, "collection", { max: 60 });
          const listing = overview.collections.some((c) => c.name === collection) ? listingOf(await readSiteConfig(key), collection) : null;
          if (!listing) throw new ToolInputError(`${collection} isn't a collection with a listing page. Use a collection name from get_site_overview.`);
          url = listing.url;
        }
        const existing = overview.collections.flatMap((c) => c.pages).find((p) => p.url === url);
        if (existing) throw new ToolInputError(`The site already has ${input.type === "homepage" ? "a homepage" : "that listing page"}: ${existing.file}. Use edit_page to change it.`);
        return { ...base, input: { type: input.type, collection, title, slug: null, hidden: false, brief, images: await imagesOf(input, key) }, meta: { address: url } };
      }
      const address = str(input, "address", { max: 200, optional: true })?.trim();
      if (address) {
        if (input.type !== "page") throw new ToolInputError("address is only for type page.");
        if (!/^\/[\w\-./]*$/.test(address) || address.includes("..") || address.includes("//")) throw new ToolInputError("address must be a path on this site, like /pricing or /services/design.html.");
        const overview = await getOverview(key);
        const folder = (u) => (u.endsWith("/") || path.posix.extname(u) ? u : `${u}/`);
        const existing = overview.collections.flatMap((c) => c.pages).find((p) => p.url && folder(p.url) === folder(address));
        if (existing) throw new ToolInputError(`${existing.file} is already at ${address}. Use edit_page to change it.`);
        return { ...base, input: { type: "page", title, slug: null, address, hidden: false, brief, images: await imagesOf(input, key) }, meta: { address } };
      }
      const slug = str(input, "slug", { max: 70, optional: true });
      if (slug && !/^[a-z0-9-]+$/.test(slug)) throw new ToolInputError("slug may only use lowercase letters, numbers and dashes.");
      return { ...base, input: { type: input.type, title, slug, hidden: input?.hidden === true, brief, images: await imagesOf(input, key) }, meta: {} };
    }
    case "delete_page": {
      const file = pageFileOf(input);
      const page = await readPage(key, file);
      return { ...base, input: { file }, meta: { title: titleOf(page.content) ?? file } };
    }
    case "add_file_to_site": {
      const meta = await attachmentOf(input?.attachment, key);
      const name = str(input, "name", { max: 120, optional: true });
      const { dir, base: fileBase, extension } = sitePathFor(meta, name);
      return { ...base, input: { attachment: meta.id, name }, meta: { file: meta.name, kind: meta.kind, path: `${dir}/${fileBase}.${extension}` } };
    }
    case "convert_page_from_html": {
      const file = pageFileOf(input);
      const page = await readPage(key, file);
      const overview = await getOverview(key);
      if (!overview.features.pageConvert) throw new ToolInputError("This site's tools are too old to bring in pages. Ask the owner to update them (Build tools and log).");
      const html = await attachmentOf(input?.attachment, key);
      if (html.kind !== "text" || !/\.html?$/i.test(html.name)) throw new ToolInputError(`${html.name} isn't an .html file.`);
      const extras = Array.isArray(input?.extra_files) ? input.extra_files : [];
      if (extras.length > 20) throw new ToolInputError("Attach at most 20 stylesheets and scripts.");
      const extraMetas = [];
      for (const id of extras) {
        const meta = await attachmentOf(id, key);
        if (meta.kind !== "text" || !/\.(css|m?js)$/i.test(meta.name)) throw new ToolInputError(`${meta.name} isn't a .css or .js file.`);
        extraMetas.push(meta);
      }
      const keepStyles = input?.keep_styles !== false && overview.features.pageConvertStyles;
      return {
        ...base,
        input: { file, attachment: html.id, extraFiles: extraMetas.map((m) => m.id), keepStyles, direction: str(input, "direction", { optional: true }) },
        meta: { title: titleOf(page.content) ?? file, source: html.name, extras: extraMetas.map((m) => m.name), scripts: overview.features.pageConvertScripts },
      };
    }
    case "update_site_plan": {
      const content = str(input, "content", { max: 200_000 });
      const current = await readDataFile(key, "site-tree");
      return { ...base, input: { content }, meta: { before: current.content } };
    }
    case "create_missing_pages":
      return { ...base, input: {}, meta: {} };
    case "update_page_search_settings": {
      const file = pageFileOf(input);
      await readPage(key, file);
      if (!isPlainObject(input?.fields)) throw new ToolInputError("fields must be an object.");
      const fields = { ...input.fields };
      // An easy slip: the site's own field is focusKeyword.
      if ("focusKeyphrase" in fields) {
        if (!("focusKeyword" in fields)) fields.focusKeyword = fields.focusKeyphrase;
        delete fields.focusKeyphrase;
      }
      const unknown = Object.keys(fields).filter((f) => !SEO_FIELD_NAMES.includes(f));
      if (unknown.length) throw new ToolInputError(`Unknown fields: ${unknown.join(", ")}.`);
      for (const [field, value] of Object.entries(fields)) {
        if (field === "noindex" ? typeof value !== "boolean" : typeof value !== "string") {
          throw new ToolInputError(`${field} must be ${field === "noindex" ? "true or false" : "a string"}.`);
        }
      }
      if (!Object.keys(fields).length) throw new ToolInputError("fields is empty.");
      const report = (await readSeo(key)).report;
      const before = report?.pages.find((p) => p.file === file)?.fields ?? null;
      return { ...base, input: { file, fields }, meta: { before } };
    }
    case "write_search_text_for_all_pages":
      return {
        ...base,
        input: { direction: str(input, "direction", { max: 2000, optional: true }), force: input?.include_pages_that_have_it === true },
        meta: {},
      };
    case "update_menu_and_footer": {
      const navigation = input?.navigation;
      if (!isPlainObject(navigation) || !isPlainObject(navigation.header) || !Array.isArray(navigation.footer)) {
        throw new ToolInputError("navigation must be the complete object from read_navigation, with header and footer.");
      }
      const current = await getNavigation(key);
      return { ...base, input: { navigation }, meta: { before: current.navigation, version: current.version } };
    }
    case "update_site_details": {
      const id = str(input, "section", { max: 100 });
      const { sections } = await getStaticInfo(key);
      const section = sections.find((s) => s.id === id);
      if (!section) throw new ToolInputError(`Unknown section "${id}". Sections: ${sections.map((s) => s.id).join(", ")}.`);
      if (input?.data === undefined) throw new ToolInputError("data is required.");
      return { ...base, input: { section: id, data: input.data }, meta: { before: section.data, label: section.label, file: section.file } };
    }
    case "update_logo_settings": {
      if (!isPlainObject(input?.brand)) throw new ToolInputError("brand must be an object.");
      const brand = {};
      for (const [field, value] of Object.entries(input.brand)) {
        if (!LOGO_FIELDS.includes(field)) throw new ToolInputError(`Unknown field ${field}.`);
        if (typeof value !== "string") throw new ToolInputError(`${field} must be a string.`);
        // The site stores images as site paths; accept repo paths too.
        brand[field] = field !== "logoText" && value && !value.startsWith("/") ? `/${value}` : value;
      }
      const current = await getBrand(key);
      return { ...base, input: { brand }, meta: { before: current.brand } };
    }
    case "update_stylesheet": {
      const file = str(input, "file", { max: 300 });
      const current = await readCss(key, file);
      return { ...base, input: { file, content: str(input, "content", { max: 1_000_000 }) }, meta: { before: current.content, version: current.version } };
    }
    case "update_notes_for_claude": {
      const current = await readDataFile(key, "knowledge-notes");
      return { ...base, input: { content: str(input, "content", { max: 100_000 }) }, meta: { before: current.content } };
    }
    case "schedule_page": {
      const date = str(input, "date", { max: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) throw new ToolInputError("date must be YYYY-MM-DD.");
      return {
        ...base,
        input: {
          location: str(input, "location", { max: 200 }),
          title: str(input, "title", { max: 200 }),
          date,
          brief: str(input, "brief"),
          notes: str(input, "notes", { optional: true }),
        },
        meta: {},
      };
    }
    case "publish_changes": {
      const status = await getStatus(key);
      if (!status.changes.length && !status.ahead) throw new ToolInputError("There's nothing to publish.");
      return { ...base, input: { message: str(input, "message", { max: 500 }).trim() }, meta: { changes: status.changes.length } };
    }
    default:
      throw new ToolInputError(`Unknown tool ${name}.`);
  }
}

function titleOf(markdown) {
  const match = /^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m.exec(markdown.replace(/\r\n/g, "\n"));
  return match?.[1] ?? null;
}

/**
 * Runs one tool call. Read tools return their result; change tools return the action to show the
 * user (nothing is changed yet). Errors come back as `{ error }` for Claude to see and fix.
 */
export async function runTool(name, input, key) {
  const info = toolInfo(name);
  if (!info) return { error: `There's no tool called ${name}.` };
  if (!isPlainObject(input)) return { error: "The tool input must be an object." };
  try {
    if (info.kind === "read") {
      const result = await runRead(name, input, key);
      return { result: typeof result === "string" ? result : JSON.stringify(result) };
    }
    return { action: await prepareChange(name, input, key) };
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof WorkspaceError) return { error: err.message };
    throw err;
  }
}

/* --------------------------------------------------------------- applying */

/**
 * Applies a `runs: "server"` action the user pressed Apply on. Returns a short result for Claude
 * (and the card) as a string, or `{ result, data }` when the browser needs more (the path a file
 * was added at), or throws a WorkspaceError whose message is shown and reported back.
 */
export async function applyServerAction(key, action, { accessToken, user } = {}) {
  const { input, meta } = action;
  switch (action.tool) {
    case "delete_page":
      await deletePage(key, input.file);
      return `Removed ${input.file}.`;
    case "add_file_to_site": {
      const added = await addAttachmentToSite(key, input.attachment, input.name);
      return { result: `Added it to the site as ${added} (published at /${added}).`, data: { path: added } };
    }
    case "update_site_plan":
      await writeDataFile(key, "site-tree", input.content);
      return "Saved the new site plan.";
    case "update_menu_and_footer":
      await saveNavigation(key, input.navigation, meta.version);
      return "Saved the menu and footer.";
    case "update_site_details":
      await saveStaticInfo(key, input.section, input.data);
      return `Saved ${meta.label ?? input.section}.`;
    case "update_logo_settings":
      await saveBrand(key, input.brand);
      return "Saved the logo settings.";
    case "update_stylesheet":
      await saveCss(key, input.file, input.content, meta.version);
      return `Saved ${input.file}.`;
    case "update_notes_for_claude":
      await writeDataFile(key, "knowledge-notes", input.content);
      return "Saved Claude's notes.";
    case "schedule_page": {
      const schedule = await readSchedule(key);
      if (schedule.error && schedule.jobs.length === 0 && !schedule.error.includes("doesn't exist")) throw new WorkspaceError(schedule.error, 409);
      const job = { location: input.location, title: input.title, date: input.date, description: input.brief };
      if (input.notes) job.content = input.notes;
      await writeSchedule(key, [...schedule.jobs, job]);
      return `Scheduled "${input.title}" for ${input.date}.`;
    }
    case "publish_changes": {
      if (!accessToken) throw new WorkspaceError("Publishing needs GitHub. Reconnect it and try again.", 401);
      const result = await commitAndPush({ key, accessToken, user, message: input.message, mode: "direct" });
      return `Published to ${result.branch}. The live site updates in about a minute.`;
    }
    default:
      throw new WorkspaceError("This change is applied from the editor, not the server.", 400);
  }
}
