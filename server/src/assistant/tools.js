import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { addAttachmentToSite, attachmentBlock, attachmentText, ensureUploaded, readAttachment, readAttachmentMeta, saveMadeImage, sitePathFor } from "./attachments.js";
import { SCREENS, describeView, viewPage } from "./view-page.js";
import { appended, describePlan, outlineOf, planBlocks } from "./copy-blocks.js";
import { analyticsSummary } from "../analytics.js";
import { getBrand, saveBrand } from "../brand.js";
import { normalizeLink, pageForLink } from "../links.js";
import { getNavigation, saveNavigation } from "../navigation.js";
import { makePdf, pdfProblem } from "../documents.js";
import { aiFileAt, checkMove, checkRepoPlacement, checkRepoTextWrite, cleanFileName, fileUsage, listSiteFiles, moveSiteFile, readRepoText, removeSiteFile, saveRepoFile, searchSiteText, writeRepoText, writeRepoTexts } from "../repo-files.js";
import { readSeo } from "../seo.js";
import { DRAWN_DIR, MAX_SVG_CHARS, checkSvg, drawnName, saveDrawnImage, svgAspect, svgPreview } from "../svg.js";
import { ImageError, MAX_PROMPT_CHARS, QUALITIES, SHAPES, generateImage } from "../images.js";
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
  readScripts,
  readSiteConfig,
  saveCss,
  saveScripts,
  setPageDraft,
  checkScripts,
  writeDataFile,
  writeSchedule,
} from "../site-files.js";
import { readCheckReport } from "../site-check.js";
import { checkStaticInfo, getStaticInfo, saveStaticInfo } from "../static-info.js";
import { WorkspaceError, commitAndPush, discardChanges, getStatus, siteIdFor, workspaceDir } from "../workspace.js";
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
// Each "Add a page" type's collection, and how the site names its file (scripts/new.js's TYPES and slugify).
const NEW_PAGE_COLLECTIONS = { page: "pages", product: "products", service: "services", post: "blog", case: "caseStudies" };
const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
const MAX_READ_CHARS = 80_000;
const MAX_LISTED_FILES = 300;
const SEO_FIELD_NAMES = ["metaTitle", "metaDescription", "focusKeyword", "ogImage", "ogImageAlt", "canonical", "noindex"];
const LOGO_FIELDS = ["logoText", "logo", "logoDark", "logoMark", "favicon"];
// The logo settings a drawn image can be used as (create_image's use_as).
const LOGO_IMAGE_FIELDS = LOGO_FIELDS.filter((f) => f !== "logoText");
const ATTACHMENT_ID = /^att_[a-f0-9]{16}$/;
const MAX_IMAGES = 6;
// Where pictures made by the image model (create_image with a prompt) go in the site.
const GENERATED_DIR = "assets/img/generated";

/** Whether an image's width over height is close enough to square for a mark or favicon. */
const isSquare = (aspect) => Boolean(aspect) && aspect >= 0.8 && aspect <= 1.25;

// The shared fields are explained once in the system prompt (HOW YOU WORK in prompt.js): every
// word here is repeated on each change tool in every request.
const imagesField = {
  images: { type: "array", items: { type: "string" }, description: "Up to 6: att_… ids (added with add_file_to_site first), assets/img/… paths or https URLs." },
};

const summaryField = { summary: { type: "string", description: "The owner's card text." } };
// Which model writes it: small work goes to a faster, cheaper writer, complex work to Claude
// (task-size.js; the label wins over the app's own rules, since only you know the conversation).
const TASK_SIZES = ["small", "complex"];
const taskSizeField = { task_size: { type: "string", enum: TASK_SIZES } };
const designReferenceField = {
  design_reference: {
    type: "array",
    items: { type: "string" },
    description:
      "Up to 2 att_… ids of attached screenshots or mockups of the design the owner wants this page to have. The writer sees them and replicates their layout, colours, type and details exactly; they're never put on the page. Use this, not images, whenever the owner wants a page to look like a picture they attached.",
  },
};
const continueField = { continue_after: { type: "boolean" } };

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
    "read_analytics",
    "How many people visit the published site and what they do, from the site's own visit counter (no cookies; a visitor is one person on one day): visitors and page views against the period before, the most viewed pages and the pages people arrive on, where visitors come from (search engines, social sites, campaigns), devices, missing pages visitors tried to open (404s) and clicks on phone, email, WhatsApp and outside links. Only the site's creator can see it. Use it to suggest what to improve first, for example making a missing page people look for, or improving a busy page few people stay on.",
    { days: { type: "integer", enum: [1, 7, 30, 90, 365], description: "Optional: how many days back, 1 for today (default 30)." } },
    [],
    { kind: "read", activity: () => "Checking your site's visits" },
  ),
  tool(
    "read_site_problems",
    "What the last check before publishing found: the check the live site runs before it updates, so while any problem is left, publishing doesn't change the live site. Each problem has a kind: missing-link (page links to href, which isn't in the published site; target home means the site has no homepage, listing that a collection has no listing page yet (listing names it), hidden a hidden page, page no such page, file no such image or file; inPageText false means the link comes from the site's design, such as the logo, menu, footer or a layout), duplicate (two pages at one address), no-date (a blog post without a date) or other. buildFailed means the site couldn't be built at all (failure has the error). outOfDate means the site changed since; the What's changed screen checks again by itself.",
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
  tool(
    "list_files",
    "The site's files: each one's path, size, whether you can change it (canChange), and the address it's published at under assets and static (static is published at the site's root). The site's own tools (scripts, templates) are only listed when named as the folder.",
    { folder: { type: "string", description: "Optional: only this folder, e.g. static, assets/files or templates." } },
    [],
    { kind: "read", activity: () => "Looking at your files" },
  ),
  tool(
    "read_file",
    "The text of any file from list_files (site.config.json, robots.txt, a layout, a CSV…), to see exactly how something is done before changing it. A file that isn't text, such as a PDF or a photo, can't be read this way.",
    { file: { type: "string", description: "e.g. static/robots.txt" } },
    ["file"],
    { kind: "read", activity: (input) => `Reading ${input.file ?? "a file"}` },
  ),
  tool(
    "view_page",
    "A picture of a page as visitors see it (hidden pages too), with its scripts off, plus whether it's too wide for the screen and which images didn't load. Shows the site as it is now: a change you proposed in this reply isn't in it yet. Costs the owner a little, so use one screen when one will do.",
    {
      page: { type: "string", description: "A file from get_site_overview or an address like /about.html." },
      screen: { type: "string", enum: ["phone", "computer", "both"], description: "Default both." },
      from_y: { type: "integer", description: "Where to start on a long page, from the last result." },
    },
    ["page"],
    { kind: "read", activity: (input) => `Looking at ${input.page ?? "a page"}`, working: () => "Looking at your page" },
  ),
  tool(
    "search_site",
    "Finds where some exact text appears across the site's pages, settings and other text files, ignoring case: each hit as file:line: the text around it, up to 5 per file and 50 in all, with the totals. Use it instead of reading files one by one.",
    {
      text: { type: "string", description: "A phone number, price, name, link…" },
      folder: { type: "string", description: "Optional: only this folder, e.g. content/blog." },
    },
    ["text"],
    { kind: "read", activity: (input) => (input.text ? `Searching your site for "${input.text}"` : "Searching your site") },
  ),
  tool(
    "read_attachment",
    "A text or Word attachment, a part at a time. With only attachment: its outline (headings with line numbers, how many code blocks). With from_line: those lines. With search: the lines containing that text. Read only what you need.",
    {
      attachment: { type: "string", description: "att_…" },
      from_line: { type: "integer" },
      lines: { type: "integer", description: "How many, up to 200 (default 60)." },
      search: { type: "string" },
    },
    ["attachment"],
    { kind: "read", activity: () => "Reading your attachment" },
  ),

  // ---------------------------------------------------------------- change
  tool(
    "edit_page",
    "Proposes changing one existing page's wording or layout; the writer rewrites it from your self-contained instruction.",
    {
      file: { type: "string", description: "e.g. content/pages/about.md" },
      instruction: { type: "string", description: "Up to 4000 characters." },
      ...imagesField,
      ...designReferenceField,
      ...taskSizeField,
      ...summaryField,
      ...continueField,
    },
    ["file", "instruction", "task_size", "summary"],
    { kind: "change", runs: "client", title: "Change a page" },
  ),
  tool(
    "create_page",
    "Proposes adding a new page; with a brief the writer writes it, without one it starts empty. Types: page (About, Contact…), post (dated article), service, product, case (case study), homepage (only when the site has none), listing (a collection's page listing its pages, e.g. Blog; give collection). slug and hidden don't apply to homepage and listing.",
    {
      type: { type: "string", enum: CREATE_TYPES },
      collection: { type: "string", description: "For listing: a collection name from get_site_overview." },
      title: { type: "string" },
      slug: { type: "string", description: "Optional: lowercase letters, numbers, dashes. Default: from the title." },
      address: { type: "string", description: "For page only: the exact address a link already points to (e.g. /pricing). Overrides slug." },
      hidden: { type: "boolean", description: "Off the published site until unhidden." },
      brief: { type: "string", description: "Optional, self-contained, up to 4000 characters." },
      ...imagesField,
      ...designReferenceField,
      ...taskSizeField,
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
    "Proposes adding an attached file to the site: images go with the site's photos, any other file to /assets/files/<name>; folder puts it somewhere else under assets or static, or, with replace, over a file already there.",
    {
      attachment: { type: "string", description: "att_…" },
      name: { type: "string", description: "Optional, e.g. summer-menu.pdf." },
      folder: { type: "string", description: "Optional, e.g. static or assets/files/menus. Leave out for a photo going on a page." },
      replace: { type: "boolean", description: "With folder: overwrite the file of that name." },
      ...summaryField,
      ...continueField,
    },
    ["attachment", "summary"],
    { kind: "change", runs: "server", title: "Add a file to the site" },
  ),
  tool(
    "write_file",
    "Proposes adding a text file, or replacing all of one (read_file first; edit_file for part of one). Open to anything canChange says: assets, static, content, styles, site.config.json, notes.",
    {
      file: { type: "string", description: "e.g. static/robots.txt or assets/files/prices.csv." },
      content: { type: "string", description: "The complete new file." },
      ...summaryField,
      ...continueField,
    },
    ["file", "content", "summary"],
    { kind: "change", runs: "server", title: "Save a file" },
  ),
  tool(
    "edit_file",
    "Proposes exact replacements in any text file that canChange, including a page's own file: the quick and free way to change a word, price, link, colour or setting (a page's title, address or description) when you know exactly what changes. read_file or read_page first. append adds text at the very end, with no need to read the file.",
    {
      file: { type: "string" },
      append: { type: "string", description: "Text to add after everything in the file." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            find: { type: "string", description: "The exact text, long enough to appear only once." },
            replace: { type: "string" },
            all: { type: "boolean", description: "Replace every place it appears." },
          },
          required: ["find", "replace"],
          additionalProperties: false,
        },
      },
      ...summaryField,
      ...continueField,
    },
    ["file", "summary"],
    { kind: "change", runs: "server", title: "Change a file" },
  ),
  tool(
    "append_blocks_from_attachment",
    "Proposes adding code blocks from a text attachment to the end of many site files, copied exactly by the app, so you never retype them. It uses every fenced code block with a site file named just before it (in a heading or line). Pass the ids and rules only. The result says how many are ready, already done or can't be added.",
    {
      attachment: { type: "string", description: "att_…" },
      section: { type: "string", description: "Only blocks under the first heading containing this, e.g. Part B." },
      skip_if_contains: { type: "string", description: "A file already containing this is left alone, e.g. an id the blocks carry." },
      corrections: {
        type: "array",
        description: "Only for fixes the owner agreed to: exact text to change in one file's block.",
        items: {
          type: "object",
          properties: { file: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
          required: ["file", "find", "replace"],
          additionalProperties: false,
        },
      },
      ...summaryField,
      ...continueField,
    },
    ["attachment", "summary"],
    { kind: "change", runs: "server", title: "Add to many files" },
  ),
  tool(
    "move_file",
    "Proposes renaming or moving a file, which keeps its kind. A page's address doesn't change when its file moves: that's its url setting (edit_file). Refused while the site uses the old address, unless fix_links_next.",
    {
      file: { type: "string" },
      to: { type: "string", description: "The new path, e.g. assets/files/summer-menu.pdf." },
      fix_links_next: { type: "boolean", description: "You'll point what uses it at the new address straight after (with continue_after)." },
      ...summaryField,
      ...continueField,
    },
    ["file", "to", "summary"],
    { kind: "change", runs: "server", title: "Rename a file" },
  ),
  tool(
    "create_pdf",
    "Proposes a PDF made from your text (a price list, menu or guide to download), saved under assets or static. Link to it from a page or the menu if the owner wants it found. Western letters only.",
    {
      file: { type: "string", description: "e.g. assets/files/price-list.pdf." },
      title: { type: "string" },
      content: { type: "string", description: "Markdown: # and ## headings, - lists, paragraphs." },
      replace: { type: "boolean", description: "Overwrite the file of that name." },
      ...summaryField,
      ...continueField,
    },
    ["file", "title", "content", "summary"],
    { kind: "change", runs: "server", title: "Create a PDF" },
  ),
  tool(
    "set_page_hidden",
    "Proposes hiding a page from the published site without deleting it, or showing it again. Not the homepage.",
    { file: { type: "string" }, hidden: { type: "boolean" }, ...summaryField, ...continueField },
    ["file", "hidden", "summary"],
    { kind: "change", runs: "server", title: "Hide or show a page" },
  ),
  tool(
    "update_site_scripts",
    "Proposes the complete new list of code from other services on the published site (Google Analytics, a tracking pixel, a chat widget, a verification tag). read_file content/data/scripts.json first and keep the items that are there. code starts and ends with a tag; pages is \"all\" or a list of addresses.",
    {
      scripts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            code: { type: "string" },
            place: { type: "string", enum: ["head", "body"] },
            pages: { anyOf: [{ type: "string", enum: ["all"] }, { type: "array", items: { type: "string" } }] },
            on: { type: "boolean" },
          },
          required: ["name", "code", "place", "pages", "on"],
          additionalProperties: false,
        },
      },
      ...summaryField,
      ...continueField,
    },
    ["scripts", "summary"],
    { kind: "change", runs: "server", title: "Change the site's scripts" },
  ),
  tool(
    "undo_changes",
    "Proposes putting changed files back as they were last published, throwing away those unpublished changes for good (the owner is always asked first). get_site_overview's unpublishedChanges lists them. It can't go back to a version that was never published.",
    { files: { type: "array", items: { type: "string" }, description: "The paths to put back." }, ...summaryField },
    ["files", "summary"],
    { kind: "change", runs: "server", title: "Undo changes" },
  ),
  tool(
    "remove_file",
    "Proposes removing a file from list_files. Refused while the site still uses it, because a link or image pointing at a missing file stops publishing.",
    {
      file: { type: "string" },
      remove_anyway: { type: "boolean", description: "Remove it even though the site uses it, only when the owner knows and still wants it gone." },
      ...summaryField,
      ...continueField,
    },
    ["file", "summary"],
    { kind: "change", runs: "server", title: "Remove a file" },
  ),
  tool(
    "convert_page_from_html",
    "Proposes replacing an existing page with an attached .html page from an old website, without its old header, menu and footer. For a new page, create_page first (continue_after).",
    {
      file: { type: "string", description: "The page it becomes." },
      attachment: { type: "string", description: "The .html att_… id." },
      extra_files: { type: "array", items: { type: "string" }, description: "Optional: its .css and .js att_… ids." },
      keep_styles: { type: "boolean", description: "Keep its own look (default); false rewrites it in the site's design." },
      direction: { type: "string", description: "Optional guidance." },
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
    "check_site",
    "Runs the check the live site runs before it updates, once the changes before it in this reply are made. You then carry on by yourself and are told the result.",
    summaryField,
    ["summary"],
    { kind: "change", runs: "client", title: "Check the site" },
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
          metaTitle: { type: "string" },
          metaDescription: { type: "string" },
          focusKeyword: { type: "string" },
          ogImage: { type: "string", description: "Social image: /assets/img/… or an https URL." },
          ogImageAlt: { type: "string" },
          canonical: { type: "string", description: "Only when another address has the same content." },
          noindex: { type: "boolean", description: "Hide from search engines." },
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
    "Proposes the complete new navigation object (read_navigation first, change only what's asked, keep every other field and item as it is). Links start with /, #, mailto:, tel: or https://. A header item is a link ({label, url}), a dropdown ({label, children: [links]}) or a collection menu ({label, type: \"collection\", collection, limit}). appearance.header: theme light|dark|brand, layout right|center|left, sticky, style bar|floating, transparent (see-through over the top of the page until scrolled), shrink (lower once scrolled). appearance.footer: theme dark|light|brand, layout columns|centered|minimal, showTagline, showContact, showSocial (icons for the social links in Business info), cta {title, text, label, url} (a call-to-action strip above the footer; null for none), copyright. When read_navigation says supportsStyles is false the site's templates predate style, transparent, shrink, layout, showSocial and cta; when copied says a header or footer was copied from a page, the menu and appearance don't change it.",
    { navigation: { type: "object", description: "The full navigation: header {items, cta}, footer [columns], legal [links], appearance." }, ...summaryField, ...continueField },
    ["navigation", "summary"],
    { kind: "change", runs: "server", title: "Change the menu and footer" },
  ),
  tool(
    "design_header_and_footer",
    "Proposes a new look for the header and footer together (their links, logo and copyright stay as they are).",
    {
      instruction: { type: "string", description: "Optional: the look wanted, self-contained. Leave out to match the site's pages." },
      ...taskSizeField,
      ...summaryField,
      ...continueField,
    },
    ["summary"],
    { kind: "change", runs: "client", title: "Design the header and footer" },
  ),
  tool(
    "update_site_details",
    "Proposes new data for one site-details section (read_site_details first). Send the section's complete data with the same fields and types; only change the values asked for.",
    {
      section: { type: "string", description: "The section id." },
      // Typed, so the data comes as JSON itself rather than as a string of JSON. Most sections are
      // objects; redirects is a list.
      data: { anyOf: [{ type: "object" }, { type: "array" }], description: "JSON, not a string." },
      ...summaryField,
      ...continueField,
    },
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
    "create_image",
    "Proposes an image for the site, saved with its images: either svg, one you draw (a logo, icon, badge, divider or simple illustration), or prompt, a picture an image model makes (a photo or detailed illustration; it costs the owner credits). use_as also makes it the logo: logo, logoDark (on the dark footer), logoMark (the small square mark beside the name) or favicon (the browser-tab icon). A new logo (use_as logo) must come with mark_svg.",
    {
      svg: { type: "string", description: "One complete <svg> with a viewBox: shapes, text, gradients, patterns, clips, masks and filters only." },
      prompt: { type: "string", description: "Instead of svg: the picture in detail (subject, setting, style, light, colours from the site's look). No text in it unless asked." },
      shape: { type: "string", enum: SHAPES, description: "With prompt. wide is a banner (16:9). Default landscape." },
      quality: { type: "string", enum: QUALITIES, description: "With prompt. high costs about three times medium; low is for drafts. Default medium." },
      transparent: { type: "boolean", description: "With prompt: a transparent background (a cut-out or icon)." },
      name: { type: "string", description: "Short file name, e.g. logo or logo-mark." },
      use_as: { type: "array", items: { type: "string", enum: LOGO_IMAGE_FIELDS } },
      mark_svg: { type: "string", description: "With use_as logo: a square version in the same style (an initial or emblem, readable at 16px, square viewBox) that becomes the small mark and the browser-tab icon." },
      ...summaryField,
      ...continueField,
    },
    ["name", "summary"],
    // The picture is made when proposed, so the card shows it.
    { kind: "change", runs: "server", title: "Create an image", working: (input) => (input?.prompt ? "Making the picture" : null) },
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
  // ------------------------------------------------------------------ talk
  tool(
    "offer_choices",
    "Ends your reply with a question for the owner or with next steps; buttons tap to send their text as the owner's message (they can still type their own). kind question: anything you need from the owner before you can go on, shown to them in the middle of the screen; give 2 to 4 likely answers for a decision, or no choices for a fact only they know (a phone number, prices); end your reply after it. kind next: 2 or 3 next steps.",
    {
      kind: { type: "string", enum: ["question", "next"] },
      question: { type: "string", description: "kind question: the question, in one short sentence." },
      choices: { type: "array", items: { type: "string" }, description: "2 to 4, each a few words in the owner's voice, e.g. \"Warm and rustic\" or \"Write the Blog page\". kind question may give none, for a fact they type." },
    },
    ["kind", "choices"],
    { kind: "talk" },
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

/**
 * The attached screenshots of a design to copy ({ references: [att_…] }, or nothing), checked to be
 * images; refused on a site whose page writer predates edit-page.js --reference.
 */
async function referencesOf(input, key) {
  const list = input?.design_reference;
  if (list === undefined || list === null || (Array.isArray(list) && !list.length)) return {};
  if (!Array.isArray(list) || list.length > 2) throw new ToolInputError("design_reference must be a list of at most 2 attachment ids.");
  const script = await readFile(path.join(workspaceDir(key), "scripts", "edit-page.js"), "utf8").catch(() => "");
  if (!script.includes("--reference=")) {
    throw new ToolInputError(
      "This site's page writer can't look at a design picture yet: it needs the latest site update, which the editor offers. Tell the owner that, and offer to describe the design in words meanwhile.",
    );
  }
  const references = [];
  for (const raw of list) {
    const meta = await attachmentOf(typeof raw === "string" ? raw.trim() : raw, key);
    if (meta.kind !== "image") throw new ToolInputError(`${meta.id} (${meta.name}) isn't an image Claude can look at.`);
    references.push(meta.id);
  }
  return { references };
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

/**
 * The header and footer links (menu items, dropdowns, the button, footer columns, legal links, the
 * footer's call to action) that the proposal adds or changes and that point at a page the site
 * doesn't have, or at a hidden one, as lines for Claude. Links already there are left alone: the
 * site leaves menu links to pages it doesn't have out of what it publishes. "/about" counts as
 * /about.html (links.js's pageForLink); files (/rss.xml, /assets/…) and outside, mail and phone
 * links aren't checked here.
 */
function navigationLinks(navigation) {
  const links = [];
  const add = (item, where) => isPlainObject(item) && typeof item.url === "string" && item.url.trim() && links.push([normalizeLink(item.url), `${where} "${item.label ?? ""}"`]);
  for (const item of Array.isArray(navigation?.header?.items) ? navigation.header.items : []) {
    add(item, "Menu item");
    for (const child of Array.isArray(item?.children) ? item.children : []) add(child, "Dropdown link");
  }
  add(navigation?.header?.cta, "Header button");
  for (const column of Array.isArray(navigation?.footer) ? navigation.footer : []) for (const item of Array.isArray(column?.links) ? column.links : []) add(item, "Footer link");
  for (const item of Array.isArray(navigation?.legal) ? navigation.legal : []) add(item, "Legal link");
  add(navigation?.appearance?.footer?.cta, "Footer call-to-action button");
  return links;
}

function navigationLinkProblems(navigation, pages, before) {
  const existing = new Set(navigationLinks(before).map(([url]) => url));
  const problems = [];
  for (const [url, where] of navigationLinks(navigation)) {
    if (existing.has(url) || !url.startsWith("/") || url.startsWith("//")) continue;
    // Pages only: an address with an extension other than .html is a file.
    const file = url.split(/[#?]/)[0].split("/").pop() ?? "";
    if (/\.[a-z0-9]+$/i.test(file) && !/\.html$/i.test(file)) continue;
    const page = pageForLink(url, pages);
    if (!page) problems.push(`${where} links to ${url}, which isn't a page on the site.`);
    else if (page.draft) problems.push(`${where} links to ${url}, a hidden page visitors can't open.`);
  }
  return problems;
}

function capped(text) {
  return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n[…cut off: ${text.length - MAX_READ_CHARS} more characters]` : text;
}

/* ----------------------------------------------------------- read tools */

const MAX_OUTLINE_HEADINGS = 200;
const MAX_MATCHES = 30;
const MAX_LINE_CHARS = 1_500;
const MAX_PART_CHARS = 30_000;

/**
 * Claude's view of a page, as content blocks. Pictures go through the Files API like attachments:
 * the history keeps a short id rather than the image, and the conversation's files clean up with it.
 */
async function viewPageBlocks(input, key, context) {
  const page = str(input, "page", { max: 300 });
  let url = page;
  if (PAGE_FILE.test(page)) {
    const found = (await getOverview(key)).collections.flatMap((c) => c.pages).find((p) => p.file === page);
    if (!found?.url) throw new ToolInputError(`${page} isn't a page with an address. See get_site_overview.`);
    url = found.url;
  }
  if (!url.startsWith("/") || url.startsWith("//") || url.split(/[?#]/)[0].split("/").includes("..")) throw new ToolInputError(`"${page}" isn't a page file or an address starting with /.`);
  const choice = input.screen ?? "both";
  if (choice !== "both" && !Object.hasOwn(SCREENS, choice)) throw new ToolInputError("screen must be phone, computer or both.");
  const screens = choice === "both" ? [SCREENS.phone, SCREENS.computer] : [SCREENS[choice]];
  if (!context.client) throw new ToolInputError("Pages can't be looked at here.");
  const blocks = [];
  for (const view of await viewPage(key, url.split(/[?#]/)[0], screens, Math.trunc(Number(input.from_y)) || 0)) {
    let uploaded;
    try {
      const made = await saveMadeImage(key, { name: "page-view.jpg", bytes: view.bytes });
      uploaded = await ensureUploaded(context.client, key, made);
    } catch (err) {
      throw new ToolInputError(`The picture of the page couldn't be sent: ${err.message}`);
    }
    context.madeFiles?.push(uploaded.id);
    blocks.push({ type: "text", text: describeView(view) }, attachmentBlock(uploaded));
  }
  return { blocks };
}

/** A part of a long attachment. A very long line is cut around what was searched for, or at its start. */
async function readAttachmentPart(input, key) {
  const meta = await attachmentOf(input.attachment, key);
  const text = await attachmentText(key, meta);
  const lines = text.split(/\r?\n/);
  const clip = (line, at = 0) => {
    if (line.length <= MAX_LINE_CHARS) return line;
    const start = Math.max(0, at - 200);
    return `${start ? "…" : ""}${line.slice(start, start + MAX_LINE_CHARS)}${start + MAX_LINE_CHARS < line.length ? `…[${line.length} characters in all]` : ""}`;
  };
  const search = str(input, "search", { max: 300, optional: true });
  if (search) {
    const needle = search.toLowerCase();
    const found = lines.flatMap((line, i) => {
      const at = line.toLowerCase().indexOf(needle);
      return at < 0 ? [] : [`${i + 1}: ${clip(line, at)}`];
    });
    return { matches: found.length, lines: found.slice(0, MAX_MATCHES) };
  }
  if (input.from_line !== undefined && input.from_line !== null) {
    const from = Math.max(1, Math.trunc(Number(input.from_line)) || 1);
    const count = Math.min(200, Math.max(1, Math.trunc(Number(input.lines)) || 60));
    let part = lines.slice(from - 1, from - 1 + count).map((line, i) => `${from + i}: ${clip(line)}`).join("\n");
    if (part.length > MAX_PART_CHARS) part = `${part.slice(0, MAX_PART_CHARS)}\n[…cut off: ask for fewer lines]`;
    return `${part}\n[${lines.length} lines in all]`;
  }
  const items = outlineOf(text);
  const headings = items.filter((item) => item.type === "heading");
  return {
    name: meta.name,
    lines: lines.length,
    codeBlocks: items.filter((item) => item.type === "block").length,
    headings: headings.slice(0, MAX_OUTLINE_HEADINGS).map((h) => `${h.line}: ${"#".repeat(h.level)} ${h.text}`),
    moreHeadings: Math.max(0, headings.length - MAX_OUTLINE_HEADINGS),
  };
}

async function runRead(name, input, key, context) {
  switch (name) {
    case "read_analytics": {
      const siteId = await siteIdFor(key).catch(() => null);
      if (typeof siteId !== "number" || !context.userId) return "Visit numbers aren't available for this site.";
      try {
        return await analyticsSummary({ siteId, userId: context.userId, days: Number(input.days) || 30 });
      } catch (err) {
        if (err instanceof WorkspaceError && err.status === 404) return "Only the person who created this site can see its visit numbers.";
        throw err;
      }
    }
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
      if (!info.available) return "This site's tools are older than the search settings. Ask the owner to press \"Update site tools\" on the Edit site screen first.";
      if (!info.report) return "No search check has run yet. It runs when the owner opens the Google & sharing screen (under More tools).";
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
      if (!report) return "The site hasn't been checked yet. The What's changed screen checks it by itself when the owner opens it.";
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
    case "list_files": {
      const files = await listSiteFiles(key, str(input, "folder", { max: 300, optional: true })?.replace(/^\/+|\/+$/g, "") || null);
      return { files: files.slice(0, MAX_LISTED_FILES), moreFiles: Math.max(0, files.length - MAX_LISTED_FILES) };
    }
    case "read_file": {
      const current = await readRepoText(key, str(input, "file", { max: 300 }));
      if (!current.exists) throw new ToolInputError(`${current.file} isn't there. See list_files.`);
      return capped(current.content);
    }
    case "view_page":
      return viewPageBlocks(input, key, context);
    case "search_site": {
      const text = str(input, "text", { max: 300 }).trim();
      if (text.length < 2) throw new ToolInputError("Search for at least 2 characters.");
      return await searchSiteText(key, text, str(input, "folder", { max: 300, optional: true })?.replace(/^\/+|\/+$/g, "") || null);
    }
    case "read_attachment":
      return readAttachmentPart(input, key);
    default:
      throw new ToolInputError(`Unknown tool ${name}.`);
  }
}

/* --------------------------------------------------------- change tools */

function blockOptions(input) {
  const list = input.corrections ?? [];
  if (!Array.isArray(list) || list.length > 100) throw new ToolInputError("corrections must be a list of at most 100.");
  const corrections = list.map((c) => ({ file: str(c, "file", { max: 300 }), find: str(c, "find", { max: 4000 }), replace: typeof c?.replace === "string" ? c.replace : "" }));
  return { section: str(input, "section", { max: 200, optional: true }), skipIfContains: str(input, "skip_if_contains", { max: 300, optional: true }), corrections };
}

/**
 * Checks a proposed change and captures what it needs: `meta.before` (the current state, for the
 * card's before/after) and anything the apply step needs (a version to detect edits in between).
 * Returns the normalised input and meta, or throws ToolInputError for Claude to fix.
 */
async function prepareChange(name, input, key, context) {
  const summary = str(input, "summary", { max: 600 });
  const continueAfter = input?.continue_after === true;
  const base = { summary, continueAfter };
  // The assistant's own label for how big a writing job is (taskSizeField); anything else is unlabelled.
  const taskSize = TASK_SIZES.includes(input?.task_size) ? input.task_size : null;

  switch (name) {
    case "design_header_and_footer": {
      const overview = await getOverview(key);
      if (!overview.features?.chromeDesign) {
        throw new ToolInputError("This site's tools are older than header and footer design, so it can't be done here. Tell the owner.");
      }
      return { ...base, input: { instruction: str(input, "instruction", { optional: true }), taskSize }, meta: {} };
    }
    case "edit_page": {
      const file = pageFileOf(input);
      // A design to copy is the hardest page work: it always goes to Claude.
      const designs = await referencesOf(input, key);
      const page = await readPage(key, file);
      return {
        ...base,
        input: { file, instruction: str(input, "instruction"), images: await imagesOf(input, key), ...designs, taskSize: designs.references ? "complex" : taskSize },
        meta: { title: titleOf(page.content) ?? file },
      };
    }
    case "create_page": {
      if (!CREATE_TYPES.includes(input?.type)) throw new ToolInputError(`type must be one of ${CREATE_TYPES.join(", ")}.`);
      const title = str(input, "title", { max: 200 }).trim();
      if (title.startsWith("-") || /[\r\n]/.test(title)) throw new ToolInputError("title must be a single line that doesn't start with \"-\".");
      const brief = str(input, "brief", { optional: true });
      const designs = await referencesOf(input, key);
      if (designs.references && !brief) throw new ToolInputError("design_reference needs a brief: the writer writes the page in that design.");
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
        return { ...base, input: { type: input.type, collection, title, slug: null, hidden: false, brief, images: await imagesOf(input, key), ...designs, taskSize: designs.references ? "complex" : taskSize }, meta: { address: url } };
      }
      const address = str(input, "address", { max: 200, optional: true })?.trim();
      if (address) {
        if (input.type !== "page") throw new ToolInputError("address is only for type page.");
        if (!/^\/[\w\-./]*$/.test(address) || address.includes("..") || address.includes("//")) throw new ToolInputError("address must be a path on this site, like /pricing or /services/design.html.");
        const overview = await getOverview(key);
        const folder = (u) => (u.endsWith("/") || path.posix.extname(u) ? u : `${u}/`);
        const existing = overview.collections.flatMap((c) => c.pages).find((p) => p.url && folder(p.url) === folder(address));
        if (existing) throw new ToolInputError(`${existing.file} is already at ${address}. Use edit_page to change it.`);
        return { ...base, input: { type: "page", title, slug: null, address, hidden: false, brief, images: await imagesOf(input, key), ...designs, taskSize: designs.references ? "complex" : taskSize }, meta: { address } };
      }
      const slug = str(input, "slug", { max: 70, optional: true });
      if (slug && !/^[a-z0-9-]+$/.test(slug)) throw new ToolInputError("slug may only use lowercase letters, numbers and dashes.");
      // The file "Add a page" would make (scripts/new.js: <collection dir>/<slug>.md) is already there,
      // say from create_missing_pages, whose result was lost: write that page instead of failing later.
      const collectionDir = (await readSiteConfig(key)).collections?.[NEW_PAGE_COLLECTIONS[input.type]]?.dir;
      const newSlug = slug || slugify(title);
      if (input.type !== "post" && typeof collectionDir === "string" && newSlug) {
        const file = `${collectionDir}/${newSlug}.md`;
        if (existsSync(path.join(workspaceDir(key), file))) throw new ToolInputError(`${file} already exists. Write it with edit_page (file ${file}) instead of creating it again.`);
      }
      return { ...base, input: { type: input.type, title, slug, hidden: input?.hidden === true, brief, images: await imagesOf(input, key), ...designs, taskSize: designs.references ? "complex" : taskSize }, meta: {} };
    }
    case "delete_page": {
      const file = pageFileOf(input);
      const page = await readPage(key, file);
      return { ...base, input: { file }, meta: { title: titleOf(page.content) ?? file } };
    }
    case "add_file_to_site": {
      const meta = await attachmentOf(input?.attachment, key);
      const name = str(input, "name", { max: 120, optional: true });
      const folder = str(input, "folder", { max: 300, optional: true })?.replace(/^\/+|\/+$/g, "");
      if (folder) {
        const fileName = cleanFileName(name || meta.name);
        if (!fileName) throw new ToolInputError("That file has no usable name: give one in name.");
        const { rel, exists } = await checkRepoPlacement(key, folder, fileName);
        if (exists && input.replace !== true) throw new ToolInputError(`${rel} is already there. Set replace only if the owner wants it replaced, or use another name.`);
        return { ...base, input: { attachment: meta.id, name: fileName, folder, replace: input.replace === true }, meta: { file: meta.name, kind: meta.kind, path: rel, replaces: exists } };
      }
      if (input?.replace === true) throw new ToolInputError("replace needs folder: the folder of the file it replaces.");
      const { dir, base: fileBase, extension } = sitePathFor(meta, name);
      return { ...base, input: { attachment: meta.id, name }, meta: { file: meta.name, kind: meta.kind, path: `${dir}/${fileBase}.${extension}` } };
    }
    case "write_file": {
      const file = str(input, "file", { max: 300 });
      const content = str(input, "content", { max: MAX_READ_CHARS });
      const current = await checkRepoTextWrite(key, file, content);
      // read_file cuts a longer file off, so its complete new text can't be written from what was read.
      if (current.content.length > MAX_READ_CHARS) throw new ToolInputError(`${file} is too long to replace whole: use edit_file.`);
      return { ...base, input: { file, content }, meta: { before: current.content, version: current.version, exists: current.exists, address: current.address } };
    }
    case "edit_file": {
      const file = str(input, "file", { max: 300 });
      const { exists, content: before } = await readRepoText(key, file);
      if (!exists) throw new ToolInputError(`${file} isn't there. See list_files, or use write_file for a new file.`);
      const edits = input.edits ?? [];
      const append = str(input, "append", { max: 20_000, optional: true });
      if (!Array.isArray(edits) || edits.length > 30 || (!edits.length && !append)) throw new ToolInputError("Give append, or edits as a list of 1 to 30 replacements.");
      let content = before;
      const eol = before.includes("\r\n") ? (text) => text.replace(/\r?\n/g, "\r\n") : (text) => text;
      for (const edit of edits) {
        if (typeof edit?.find !== "string" || !edit.find || typeof edit.replace !== "string") throw new ToolInputError("Each edit needs find and replace text.");
        const find = eol(edit.find);
        const count = content.split(find).length - 1;
        if (!count) throw new ToolInputError(`"${edit.find.slice(0, 120)}" isn't in ${file}. Read it again and use its exact text.`);
        if (count > 1 && edit.all !== true) throw new ToolInputError(`"${edit.find.slice(0, 120)}" is in ${file} ${count} times. Use more of the text around it, or all.`);
        content = content.split(find).join(eol(edit.replace));
      }
      if (append) content = appended(content, append);
      if (content === before) throw new ToolInputError("Those edits change nothing.");
      const current = await checkRepoTextWrite(key, file, content);
      return { ...base, input: { file, content }, meta: { before, version: current.version, exists: true, address: current.address } };
    }
    case "append_blocks_from_attachment": {
      const options = blockOptions(input);
      const meta = await attachmentOf(input.attachment, key);
      const plan = await planBlocks(key, await attachmentText(key, meta), options);
      const report = describePlan(plan, "Ready to add to");
      if (!plan.ready.length) throw new ToolInputError(`Nothing to add. ${report}`);
      // Only what the card shows: the content is worked out again when it's applied, from the files as they are then.
      return {
        ...base,
        input: { attachment: meta.id, ...options },
        meta: { name: meta.name, ready: plan.ready.length, skipped: plan.skipped.length, failed: plan.failed.slice(0, 50), files: plan.ready.slice(0, 50).map((w) => w.file) },
        note: report,
      };
    }
    case "move_file": {
      const file = str(input, "file", { max: 300 });
      const to = str(input, "to", { max: 300 });
      const moved = await checkMove(key, file, to);
      const usedBy = moved.published ? await fileUsage(key, moved.address) : [];
      if (usedBy.length && input.fix_links_next !== true) throw new ToolInputError(`${moved.address} is used by ${usedBy.join(", ")}, and a link to the old address stops publishing. Set fix_links_next and continue_after, then change those to ${moved.toAddress}.`);
      return { ...base, input: { file, to }, meta: { name: moved.name, to } };
    }
    case "create_pdf": {
      const file = str(input, "file", { max: 300 });
      const title = str(input, "title", { max: 200 }).trim();
      const content = str(input, "content", { max: MAX_READ_CHARS });
      if (!file.toLowerCase().endsWith(".pdf")) throw new ToolInputError("file must end in .pdf.");
      const problem = pdfProblem(`${title}\n${content}`);
      if (problem) throw new ToolInputError(`${problem}. Offer a page or a text file instead.`);
      const folder = path.posix.dirname(file);
      const name = cleanFileName(path.posix.basename(file));
      const { rel, exists } = await checkRepoPlacement(key, folder, name);
      if (exists && input.replace !== true) throw new ToolInputError(`${rel} is already there. Set replace only if the owner wants it replaced, or use another name.`);
      return { ...base, input: { folder, name, title, content, replace: input.replace === true }, meta: { path: rel, replaces: exists } };
    }
    case "set_page_hidden": {
      const file = pageFileOf(input);
      if (typeof input.hidden !== "boolean") throw new ToolInputError("hidden must be true or false.");
      const page = await readPage(key, file);
      if (input.hidden && /^url\s*:\s*["']?\/["']?\s*$/m.test(page.content)) throw new ToolInputError("The homepage can't be hidden: visitors see it first.");
      return { ...base, input: { file, hidden: input.hidden }, meta: { title: titleOf(page.content) ?? file } };
    }
    case "update_site_scripts": {
      const overview = await getOverview(key);
      if (!overview.features.customScripts) throw new ToolInputError("This site's tools are older than scripts on the site: it needs the latest site update, which the editor offers. Tell the owner.");
      const scripts = checkScripts(input.scripts);
      const current = await readScripts(key);
      return { ...base, input: { scripts }, meta: { before: current.items, version: current.version } };
    }
    case "undo_changes": {
      const changes = (await getStatus(key)).changes.map((c) => c.path);
      if (!changes.length) throw new ToolInputError("There are no unpublished changes to undo.");
      const files = Array.isArray(input.files) ? [...new Set(input.files)] : [];
      const unknown = files.filter((f) => !changes.includes(f));
      if (!files.length || unknown.length) throw new ToolInputError(`${unknown.length ? `No unpublished change at ${unknown.join(", ")}. ` : ""}The changed files are: ${changes.join(", ")}.`);
      return { ...base, input: { files }, meta: {} };
    }
    case "remove_file": {
      const file = str(input, "file", { max: 300 });
      const found = await aiFileAt(key, file);
      if (!found) throw new ToolInputError(`${file} isn't there. See list_files.`);
      const usedBy = await fileUsage(key, found.address);
      if (usedBy.length && input.remove_anyway !== true) {
        throw new ToolInputError(`${found.address} is still used by ${usedBy.join(", ")}. Take it off there first (with continue_after), or ask the owner, then use remove_anyway.`);
      }
      return { ...base, input: { file }, meta: { name: found.name, address: found.address, usedBy } };
    }
    case "convert_page_from_html": {
      const file = pageFileOf(input);
      const page = await readPage(key, file);
      const overview = await getOverview(key);
      if (!overview.features.pageConvert) throw new ToolInputError("This site's tools are too old to bring in pages. Ask the owner to update them (Technical log, under More tools).");
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
    case "check_site":
      // Always carries on: a result nobody reads back is no use.
      return { ...base, continueAfter: true, input: {}, meta: {} };
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
      // A link to a page the site doesn't have stops publishing: Claude fixes it now, not the owner later.
      const problems = navigationLinkProblems(navigation, current.pages ?? [], current.navigation);
      if (problems.length) {
        const visible = (current.pages ?? []).filter((p) => !p.draft).map((p) => `${p.url} (${p.title})`);
        throw new ToolInputError(
          `These links don't reach a page the site has:\n- ${problems.join("\n- ")}\nUse one of the site's addresses: ${visible.join(", ")}. Or create the page first (create_page with address), or leave the link out.`,
        );
      }
      return { ...base, input: { navigation }, meta: { before: current.navigation, version: current.version } };
    }
    case "update_site_details": {
      const id = str(input, "section", { max: 100 });
      const { sections } = await getStaticInfo(key);
      const section = sections.find((s) => s.id === id);
      if (!section) throw new ToolInputError(`Unknown section "${id}". Sections: ${sections.map((s) => s.id).join(", ")}.`);
      if (input?.data === undefined) throw new ToolInputError("data is required.");
      // A JSON string is read as the data; anything that wouldn't save goes back to Claude now,
      // not to the owner as a change that fails when applied.
      let data = input.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          throw new ToolInputError("data must be the section's object (or list), not text.");
        }
      }
      const problem = await checkStaticInfo(key, id, data);
      if (problem) throw new ToolInputError(`${problem} Send the section's complete data from read_site_details with only the asked-for values changed.`);
      return { ...base, input: { section: id, data }, meta: { before: section.data, label: section.label, file: section.file } };
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
    case "create_image": {
      // Drawn (svg) or made by the image model (prompt), never both.
      const made = typeof input?.prompt === "string" && input.prompt.trim() !== "";
      if (made === (typeof input?.svg === "string" && input.svg.trim() !== "")) throw new ToolInputError("Send either svg (an image you draw) or prompt (a picture to make), not both.");
      let svg = null;
      let picture = null;
      if (made) {
        const shape = input.shape ?? "landscape";
        const quality = input.quality ?? "medium";
        if (!SHAPES.includes(shape)) throw new ToolInputError(`shape must be one of ${SHAPES.join(", ")}.`);
        if (!QUALITIES.includes(quality)) throw new ToolInputError(`quality must be one of ${QUALITIES.join(", ")}.`);
        if (input.transparent !== undefined && typeof input.transparent !== "boolean") throw new ToolInputError("transparent must be true or false.");
        picture = { prompt: str(input, "prompt", { max: MAX_PROMPT_CHARS }).trim(), shape, quality, transparent: input.transparent === true };
      } else {
        const checked = checkSvg(str(input, "svg", { max: MAX_SVG_CHARS }));
        if (checked.problem) throw new ToolInputError(`That SVG can't be used: ${checked.problem}. Draw it again.`);
        svg = checked.svg;
      }
      const name = drawnName(str(input, "name", { max: 100 }));
      const wanted = input?.use_as ?? [];
      if (!Array.isArray(wanted) || wanted.some((f) => !LOGO_IMAGE_FIELDS.includes(f))) {
        throw new ToolInputError(`use_as may list only ${LOGO_IMAGE_FIELDS.join(", ")}.`);
      }
      const useAs = [...new Set(wanted)];
      if (useAs.some((f) => f === "logoMark" || f === "favicon")) {
        if (picture ? picture.shape !== "square" : !isSquare(svgAspect(svg))) {
          throw new ToolInputError(picture ? "The small mark and the browser-tab icon must be square: set shape to square." : "The small mark and the browser-tab icon must be square: give the svg a square viewBox, such as 0 0 64 64.");
        }
      }
      // A new logo brings its own square mark, so the browser tab doesn't keep showing the old one
      // (the favicon falls back to the mark) and a wide logo isn't squeezed into 16 pixels.
      let mark = null;
      if (input?.mark_svg) {
        const checked = checkSvg(str(input, "mark_svg", { max: MAX_SVG_CHARS }));
        if (checked.problem) throw new ToolInputError(`That mark_svg can't be used: ${checked.problem}. Draw it again.`);
        if (!isSquare(svgAspect(checked.svg))) throw new ToolInputError("mark_svg must be square: give it a square viewBox, such as 0 0 64 64.");
        mark = checked.svg;
      } else if (useAs.includes("logo") && !useAs.includes("favicon")) {
        throw new ToolInputError("A new logo needs a matching browser-tab icon: add mark_svg, a square version in the same style (an initial or emblem, readable at 16px).");
      }
      let before = null;
      let markFields = [];
      if (useAs.length || mark) {
        const current = await getBrand(key);
        // Older sites' headers and footers show only the small mark.
        if (!current.supported && useAs.some((f) => f !== "logoMark")) {
          throw new ToolInputError("This site's header and footer are older and only show the small mark: use_as may only be logoMark here.");
        }
        before = current.brand;
        if (mark) markFields = current.supported ? ["logoMark", "favicon"] : ["logoMark"];
      }
      const markMeta = mark && { markPath: `${DRAWN_DIR}/${name}-mark.svg`, markPreview: svgPreview(mark) };
      const fields = { useAs: useAs.filter((f) => !markFields.includes(f)), markSvg: mark, markFields };
      if (!picture) {
        return { ...base, input: { svg, name, ...fields }, meta: { path: `${DRAWN_DIR}/${name}.svg`, preview: svgPreview(svg), ...markMeta, before } };
      }
      // Made last, once everything else is known to be fine: it's paid for even if it's skipped.
      if (!context.beginSpend) throw new ToolInputError("Pictures can't be made here. Draw it as SVG instead.");
      let image;
      try {
        image = await generateImage({ ...picture, model: context.imageModel, beginSpend: context.beginSpend, signal: context.signal });
      } catch (err) {
        if (err instanceof ImageError) throw new ToolInputError(err.message);
        throw err;
      }
      const saved = await saveMadeImage(key, { name: `${name}.${image.extension}`, bytes: image.bytes });
      return {
        ...base,
        input: { attachment: saved.id, name, ...fields },
        meta: {
          path: `${GENERATED_DIR}/${name}.${image.extension}`,
          attachment: saved.id,
          picture: { prompt: picture.prompt, quality: picture.quality, size: image.size, model: image.model },
          ...markMeta,
          before,
        },
      };
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
 * `context` is the turn's: `beginSpend` (credits.js) pays for a picture create_image makes with
 * `imageModel` (the site's, image-model.js), and `signal` stops it. `userId` is who's asking:
 * read_analytics answers only the site's creator.
 */
export async function runTool(name, input, key, context = {}) {
  const info = toolInfo(name);
  if (!info) return { error: `There's no tool called ${name}.` };
  if (!isPlainObject(input)) return { error: "The tool input must be an object." };
  try {
    if (info.kind === "talk") return { talk: choicesOf(input) };
    if (info.kind === "read") {
      const result = await runRead(name, input, key, context);
      if (Array.isArray(result?.blocks)) return { result: result.blocks };
      return { result: typeof result === "string" ? result : JSON.stringify(result) };
    }
    return { action: await prepareChange(name, input, key, context) };
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof WorkspaceError) return { error: err.message };
    throw err;
  }
}

/** offer_choices' buttons, checked: shown in the chat as they are. */
function choicesOf(input) {
  const kind = input.kind === "question" ? "question" : input.kind === "next" ? "next" : null;
  if (!kind) throw new ToolInputError("kind must be question or next.");
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (kind === "question" && !question) throw new ToolInputError("A question needs its question.");
  if (question.length > 200) throw new ToolInputError("Keep the question under 200 characters.");
  const choices = Array.isArray(input.choices) ? [...new Set(input.choices.filter((c) => typeof c === "string").map((c) => c.trim()).filter(Boolean))] : [];
  // A question may have no buttons (a fact the owner types); next steps always have them.
  if (!(kind === "question" && choices.length === 0) && (choices.length < 2 || choices.length > 4)) {
    throw new ToolInputError(kind === "question" ? "Give 2 to 4 different choices, or none for a fact they type." : "Give 2 to 4 different choices.");
  }
  if (choices.some((c) => c.length > 80)) throw new ToolInputError("Keep each choice under 80 characters.");
  return { kind, ...(kind === "question" && { question }), choices };
}

/* --------------------------------------------------------------- applying */

const LOGO_LABELS = { logo: "logo", logoDark: "logo on dark backgrounds", logoMark: "small mark", favicon: "browser-tab icon" };

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
    case "write_file":
      await writeRepoText(key, input.file, input.content, meta.version);
      return `Saved ${input.file} (published at ${meta.address}).`;
    case "edit_file":
      await writeRepoText(key, input.file, input.content, meta.version);
      return `Saved ${input.file}.`;
    case "append_blocks_from_attachment": {
      const { attachment, ...options } = input;
      const attached = await readAttachmentMeta(key, attachment);
      const plan = await planBlocks(key, await attachmentText(key, attached), options);
      if (plan.ready.length) await writeRepoTexts(key, plan.ready);
      return describePlan(plan, "Added to");
    }
    case "remove_file":
      await removeSiteFile(key, input.file);
      return `Removed ${input.file}.`;
    case "move_file":
      await moveSiteFile(key, input.file, input.to);
      return `Moved ${input.file} to ${input.to}.`;
    case "create_pdf": {
      const saved = await saveRepoFile(key, { folder: input.folder, file: input.name, buffer: await makePdf(input), replace: input.replace });
      return { result: `Saved ${saved.file} (published at ${saved.address}).`, data: { path: saved.file } };
    }
    case "set_page_hidden":
      await setPageDraft(key, input.file, input.hidden);
      return `${input.hidden ? "Hid" : "Showed"} ${input.file}.`;
    case "update_site_scripts":
      await saveScripts(key, input.scripts, meta.version);
      return "Saved the site's scripts.";
    case "undo_changes":
      await discardChanges(key, input.files);
      return `Put back ${input.files.length} file(s) as last published.`;
    case "add_file_to_site": {
      if (input.folder) {
        const { bytes } = await readAttachment(key, input.attachment);
        const saved = await saveRepoFile(key, { folder: input.folder, file: input.name, buffer: bytes, replace: input.replace });
        return { result: `${saved.replaced ? "Replaced" : "Added"} ${saved.file} (published at ${saved.address}).`, data: { path: saved.file } };
      }
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
    case "create_image": {
      const saved = input.attachment ? await addAttachmentToSite(key, input.attachment, input.name, GENERATED_DIR) : await saveDrawnImage(key, input.name, input.svg);
      const useAs = input.useAs ?? [];
      const markFields = input.markSvg ? (input.markFields ?? []) : [];
      const brand = Object.fromEntries(useAs.map((field) => [field, `/${saved}`]));
      let markSaved = null;
      if (input.markSvg) {
        markSaved = await saveDrawnImage(key, `${input.name}-mark`, input.markSvg);
        for (const field of markFields) brand[field] = `/${markSaved}`;
      }
      if (Object.keys(brand).length) await saveBrand(key, brand);
      const list = (fields) => {
        const labels = fields.map((f) => LOGO_LABELS[f]);
        return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
      };
      const used = useAs.length ? ` and set it as the ${list(useAs)}` : "";
      const markNote = markSaved ? ` Its square version, ${markSaved}, is now the ${list(markFields)}.` : "";
      return { result: `Saved it as ${saved} (published at /${saved})${used}.${markNote}`, data: { path: saved } };
    }
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
