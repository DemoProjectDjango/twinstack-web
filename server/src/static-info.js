import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// The site's static information: site-wide facts that appear on many pages,
// kept in site.config.json and content/data/*.json. The UI edits the values;
// saving only accepts data with the same structure (same fields, same types)
// the file already has, so the site's templates keep working.

const SECTIONS = [
  {
    id: "site",
    label: "Site details",
    file: "site.config.json",
    description: "Name, taglines, description, contact details and social links, used in the header, footer and page metadata.",
    // Collections, deploy and automation settings stay out of reach: changing them can break the build.
    keys: ["name", "shortName", "tagline", "footerTagline", "description", "contact", "social"],
  },
  {
    id: "company",
    label: "Company facts",
    file: "content/data/company.json",
    description: "Headline stats, clouds, integrations and process steps shown across many pages.",
  },
  { id: "faq", label: "FAQ", file: "content/data/faq.json", description: "Questions and answers. Pages can show all of them or filter by topic." },
  { id: "testimonials", label: "Testimonials", file: "content/data/testimonials.json", description: "Client quotes shown on the homepage." },
  {
    id: "home",
    label: "Homepage sections",
    file: "content/data/home.json",
    description: "Which sections the homepage shows, in order, and their headings and text. \"partial\" names the template each section uses.",
  },
  { id: "redirects", label: "Redirects", file: "content/data/redirects.json", description: "Old URLs and where they now point." },
];

const MAX_BYTES = 256 * 1024;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function pick(data, keys) {
  return keys ? Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])) : data;
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
      data: pick(data, section.keys),
    });
  }
  return { sections };
}

export async function saveStaticInfo(key, id, next) {
  const section = SECTIONS.find((s) => s.id === id);
  if (!section) throw new WorkspaceError("Unknown section.", 404);
  if (next === undefined) throw new WorkspaceError("Nothing to save.", 400);

  const release = acquire(key, `saving ${section.file}`);
  try {
    const dir = workspaceDir(key);
    const { text, data } = await readSection(dir, section);
    if (data === null) throw new WorkspaceError(`${section.file} doesn't exist.`, 404);

    const error = shapeError(pick(data, section.keys), next, "");
    if (error) throw new WorkspaceError(error.replace(/^: /, ""), 400);

    // Only the picked keys change; everything else (and key order) is kept.
    const merged = section.keys ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, section.keys.includes(k) && k in next ? next[k] : v])) : next;
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const output = `${JSON.stringify(merged, null, 2)}\n`.replace(/\n/g, newline);
    if (Buffer.byteLength(output) > MAX_BYTES) throw new WorkspaceError("That's too much data for one file.", 400);
    await fs.writeFile(path.join(dir, section.file), output);
  } finally {
    release();
  }
  return getStaticInfo(key);
}
