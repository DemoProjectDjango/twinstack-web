import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";
import { webLink, whatsappLink } from "./links.js";

// The site's static information: site-wide facts that appear on many pages,
// kept in site.config.json and content/data/*.json. The UI edits the values;
// saving only accepts data with the same structure (same fields, same types)
// the file already has, so the site's templates keep working.

const SECTIONS = [
  {
    id: "site",
    label: "Site details",
    file: "site.config.json",
    description: "Name, taglines, description, contact details, social links and search engine settings (seo: the title format, X handle and verification codes), used in the header, footer and page metadata.",
    // Collections, deploy and automation settings stay out of reach: changing them can break the build.
    keys: ["name", "shortName", "tagline", "footerTagline", "description", "contact", "social", "seo"],
  },
  {
    id: "company",
    label: "Company facts",
    file: "content/data/company.json",
    description: "Headline stats, clouds, integrations and process steps shown across many pages.",
    items: { stats: { value: "", label: "" }, clouds: "", integrations: "", process: { title: "", body: "", mark: "" } },
  },
  {
    id: "faq",
    label: "FAQ",
    file: "content/data/faq.json",
    description: "Questions and answers. Pages can show all of them or filter by topic.",
    items: { items: { topic: "", question: "", answer: "" } },
  },
  {
    id: "testimonials",
    label: "Testimonials",
    file: "content/data/testimonials.json",
    description: "Client quotes, shown wherever the site includes its testimonials.",
    items: { items: { quote: "", industry: "", meta: "" } },
  },
  {
    id: "home",
    label: "Homepage sections",
    file: "content/data/home.json",
    description: "Which sections the homepage shows, in order, and their headings and text. \"partial\" names the template each section uses.",
  },
  { id: "redirects", label: "Redirects", file: "content/data/redirects.json", description: "Old URLs and where they now point." },
];

const MAX_BYTES = 256 * 1024;

// Old web addresses (content/data/redirects.json) always have the same three fields, whatever the
// file holds: an old address, a new one and whether it's on. Older files carry an HTTP "status"
// (301…) instead, which owners don't understand and GitHub Pages never sends: such a rule reads as
// active, and saving writes the three fields. The template's build makes a page at each active old
// address that sends visitors on (GitHub Pages ignores a _redirects file). The fixed shape also lets a
// new site add its first one: its file starts as an empty list, which said nothing about its items.
const REDIRECT_SHAPE = [{ from: "", to: "", active: true }];
const MAX_REDIRECTS = 500;

/** The redirects as the screen shows them: { from, to, active } each. */
function redirectsView(data) {
  return (Array.isArray(data) ? data : []).filter(isObject).map((rule) => ({ from: String(rule.from ?? ""), to: String(rule.to ?? ""), active: rule.active !== false }));
}

/** What's wrong with a new list of redirects, in words, or null. */
function redirectsError(next) {
  if (!Array.isArray(next)) return "The old web addresses must be a list.";
  if (next.length > MAX_REDIRECTS) return `Add at most ${MAX_REDIRECTS} old web addresses.`;
  const seen = new Set();
  for (const [i, rule] of next.entries()) {
    const line = `Line ${i + 1}`;
    if (!isObject(rule)) return `${line} needs an old address and a new one.`;
    for (const key of Object.keys(rule)) if (!["from", "to", "active"].includes(key)) return `${line}: "${key}" isn't a field this file has.`;
    const from = typeof rule.from === "string" ? rule.from.trim() : null;
    const to = typeof rule.to === "string" ? rule.to.trim() : null;
    if (!from || !/^\/[^\s?#"'<>]*$/.test(from) || from.split("/").includes("..")) return `${line}: the old address must start with / (like /old-page.html), without spaces.`;
    if (from === "/") return `${line}: the homepage can't be sent somewhere else.`;
    if (!to || !(/^\/[^\s"'<>]*$/.test(to) || /^https?:\/\/[^\s"'<>]+$/i.test(to))) return `${line}: the new address must start with / or https://.`;
    if (to === from) return `${line} sends the address to itself.`;
    if (rule.active !== undefined && typeof rule.active !== "boolean") return `${line}: Active must be yes or no.`;
    if (seen.has(from)) return `${line}: ${from} is listed twice.`;
    seen.add(from);
  }
  return null;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function pick(data, keys) {
  return keys ? Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])) : data;
}

/**
 * The structure saves are checked against: the data, with an example item in each empty top-level
 * list the section knows the items of (`items`). The template ships those lists empty, and an empty
 * list on its own says nothing about what may be added to it.
 */
function shapeOf(section, data) {
  if (!section.items || !isObject(data)) return data;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, Array.isArray(value) && !value.length && key in section.items ? [section.items[key]] : value]),
  );
}

/** What each item of a list looks like: the union of its items' fields. */
function itemTemplate(list) {
  if (!list.length) return undefined;
  if (!list.every(isObject)) return list[0];
  const template = {};
  for (const item of list) for (const [key, value] of Object.entries(item)) if (!(key in template)) template[key] = value;
  return template;
}

/** A description of the first way `next` doesn't match the shape of `original`, or null. */
function shapeError(original, next, at) {
  if (Array.isArray(original)) {
    if (!Array.isArray(next)) return `${at} must be a list.`;
    const template = itemTemplate(original);
    for (const [i, item] of next.entries()) {
      const error =
        template === undefined
          ? isObject(item) || Array.isArray(item)
            ? `${at} item ${i + 1} must be a single value.`
            : null
          : shapeError(template, item, `${at} item ${i + 1}`);
      if (error) return error;
    }
    return null;
  }
  if (isObject(original)) {
    if (!isObject(next)) return `${at} must be a group of fields.`;
    for (const [key, value] of Object.entries(next)) {
      if (!(key in original)) return `${at}: "${key}" isn't a field this file has.`;
      const error = shapeError(original[key], value, at ? `${at} › ${key}` : key);
      if (error) return error;
    }
    return null;
  }
  if (original === null) return next === null || typeof next === "string" ? null : `${at} must be text.`;
  return typeof next === typeof original ? null : `${at} must be ${typeof original === "number" ? "a number" : typeof original === "boolean" ? "yes/no" : "text"}.`;
}

async function readSection(dir, section) {
  const file = path.join(dir, section.file);
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { text: null, data: null };
    throw err;
  }
  try {
    return { text, data: JSON.parse(text) };
  } catch (err) {
    throw new WorkspaceError(`${section.file} isn't valid JSON (${err.message}). Fix it in the repository first.`, 422);
  }
}

export async function getStaticInfo(key) {
  const dir = workspaceDir(key);
  const sections = [];
  for (const section of SECTIONS) {
    const { data } = await readSection(dir, section);
    if (data === null) continue;
    sections.push({
      id: section.id,
      label: section.label,
      file: section.file,
      description: section.description,
      data: section.id === "redirects" ? redirectsView(data) : pick(data, section.keys),
      shape: section.id === "redirects" ? REDIRECT_SHAPE : shapeOf(section, pick(data, section.keys)),
    });
  }
  return { sections };
}

/**
 * A section's new data as given. Claude's tool calls sometimes send it as JSON text rather than
 * the object or list itself, which is read here (an action stored that way still applies).
 */
function parsedData(next) {
  if (typeof next !== "string") return next;
  try {
    const parsed = JSON.parse(next);
    return parsed !== null && typeof parsed === "object" ? parsed : next;
  } catch {
    return next;
  }
}

/** What's wrong with `next` as a section's data, in words, or null. A top-level error has no field name. */
function sectionError(section, data, next) {
  if (section.id === "redirects") return redirectsError(next);
  const error = shapeError(shapeOf(section, pick(data, section.keys)), next, "");
  return error ? error.replace(/^: /, "").replace(/^ must/, "The data must") : null;
}

/** What's wrong with `next` for section `id` (null when it would save), without saving it. */
export async function checkStaticInfo(key, id, next) {
  const section = SECTIONS.find((s) => s.id === id);
  if (!section) return "Unknown section.";
  const { data } = await readSection(workspaceDir(key), section);
  if (data === null) return `${section.file} doesn't exist.`;
  return sectionError(section, data, withLinks(id, parsedData(next)));
}

/**
 * The site details' links as people write them (links.js): social profiles and the booking page get
 * https:// ("instagram.com/x" would otherwise be a link relative to the page), and a WhatsApp number
 * becomes its wa.me chat link. The footer uses them as they are.
 */
function withLinks(id, next) {
  if (id !== "site" || !next || typeof next !== "object" || Array.isArray(next)) return next;
  const out = { ...next };
  if (out.social && typeof out.social === "object") {
    out.social = Object.fromEntries(Object.entries(out.social).map(([k, v]) => [k, typeof v === "string" ? webLink(v) : v]));
  }
  if (out.contact && typeof out.contact === "object") {
    const contact = { ...out.contact };
    if (typeof contact.bookingUrl === "string") contact.bookingUrl = webLink(contact.bookingUrl);
    if (typeof contact.whatsappUrl === "string") contact.whatsappUrl = whatsappLink(contact.whatsappUrl);
    out.contact = contact;
  }
  return out;
}

/** A section's file and label, for the work log; null for an unknown id. */
export function staticInfoSection(id) {
  const section = SECTIONS.find((s) => s.id === id);
  return section ? { file: section.file, label: section.label } : null;
}

export async function saveStaticInfo(key, id, value) {
  const section = SECTIONS.find((s) => s.id === id);
  if (!section) throw new WorkspaceError("Unknown section.", 404);
  if (value === undefined) throw new WorkspaceError("Nothing to save.", 400);
  const next = withLinks(id, parsedData(value));

  const release = acquire(key, `saving ${section.file}`);
  try {
    const dir = workspaceDir(key);
    const { text, data } = await readSection(dir, section);
    if (data === null) throw new WorkspaceError(`${section.file} doesn't exist.`, 404);

    const error = sectionError(section, data, next);
    if (error) throw new WorkspaceError(error, 400);

    // Only the picked keys change; everything else (and key order) is kept.
    const merged =
      section.id === "redirects"
        ? next.map((rule) => ({ from: rule.from.trim(), to: rule.to.trim(), active: rule.active !== false }))
        : section.keys ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, section.keys.includes(k) && k in next ? next[k] : v])) : next;
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const output = `${JSON.stringify(merged, null, 2)}\n`.replace(/\n/g, newline);
    if (Buffer.byteLength(output) > MAX_BYTES) throw new WorkspaceError("That's too much data for one file.", 400);
    await fs.writeFile(path.join(dir, section.file), output);
  } finally {
    release();
  }
  return getStaticInfo(key);
}
