import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";
import { contentVersion, frontmatter, inside, listFiles, readText } from "./site-files.js";

// The site's header and footer, kept in content/data/navigation.json: the header menu (links,
// dropdowns of links, and collection menus that list a collection's pages themselves), the header
// button, the footer's link columns, the legal links under them, and `appearance` (colour themes,
// where the menu sits, whether the header sticks, what the footer shows, its copyright line).
// The copy's scripts/lib/content.js turns appearance into nav.appearance for header.html and
// footer.html; copies made before that ignore it (`supportsAppearance`), and
// HEADER_FOOTER_FILES brings those three files over from the template.

const NAV_FILE = "content/data/navigation.json";
export const HEADER_FOOTER_FILES = ["templates/partials/header.html", "templates/partials/footer.html", "scripts/lib/content.js"];
/** In the template's header.html and footer.html once they read the appearance settings. */
export const APPEARANCE_MARKER = "nav.appearance";

const HEADER_THEMES = ["light", "dark", "brand"];
const HEADER_LAYOUTS = ["right", "center", "left"];
const FOOTER_THEMES = ["dark", "light", "brand"];
const DEFAULT_APPEARANCE = {
  header: { theme: "light", layout: "right", sticky: true },
  footer: { theme: "dark", showTagline: true, showContact: true, copyright: "" },
};
const LIMITS = { items: 15, children: 20, columns: 8, links: 20, legal: 10 };
// Pages, files, anchors, mail, phone and web links. Never javascript: or data:.
const LINK = /^(\/(?!\/)|#|mailto:|tel:|https?:\/\/)\S*$/i;
const MAX_BYTES = 256 * 1024;
const MAX_PAGES = 500;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => {
  throw new WorkspaceError(message, 400);
};

async function readJsonFile(dir, file, fallback) {
  const text = await readText(path.join(dir, file));
  if (text === null) {
    if (fallback === undefined) throw new WorkspaceError(`${file} is missing.`, 422);
    return { text: null, data: fallback };
  }
  try {
    const data = JSON.parse(text);
    if (!isObject(data)) throw new Error("it isn't an object");
    return { text, data };
  } catch (err) {
    throw new WorkspaceError(`${file} isn't valid JSON (${err.message}). Fix it in the repository first.`, 422);
  }
}

/** The appearance settings with every missing or unknown value replaced by the template's own look. */
function withDefaults(appearance) {
  const header = isObject(appearance?.header) ? appearance.header : {};
  const footer = isObject(appearance?.footer) ? appearance.footer : {};
  return {
    header: {
      theme: HEADER_THEMES.includes(header.theme) ? header.theme : DEFAULT_APPEARANCE.header.theme,
      layout: HEADER_LAYOUTS.includes(header.layout) ? header.layout : DEFAULT_APPEARANCE.header.layout,
      sticky: header.sticky !== false,
    },
    footer: {
      theme: FOOTER_THEMES.includes(footer.theme) ? footer.theme : DEFAULT_APPEARANCE.footer.theme,
      showTagline: footer.showTagline !== false,
      showContact: footer.showContact !== false,
      copyright: typeof footer.copyright === "string" ? footer.copyright : "",
    },
  };
}

/** Like the site's applyUrlPattern in scripts/lib/content.js. */
function applyUrlPattern(pattern, slug) {
  const url = pattern.replace(":slug", slug);
  return url.endsWith("/") || url.endsWith(".html") ? url : `${url}/`;
}

/** Every page the site builds, with its address, for the editor's link picker and its missing-page hints (and the site check, site-check.js). */
export async function sitePages(dir, site) {
  const pages = [];
  for (const [name, collection] of Object.entries(site.collections ?? {})) {
    if (typeof collection?.dir !== "string" || typeof collection.urlPattern !== "string") continue;
    const collectionDir = inside(dir, collection.dir);
    for (const file of await listFiles(collectionDir, ".md")) {
      // The site skips files and folders whose names start with "_" (content/_scheduled).
      if (file.split("/").some((part) => part.startsWith("_"))) continue;
      const fields = frontmatter((await readText(path.join(collectionDir, file))) ?? "");
      const folder = path.posix.dirname(file);
      const base = path.posix.basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "");
      const slug = fields.slug || (folder === "." ? base : `${folder}/${base}`);
      pages.push({
        file: `${collection.dir}/${file}`,
        url: fields.url || applyUrlPattern(collection.urlPattern, slug),
        title: fields.title || slug,
        collection: name,
        draft: fields.draft === "true",
      });
      if (pages.length >= MAX_PAGES) return pages;
    }
  }
  return pages;
}

/** The header and footer as the editor works on them, with what it needs to show and check them. */
export async function getNavigation(key) {
  const dir = workspaceDir(key);
  const { text, data } = await readJsonFile(dir, NAV_FILE, {});
  const { data: site } = await readJsonFile(dir, "site.config.json");
  const [header, footer, content] = await Promise.all(
    HEADER_FOOTER_FILES.map(async (file) => (await readText(path.join(dir, file))) ?? ""),
  );
  const objects = (list) => (Array.isArray(list) ? list.filter(isObject) : []);
  const contact = isObject(site.contact) ? site.contact : {};
  return {
    navigation: {
      header: { items: objects(data.header?.items), cta: isObject(data.header?.cta) ? data.header.cta : null },
      footer: objects(data.footer).map((column) => ({ ...column, links: objects(column.links) })),
      legal: objects(data.legal),
      appearance: withDefaults(data.appearance),
    },
    supportsAppearance: header.includes(APPEARANCE_MARKER) && footer.includes(APPEARANCE_MARKER) && content.includes("navAppearance"),
    version: contentVersion(text ?? ""),
    collections: Object.entries(site.collections ?? {}).map(([name, collection]) => ({
      name,
      label: collection?.index?.label ?? name,
    })),
    pages: await sitePages(dir, site),
    // What the footer shows besides its links, for the editor's preview.
    site: {
      name: typeof site.name === "string" ? site.name : "",
      footerTagline: typeof site.footerTagline === "string" ? site.footerTagline : "",
      foundedYear: site.foundedYear ?? null,
      email: typeof contact.email === "string" ? contact.email : "",
      phone: typeof contact.whatsapp === "string" ? contact.whatsapp : "",
    },
  };
}

/* ------------------------------------------------------------- validation */

function text(value, where, what, max) {
  if (typeof value !== "string" || !value.trim()) fail(`${where} needs ${what}.`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${where}: the ${what.replace(/^an? /, "")} is over ${max} characters.`);
  if (/[\r\n]/.test(trimmed)) fail(`${where}: the ${what.replace(/^an? /, "")} must be one line.`);
  return trimmed;
}

function link(value, where, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (typeof value !== "string" || !value.trim()) fail(`${where} needs a link.`);
  const trimmed = value.trim();
  if (trimmed.length > 300 || !LINK.test(trimmed)) {
    fail(`${where}: "${trimmed.slice(0, 80)}" isn't a link the site can use. Start it with /, https://, mailto: or tel:.`);
  }
  return trimmed;
}

function list(value, max, what) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${what} must be a list.`);
  if (value.length > max) fail(`${what} can have at most ${max} entries.`);
  return value;
}

/** Fields the editor doesn't know about, kept when they're plain values. */
function extras(item, known) {
  return Object.fromEntries(
    Object.entries(item).filter(([k, v]) => !known.includes(k) && k !== "__proto__" && ["string", "number", "boolean"].includes(typeof v)),
  );
}

/** Drops undefined fields so they aren't written. */
const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));

function collectionMenu(item, where, collections) {
  if (typeof item.collection !== "string" || !collections.has(item.collection)) {
    fail(`${where}: choose one of the site's collections (${[...collections].join(", ") || "it has none"}).`);
  }
  const limit = item.limit === undefined ? 8 : item.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(`${where}: the number of pages shown must be from 1 to 100.`);
  return { type: "collection", collection: item.collection, limit };
}

const LINK_FIELDS = ["label", "url", "description"];

function plainLink(item, where, { description = false } = {}) {
  if (!isObject(item)) fail(`${where} isn't a link.`);
  if (item.type !== undefined) fail(`${where} can only be a link.`);
  return defined({
    label: text(item.label, where, "a label", 60),
    url: link(item.url, where),
    description: description && item.description ? text(item.description, where, "a description", 160) : undefined,
    ...extras(item, LINK_FIELDS),
  });
}

const HEADER_FIELDS = ["label", "url", "type", "collection", "limit", "children"];

function headerItem(item, where, collections) {
  if (!isObject(item)) fail(`${where} isn't a menu item.`);
  const label = text(item.label, where, "a label", 60);
  if (item.type === "collection") {
    return defined({ label, url: link(item.url, where, { optional: true }), ...collectionMenu(item, where, collections), ...extras(item, HEADER_FIELDS) });
  }
  if (item.type !== undefined) fail(`${where}: "${item.type}" isn't a kind of menu item.`);
  if (Array.isArray(item.children) && item.children.length) {
    const children = list(item.children, LIMITS.children, `${where}'s dropdown`).map((child, i) =>
      plainLink(child, `${where}, dropdown link ${i + 1}`, { description: true }),
    );
    // A dropdown's own link is optional: without one its label just opens the dropdown.
    return defined({ label, url: link(item.url, where, { optional: true }), children, ...extras(item, HEADER_FIELDS) });
  }
  return { label, url: link(item.url, where), ...extras(item, HEADER_FIELDS) };
}

function footerColumn(column, where, collections) {
  if (!isObject(column)) fail(`${where} isn't a column.`);
  const links = list(column.links, LIMITS.links, `${where}'s links`).map((item, i) => {
    const at = `${where}, link ${i + 1}`;
    if (!isObject(item)) fail(`${at} isn't a link.`);
    if (item.type !== "collection") return plainLink(item, at);
    // Unlabelled, it lists the collection's pages as the column's links.
    return defined({
      label: item.label ? text(item.label, at, "a label", 60) : undefined,
      url: item.label ? link(item.url, at, { optional: true }) : undefined,
      ...collectionMenu(item, at, collections),
      ...extras(item, HEADER_FIELDS),
    });
  });
  return { title: text(column.title, where, "a heading", 60), links, ...extras(column, ["title", "links"]) };
}

function button(cta) {
  if (cta === null || cta === undefined) return null;
  if (!isObject(cta)) fail("The header button isn't valid.");
  return { label: text(cta.label, "The header button", "a label", 40), url: link(cta.url, "The header button"), ...extras(cta, ["label", "url"]) };
}

function appearance(value) {
  if (!isObject(value) || !isObject(value.header) || !isObject(value.footer)) fail("The appearance settings aren't valid.");
  const { header, footer } = value;
  if (!HEADER_THEMES.includes(header.theme)) fail(`The header colour must be one of ${HEADER_THEMES.join(", ")}.`);
  if (!HEADER_LAYOUTS.includes(header.layout)) fail(`The menu position must be one of ${HEADER_LAYOUTS.join(", ")}.`);
  if (!FOOTER_THEMES.includes(footer.theme)) fail(`The footer colour must be one of ${FOOTER_THEMES.join(", ")}.`);
  for (const [field, v] of [["header sticky", header.sticky], ["footer showTagline", footer.showTagline], ["footer showContact", footer.showContact]]) {
    if (typeof v !== "boolean") fail(`The ${field} setting must be yes or no.`);
  }
  const copyright = footer.copyright ?? "";
  if (typeof copyright !== "string" || copyright.length > 120 || /[\r\n]/.test(copyright)) fail("The copyright line must be one line of up to 120 characters.");
  return {
    header: { theme: header.theme, layout: header.layout, sticky: header.sticky },
    footer: { theme: footer.theme, showTagline: footer.showTagline, showContact: footer.showContact, copyright: copyright.trim() },
  };
}

/**
 * Saves the header and footer into content/data/navigation.json. `version` is the one the editor
 * loaded: a file changed since (by a command, say) is never overwritten. The file's other keys,
 * their order and its line endings are kept; `appearance` is written only when it's sent.
 */
export async function saveNavigation(key, next, version) {
  if (!isObject(next) || !isObject(next.header)) fail("Nothing to save.");
  if (typeof version !== "string") fail("Reload the page, then save again.");
  const release = acquire(key, `saving ${NAV_FILE}`);
  try {
    const dir = workspaceDir(key);
    const { text: current, data } = await readJsonFile(dir, NAV_FILE, {});
    if (contentVersion(current ?? "") !== version) {
      throw new WorkspaceError("The header and footer were changed by something else since you opened them. Reload to get the latest version, then make your edits again.", 409);
    }
    const { data: site } = await readJsonFile(dir, "site.config.json");
    const collections = new Set(Object.keys(site.collections ?? {}));

    const items = list(next.header.items, LIMITS.items, "The header menu").map((item, i) => headerItem(item, `Header item ${i + 1}`, collections));
    const footer = list(next.footer, LIMITS.columns, "The footer").map((column, i) => footerColumn(column, `Footer column ${i + 1}`, collections));
    const legal = list(next.legal, LIMITS.legal, "The legal links").map((item, i) => plainLink(item, `Legal link ${i + 1}`));
    const look = next.appearance === undefined ? undefined : appearance(next.appearance);

    // Spreading the original first keeps its key order; keys it lacks go at the end.
    const header = { ...(isObject(data.header) ? data.header : {}), items, cta: button(next.header.cta) };
    const merged = { ...data, header, footer, legal, ...(look ? { appearance: look } : {}) };
    const newline = current?.includes("\r\n") ? "\r\n" : "\n";
    const output = `${JSON.stringify(merged, null, 2)}\n`.replace(/\n/g, newline);
    if (Buffer.byteLength(output) > MAX_BYTES) fail("That's too much for one file.");
    const file = path.join(dir, NAV_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, output);
  } finally {
    release();
  }
  return getNavigation(key);
}
