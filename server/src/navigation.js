import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, git, workspaceDir } from "./workspace.js";
import { applyUrlPattern, contentVersion, frontmatter, inside, listFiles, readText } from "./site-files.js";
import { normalizeLink } from "./links.js";

// The site's header and footer, kept in content/data/navigation.json: the header menu (links,
// dropdowns of links, and collection menus that list a collection's pages themselves), the header
// button, the footer's link columns, the legal links under them, and `appearance` (colour themes,
// where the menu sits, whether the header sticks, what the footer shows, its copyright line).
// The copy's scripts/lib/content.js turns appearance into nav.appearance for header.html and
// footer.html; copies made before that ignore it (`supportsAppearance`), and
// HEADER_FOOTER_FILES brings those three files over from the template.

const NAV_FILE = "content/data/navigation.json";
// site.js sets the header's data-scrolled, which the see-through and shrinking header styles read.
export const HEADER_FOOTER_FILES = ["templates/partials/header.html", "templates/partials/footer.html", "scripts/lib/content.js", "assets/js/site.js"];
/** What each of HEADER_FOOTER_FILES must contain, in the template, for the installer to take it. */
export const HEADER_FOOTER_MARKERS = {
  "templates/partials/header.html": "nav.appearance",
  "templates/partials/footer.html": "nav.appearance",
  "scripts/lib/content.js": "navAppearance",
  "assets/js/site.js": "data-scrolled",
};
/** In the template's header.html and footer.html once they read the appearance settings. */
export const APPEARANCE_MARKER = "nav.appearance";
// On the <header> and <footer> Claude designs (the site's scripts/lib/chrome.js DESIGNED_MARK).
const DESIGNED_MARK = 'data-designed="claude"';

const HEADER_THEMES = ["light", "dark", "brand"];
const HEADER_LAYOUTS = ["right", "center", "left"];
const HEADER_STYLES = ["bar", "floating"];
const FOOTER_THEMES = ["dark", "light", "brand"];
const FOOTER_LAYOUTS = ["columns", "centered", "minimal"];
const DEFAULT_APPEARANCE = {
  header: { theme: "light", layout: "right", sticky: true, style: "bar", transparent: false, shrink: false },
  footer: { theme: "dark", layout: "columns", showTagline: true, showContact: true, showSocial: true, cta: null, copyright: "" },
};
// In the template's header.html once it has the floating, see-through and shrinking styles, and in
// its footer.html once it has layouts, social icons and the call-to-action strip.
const HEADER_STYLES_MARKER = "nav.appearance.header.style";
const FOOTER_LAYOUTS_MARKER = "nav.appearance.footer.layout";
// On a header or footer copied from a converted page (the site's scripts/lib/chrome.js COPIED_MARK).
const COPIED_MARK = 'data-designed="copied"';
const SOCIAL = ["linkedin", "x", "facebook", "instagram", "youtube", "github"];

/** The footer's call-to-action strip as saved: { title, text, label, url } or null. */
function footerCta(cta) {
  if (!isObject(cta)) return null;
  const value = (key) => (typeof cta[key] === "string" ? cta[key] : "");
  return { title: value("title"), text: value("text"), label: value("label"), url: value("url") };
}
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
      style: HEADER_STYLES.includes(header.style) ? header.style : DEFAULT_APPEARANCE.header.style,
      transparent: header.transparent === true,
      shrink: header.shrink === true,
    },
    footer: {
      theme: FOOTER_THEMES.includes(footer.theme) ? footer.theme : DEFAULT_APPEARANCE.footer.theme,
      layout: FOOTER_LAYOUTS.includes(footer.layout) ? footer.layout : DEFAULT_APPEARANCE.footer.layout,
      showTagline: footer.showTagline !== false,
      showContact: footer.showContact !== false,
      showSocial: footer.showSocial !== false,
      cta: footerCta(footer.cta),
      copyright: typeof footer.copyright === "string" ? footer.copyright : "",
    },
  };
}

/** The HTML file a copied header or footer came from (its data-chrome-from), or null. */
const chromeSource = (partial) => partial.match(/data-chrome-from="([^"]*)"/)?.[1] ?? null;

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
        // The menus the page adds itself to (frontmatter `menu`): header, footer or both, or null.
        menu: PAGE_MENUS.includes(fields.menu) ? fields.menu : null,
      });
      if (pages.length >= MAX_PAGES) return pages;
    }
  }
  return pages;
}

/** The partials (of header.html, footer.html) whose published version carries data-designed while the working one doesn't. */
async function replacedDesigned(dir, header, footer) {
  const out = [];
  for (const [file, now] of [["templates/partials/header.html", header], ["templates/partials/footer.html", footer]]) {
    if (/\sdata-designed\s*=/.test(now)) continue;
    const published = await git(dir, ["show", `HEAD:${file}`]).catch(() => "");
    if (/\sdata-designed\s*=/.test(published)) out.push(file);
  }
  return out;
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
    // Claude designed the header or footer (edit-page.js --chrome): its colours and layout are
    // Claude's, so the style switches don't apply to it. Menu, button, logo and copyright still do.
    designed: { header: header.includes(DESIGNED_MARK), footer: footer.includes(DESIGNED_MARK) },
    // Copied as it was from a converted page (edit-page.js --with-header/--with-footer): fixed HTML,
    // so neither the menu nor the style settings change it until the standard one is put back.
    copied: {
      header: header.includes(COPIED_MARK),
      footer: footer.includes(COPIED_MARK),
      from: chromeSource(header) ?? chromeSource(footer),
    },
    // The published header and footer were the owner's (copied or designed by the AI) but the working
    // copy has others: they were replaced and not published yet. Look & logo offers them back.
    replacedDesigned: await replacedDesigned(dir, header, footer),
    // The newer standard header and footer: header styles, footer layouts, social icons, the strip.
    supportsStyles: header.includes(HEADER_STYLES_MARKER) && footer.includes(FOOTER_LAYOUTS_MARKER),
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
      // Which social links are set (site.config.json → social), for the footer preview's icons.
      social: SOCIAL.filter((name) => typeof site.social?.[name] === "string" && site.social[name].trim().startsWith("http")),
    },
  };
}

const PAGE_MENUS = ["header", "footer", "both"];

/**
 * Sets the menus a page adds itself to: its frontmatter `menu` (header, footer or both; null
 * removes it), which the copy's scripts/lib/content.js reads. Only that line of the file changes.
 */
export async function setPageMenu(key, file, menu) {
  if (menu !== null && !PAGE_MENUS.includes(menu)) fail("Choose header, footer or both.");
  if (typeof file !== "string" || !/^content\/[\w./-]+\.md$/.test(file) || file.split("/").includes("..")) fail("That isn't a page.");
  const release = acquire(key, `setting the menus of ${file}`);
  try {
    const target = inside(workspaceDir(key), file);
    const current = await readText(target);
    if (current === null) throw new WorkspaceError(`${file} doesn't exist.`, 404);
    const match = current.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!match) fail(`${file} has no frontmatter to set it in.`);
    const eol = match[1].endsWith("\r\n") ? "\r\n" : "\n";
    const lines = match[2].split(/\r?\n/).filter((line) => !/^menu\s*:/.test(line));
    if (menu) lines.push(`menu: ${menu}`);
    await fs.writeFile(target, `${match[1]}${lines.join(eol)}${match[3]}${current.slice(match[0].length)}`);
  } finally {
    release();
  }
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
  // As people write them: "instagram.com/x", an email address, a phone number (links.js).
  const trimmed = normalizeLink(value);
  if (trimmed.length > 300 || !LINK.test(trimmed)) {
    fail(`${where}: "${trimmed.slice(0, 80)}" isn't a link the site can use. Use a page's address (/about.html), a web address (https://…), an email address or a phone number.`);
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
  // The newer options are optional: an editor that doesn't know them leaves them out.
  const style = header.style ?? "bar";
  if (!HEADER_STYLES.includes(style)) fail(`The header style must be one of ${HEADER_STYLES.join(", ")}.`);
  const layout = footer.layout ?? "columns";
  if (!FOOTER_LAYOUTS.includes(layout)) fail(`The footer layout must be one of ${FOOTER_LAYOUTS.join(", ")}.`);
  for (const [field, v] of [["header see-through", header.transparent], ["header shrink", header.shrink], ["footer showSocial", footer.showSocial]]) {
    if (v !== undefined && typeof v !== "boolean") fail(`The ${field} setting must be yes or no.`);
  }
  let cta;
  if (footer.cta !== undefined && footer.cta !== null) {
    if (!isObject(footer.cta)) fail("The footer's call to action isn't valid.");
    const label = typeof footer.cta.label === "string" ? footer.cta.label.trim() : "";
    // No button label: no strip.
    if (label) {
      const where = "The footer's call to action";
      cta = defined({
        title: footer.cta.title?.trim() ? text(footer.cta.title, where, "a heading", 100) : undefined,
        text: footer.cta.text?.trim() ? text(footer.cta.text, where, "a sentence", 200) : undefined,
        label: text(label, where, "a button label", 40),
        url: link(footer.cta.url, `${where} button`),
      });
    }
  }
  return {
    header: { theme: header.theme, layout: header.layout, sticky: header.sticky, style, transparent: header.transparent === true, shrink: header.shrink === true },
    footer: defined({
      theme: footer.theme,
      layout,
      showTagline: footer.showTagline,
      showContact: footer.showContact,
      showSocial: footer.showSocial !== false,
      cta,
      copyright: copyright.trim(),
    }),
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

/* ------------------------------------------------- a copied header and footer's own menus */

// A header and footer copied from a website (data-designed="copied") draw their own menus from their
// HTML, so navigation.json keeps the template's starter links (Blog, About, Contact us, Privacy,
// Terms, Sitemap). A header and footer designed later (a redesign) read navigation.json, and showed
// those instead of the business's menu. So the copied menu, its dropdowns, its button, the footer's
// columns and its legal links are read into navigation.json: when a copy finishes and before every
// header and footer design, once per copied header (`copiedMenu` records its data-chrome-id).

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIPPED_TAGS = new Set(["script", "style", "template", "svg", "noscript", "select", "textarea"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

const decode = (text) =>
  text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

/** A small, forgiving HTML tree: `{ tag, attrs, children, parent }` nodes and `{ text }` leaves. */
export function htmlTree(html) {
  const root = { tag: "#root", attrs: "", children: [], parent: null };
  let current = root;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>|([^<]+)|</g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      current.children.push({ text: m[4], parent: current });
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // A closing tag closes up to its element, if it's open; otherwise it's ignored.
      let node = current;
      while (node && node.tag !== tag) node = node.parent;
      if (node && node.parent) current = node.parent;
      continue;
    }
    if (SKIPPED_TAGS.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      re.lastIndex = end < 0 ? html.length : end;
      continue;
    }
    // A new list item ends the open one of the same list (HTML lets </li> be left out).
    if (tag === "li") {
      let node = current;
      while (node && node.tag !== "ul" && node.tag !== "ol" && node.tag !== "li") node = node.parent;
      if (node?.tag === "li") current = node.parent;
    }
    const node = { tag, attrs: m[3] || "", children: [], parent: current };
    current.children.push(node);
    if (!VOID_TAGS.has(tag) && !m[0].endsWith("/>")) current = node;
  }
  return root;
}

const attrOf = (node, name) => new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]*)))?(?=\\s|$)`, "i").exec(node.attrs ?? "");
const attrValue = (node, name) => {
  const m = attrOf(node, name);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const hiddenNode = (node) => Boolean(attrOf(node, "hidden")) || attrValue(node, "aria-hidden") === "true";

function walk(node, visit) {
  for (const child of node.children ?? []) {
    if (child.tag) {
      if (visit(child) === false) continue;
      walk(child, visit);
    }
  }
}
const find = (node, test) => {
  const out = [];
  walk(node, (n) => {
    if (test(n)) out.push(n);
  });
  return out;
};
const textOf = (node) => {
  if (node.text !== undefined) return node.text;
  if (node.tag && hiddenNode(node)) return "";
  return (node.children ?? []).map(textOf).join(" ");
};
const clean = (text) => decode(text).replace(/\s+/g, " ").trim();
const within = (node, ancestor) => {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
};
const insideTag = (node, tags, stop) => {
  for (let n = node.parent; n && n !== stop; n = n.parent) if (tags.includes(n.tag)) return true;
  return false;
};

/** An anchor as a menu link `{ label, url }`, or null (hidden, no words, or no address). */
function anchorLink(a) {
  if (hiddenNode(a)) return null;
  const label = (clean(textOf(a)) || clean(attrValue(a, "aria-label") ?? attrValue(a, "title") ?? "")).slice(0, 60).trim();
  const url = (attrValue(a, "href") ?? "").trim();
  if (!label || !url || /^javascript:/i.test(url)) return null;
  return { label, url };
}

// All-capitals labels and headings ("SOLUTIONS BY FEATURE") are the old site's styling, not its words.
// One word in capitals is a name or acronym (WASH, FAQ) and stays.
const sentence = (label) => (/[a-z]/.test(label) || !/[A-Z]{2}/.test(label) || !/\s/.test(label.trim()) ? label : label.charAt(0) + label.slice(1).toLowerCase());

/** The copied header's menu: `{ items, cta }`. The main menu is the top-level list with the most entries. */
export function copiedHeaderMenu(header) {
  const tree = htmlTree(header);
  const lists = find(tree, (n) => (n.tag === "ul" || n.tag === "ol") && !insideTag(n, ["ul", "ol"]));
  const entries = (list) =>
    list.children.filter((li) => li.tag === "li").map((li) => {
      const own = find(li, (n) => n.tag === "a" && !insideTag(n, ["ul", "ol"], li))[0];
      return { li, link: own ? anchorLink(own) : null };
    }).filter((e) => e.link || find(e.li, (n) => n.tag === "a").length);
  let menu = null;
  let best = 1;
  for (const list of lists) {
    const count = entries(list).length;
    if (count > best) {
      menu = list;
      best = count;
    }
  }
  const items = [];
  if (menu) {
    for (const { li, link } of entries(menu)) {
      const children = [];
      const seen = new Set();
      for (const a of find(li, (n) => n.tag === "a" && insideTag(n, ["ul", "ol"], li))) {
        const child = anchorLink(a);
        if (!child || child.url.startsWith("#") || seen.has(child.url + child.label)) continue;
        if (link && child.url === link.url && child.label === link.label) continue;
        seen.add(child.url + child.label);
        children.push({ label: sentence(child.label), url: child.url });
      }
      const label = link?.label ?? clean(textOf(li)).slice(0, 60);
      if (!label) continue;
      const url = link && !link.url.startsWith("#") ? link.url : undefined;
      if (!url && !children.length) continue;
      items.push({ label: sentence(label), ...(url ? { url } : {}), ...(children.length ? { children: children.slice(0, LIMITS.children) } : {}) });
    }
  }
  // The button: a link outside every list (the logo, a search box and the phone menu are in lists or
  // have no words), preferring one styled as a button.
  const loose = find(tree, (n) => n.tag === "a" && !insideTag(n, ["ul", "ol", "nav"]) && !(menu && within(n, menu)))
    .map((a) => ({ a, link: anchorLink(a) }))
    .filter(({ link }) => link && link.label.length <= 40 && !/^(\/|#.*|\/index\.html)$/.test(link.url));
  const pick = loose.find(({ a }) => /btn|button|cta/i.test(attrValue(a, "class") ?? "")) ?? loose.at(-1);
  return { items: items.slice(0, LIMITS.items), cta: pick ? { label: sentence(pick.link.label), url: pick.link.url } : null };
}

/** The nearest short text before `node` (a heading), looking at earlier siblings, then going up. */
function headingBefore(node, levels = 4) {
  for (let at = node, depth = 0; at.parent && depth <= levels; at = at.parent, depth++) {
    const siblings = at.parent.children;
    for (let i = siblings.indexOf(at) - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling.tag && find(sibling, (c) => c.tag === "a" && !String(attrValue(c, "href") ?? "").startsWith("#")).length) return "";
      const words = clean(textOf(sibling));
      if (words.length <= 40 && (words.match(/\p{L}/gu) ?? []).length >= 3) return words;
      if (words.length > 40) return "";
    }
  }
  return "";
}

/** The copied footer's link columns `[{ title, links }]` and legal links. */
export function copiedFooterMenu(footer) {
  const tree = htmlTree(footer);
  // Links are grouped by what holds them: their list, or the box they sit in side by side.
  const groups = new Map();
  for (const a of find(tree, (n) => n.tag === "a")) {
    const link = anchorLink(a);
    // Phone numbers and email addresses are the site's contact details (Business info), not menu links.
    if (!link || link.url.startsWith("#") || /^(tel|mailto|sms):/i.test(link.url)) continue;
    let holder = a.parent;
    if (holder.tag === "li") holder = holder.parent;
    else if (holder.parent && holder.children.filter((c) => c.tag).length === 1 && !["ul", "ol", "nav"].includes(holder.tag)) {
      // A link wrapped on its own (<p><a></p>, <div><a></div>) sits in the box around that wrapper.
      const box = holder.parent;
      if (box.children.filter((c) => c.tag).length > 1) holder = box;
    }
    if (!groups.has(holder)) groups.set(holder, []);
    groups.get(holder).push({ a, link });
  }
  const columns = [];
  const seen = new Set();
  const inColumns = new Set();
  for (const [holder, members] of groups) {
    if (members.length < 2) continue;
    const first = members[0].a;
    const start = ["ul", "ol"].includes(holder.tag) ? holder : first.parent === holder ? first : first.parent;
    const title = headingBefore(start);
    const key = members.map((m) => m.link.url).join(" ");
    if (!title || seen.has(key)) continue;
    seen.add(key);
    for (const m of members) inColumns.add(m.link.url);
    columns.push({ title: sentence(title), links: members.slice(0, LIMITS.links).map(({ link }) => ({ label: sentence(link.label), url: link.url })) });
  }
  const legal = [];
  const legalSeen = new Set();
  for (const a of find(tree, (n) => n.tag === "a")) {
    const link = anchorLink(a);
    if (!link || legalSeen.has(link.url) || inColumns.has(link.url)) continue;
    if (!/privacy|terms|cookie|legal|imprint|accessibility|disclaimer/i.test(`${link.label} ${link.url}`)) continue;
    legalSeen.add(link.url);
    legal.push({ label: sentence(link.label), url: link.url });
  }
  return { columns: columns.slice(0, LIMITS.columns), legal: legal.slice(0, LIMITS.legal) };
}

/**
 * Writes the copied header and footer's menus into navigation.json (see above). For a caller holding
 * the workspace's lock. Returns what it wrote (`{ items, cta, footer, legal }`), or null when there was
 * nothing to do. Never throws.
 */
export async function adoptCopiedMenu(dir) {
  try {
    const header = (await readText(path.join(dir, "templates/partials/header.html"))) ?? "";
    const footer = (await readText(path.join(dir, "templates/partials/footer.html"))) ?? "";
    const strip = (html) => html.replace(/<template\b[\s\S]*?<\/template\s*>/gi, "");
    const headerCopied = header.includes(COPIED_MARK);
    const footerCopied = footer.includes(COPIED_MARK);
    if (!headerCopied && !footerCopied) return null;
    const id = /data-chrome-id\s*=\s*["']([^"']+)["']/.exec(headerCopied ? header : footer)?.[1] ?? "copied";
    const { text: current, data } = await readJsonFile(dir, NAV_FILE, {});
    if (data.copiedMenu === id) return null;
    const { data: site } = await readJsonFile(dir, "site.config.json");
    const collections = new Set(Object.keys(site.collections ?? {}));
    const keep = (list, check) =>
      list.flatMap((item, i) => {
        try {
          return [check(item, i)];
        } catch {
          return [];
        }
      });

    const next = { ...data };
    const wrote = {};
    if (headerCopied) {
      const menu = copiedHeaderMenu(strip(header));
      if (menu.items.length) {
        const items = keep(menu.items, (item, i) => headerItem(item, `Header item ${i + 1}`, collections));
        let cta = null;
        try {
          cta = button(menu.cta);
        } catch {
          cta = null;
        }
        next.header = { ...(isObject(data.header) ? data.header : {}), items, cta };
        Object.assign(wrote, { items, cta });
      }
    }
    if (footerCopied) {
      const menu = copiedFooterMenu(strip(footer));
      // The template's starter legal links (Privacy, Terms, Sitemap) aren't the business's.
      const legal = keep(menu.legal, (item, i) => plainLink(item, `Legal link ${i + 1}`));
      next.legal = legal;
      wrote.legal = legal;
      if (menu.columns.length) {
        const columns = keep(menu.columns, (column, i) => footerColumn(column, `Footer column ${i + 1}`, collections));
        next.footer = columns;
        wrote.footer = columns;
      }
    }
    if (!Object.keys(wrote).length) return null;
    next.copiedMenu = id;
    const newline = current?.includes("\r\n") ? "\r\n" : "\n";
    const output = `${JSON.stringify(next, null, 2)}\n`.replace(/\n/g, newline);
    if (Buffer.byteLength(output) > MAX_BYTES) return null;
    const file = path.join(dir, NAV_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, output);
    return wrote;
  } catch {
    return null;
  }
}
