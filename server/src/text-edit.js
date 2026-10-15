import path from "node:path";
import fs from "node:fs/promises";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";
import { inside, readText } from "./site-files.js";
import { sitePages } from "./navigation.js";

// Text typed straight into the preview (the Home screen's "Edit text"): the preview's script
// (preview/inline-edit.js) sends the clicked element's text before and after, and this finds that
// text in the page's own file and changes only the characters that changed. No Claude, no build:
// the automatic preview rebuilds afterwards like after any change.
//
// The page's file is read as the visitor sees it: tags, HTML comments, template expressions
// ({{ … }}), markdown's bold markers, link syntax and heading markers are left out, and entities
// are decoded, with every visible character remembering where it came from. Text the page's file
// doesn't have is looked for in the fields that hold text (storedField below), and what neither
// has (the design's own words) is refused instead of guessed.

const MAX_TEXT = 5000;
// When the whole element isn't found as one run (it has a link or a template value in it), the
// match around the change must still be this long, or the whole element when it's shorter.
const MIN_CONTEXT = 24;
const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

const fail = (message, status = 422) => {
  throw new WorkspaceError(message, status);
};

/** Every address a page's URL is served at in the preview (/about.html is also /about). */
function addressesOf(url) {
  if (url.endsWith("/")) return [url, `${url}index.html`];
  if (url.endsWith(".html")) return [url, url.slice(0, -".html".length)];
  return [url, `${url}/`, `${url}/index.html`, `${url}.html`];
}

/** The page file that builds the address shown in the preview (or null), and every page. */
async function pageAt(dir, address) {
  let site;
  try {
    site = JSON.parse((await readText(path.join(dir, "site.config.json"))) ?? "{}");
  } catch {
    return { page: null, pages: [] };
  }
  const pages = await sitePages(dir, site).catch(() => []);
  return { page: pages.find((page) => typeof page.url === "string" && addressesOf(page.url).includes(address)) ?? null, pages };
}

/**
 * The visible text of a page's body: `text` (whitespace as spaces) and, for each of its characters,
 * the range of the source it came from (`from[i]`..`to[i]`).
 */
export function visibleText(source, start = 0, fields = {}) {
  const chars = [];
  const from = [];
  const to = [];
  const push = (char, a, b) => {
    chars.push(/\s/.test(char) ? " " : char);
    from.push(a);
    to.push(b);
  };
  const skip = (pattern, i) => {
    pattern.lastIndex = i;
    const m = pattern.exec(source);
    return m ? i + m[0].length : -1;
  };
  const COMMENT = /<!--[\s\S]*?(?:-->|$)/y;
  const HIDDEN = /<(script|style|template|svg)\b[\s\S]*?<\/\1\s*>/iy;
  const TAG = /<\/?[a-zA-Z][^>]*>/y;
  const EXPRESSION = /\{\{[\s\S]*?\}\}/y;
  const ENTITY = /&(#\d{1,7}|#x[\da-fA-F]{1,6}|[a-zA-Z]+);/y;
  const LINK_START = /\[(?=[^\]\n]*\]\()/y;
  const LINK_END = /\]\([^)\s]*(?:\s+"[^"]*")?\)/y;
  const HEADING = /#{1,6}[ \t]+/y;

  let i = start;
  while (i < source.length) {
    const char = source[i];
    let next = -1;
    if (char === "\r") next = i + 1;
    else if (char === "<") next = Math.max(skip(COMMENT, i), skip(HIDDEN, i), skip(TAG, i));
    else if (char === "{" && source[i + 1] === "{") {
      next = skip(EXPRESSION, i);
      // {{ page.title }} shows the frontmatter's title: its characters are the frontmatter's.
      const field = next > i ? fields[source.slice(i + 2, next - 2).trim()] : null;
      if (field) for (let k = field.from; k < field.to; k++) push(source[k], k, k + 1);
    }
    else if (char === "[") next = skip(LINK_START, i);
    else if (char === "]") next = skip(LINK_END, i);
    else if (char === "*" && source[i + 1] === "*") next = i + (source[i + 2] === "*" ? 3 : 2);
    else if (char === "#" && (i === start || source[i - 1] === "\n")) next = skip(HEADING, i);
    else if (char === "&") {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(source);
      const name = m?.[1];
      const decoded = !name
        ? null
        : name[0] === "#"
          ? String.fromCodePoint(name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
          : ENTITIES[name.toLowerCase()];
      if (decoded) {
        // One visible character for the whole entity (an emoji's two halves both point at it).
        for (let k = 0; k < decoded.length; k++) push(decoded[k], i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    if (next > i) {
      i = next;
      continue;
    }
    push(char, i, i + 1);
    i++;
  }
  return { text: chars.join(""), from, to };
}

/** The frontmatter's one-line fields (`key: value`), with where each value is, inside any quotes. */
function frontmatterScalars(source, end) {
  const scalars = [];
  const line = /^([A-Za-z0-9_.-]+):[ \t]*(.*?)[ \t]*\r?$/gm;
  for (const m of source.slice(0, end).matchAll(line)) {
    const raw = m[2];
    const quote = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0] ? raw[0] : null;
    const from = m.index + m[0].indexOf(raw, m[1].length + 1) + (quote ? 1 : 0);
    const to = from + raw.length - (quote ? 2 : 0);
    scalars.push({ key: m[1], from, to, quote, value: source.slice(from, to) });
  }
  return scalars;
}

/** Where `title:` and `description:` keep their values, for {{ page.title }} and {{ page.description }}. */
function frontmatterFields(scalars) {
  const fields = {};
  for (const field of scalars) if (field.key === "title" || field.key === "description") fields[`page.${field.key}`] = field;
  return fields;
}

const spaced = (text) => text.replace(/\s/g, " ");
const squeezed = (text) => spaced(text).replace(/ +/g, " ").trim();

/** The characters that changed: before[start..beforeEnd] became after[start..afterEnd]. */
function changedPart(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start, beforeEnd: before.length - tail, afterEnd: after.length - tail };
}

/**
 * Where the clicked element's text is in the visible text: the visible-text position of
 * before[core..coreEnd], and whether the whole element's text was found there. `index`/`count`
 * say which of the preview's elements with exactly this text was clicked, for text the page has
 * more than once. Null when the page's body doesn't have it.
 */
function locate(visible, before, coreStart, coreEnd, { index, count }) {
  const lead = before.length - before.trimStart().length;
  const trail = before.length - before.trimEnd().length;
  const core = before.slice(coreStart, coreEnd);
  const candidates = [];
  for (let at = visible.indexOf(core); at !== -1; at = visible.indexOf(core, at + 1)) {
    let left = 0;
    while (coreStart - left > 0 && at - left > 0 && visible[at - left - 1] === before[coreStart - left - 1]) left++;
    let right = 0;
    const end = at + core.length;
    while (coreEnd + right < before.length && end + right < visible.length && visible[end + right] === before[coreEnd + right]) right++;
    candidates.push({ at, covered: left + core.length + right, whole: coreStart - left <= lead && coreEnd + right >= before.length - trail });
    if (candidates.length > 20000) break;
  }

  const whole = candidates.filter((c) => c.whole);
  if (whole.length === 1) return { at: whole[0].at, whole: true };
  if (whole.length > 1) {
    if (Number.isInteger(index) && count === whole.length && index >= 0 && index < count) return { at: whole[index].at, whole: true };
    fail("That text is on this page more than once, so it can't be told apart here. Change it in the page's text on the Pages screen.");
  }
  const best = Math.max(0, ...candidates.map((c) => c.covered));
  const top = candidates.filter((c) => c.covered === best);
  if (top.length === 1 && best >= Math.min(MIN_CONTEXT, before.trim().length)) return { at: top[0].at, whole: false };
  return null;
}

/** Text typed into the page as it's stored: one line, and nothing the page would read as code. */
function typedText(text) {
  const line = text.replace(/[\r\n]+/g, " ").replace(/ /g, " ");
  if (/[<>`]|\{\{|\}\}/.test(line)) {
    fail("Text typed in the preview can't contain <, >, ` or {{ }}. Use the page's text on the Pages screen for those.", 400);
  }
  if (/&(#\d+|#x[\da-f]+|[a-z]+);/i.test(line)) fail("Write the character itself rather than an HTML code like &amp;.", 400);
  return line;
}

const textField = (value, label) => {
  if (typeof value !== "string" || value.length > MAX_TEXT) fail(`${label} must be text of at most ${MAX_TEXT} characters.`, 400);
  return value;
};

/* ------------------------------------------- text kept outside the page's body */

// Much of what a page shows isn't in its body: older layouts draw the hero from the page's
// frontmatter (heroHeading, heroText, kicker), section headings from content/data/*.json, button
// labels from site.config.json, and a listing's cards from the other pages' frontmatter. When the
// body doesn't have the clicked element's whole text, a field whose value is exactly that text is
// changed instead, as long as only one such field exists.

// Frontmatter fields that never show as text: addresses, switches, dates and file names.
const NOT_TEXT = new Set([
  "url", "slug", "layout", "date", "updated", "order", "menu", "draft", "stylesheet", "canonical",
  "ogImage", "image", "noindex", "navHidden", "collection", "relatedProduct", "parentUrl",
]);
// Site-wide data the page isn't the place to change: the menus and the redirects.
const NOT_SHARED_TEXT = new Set(["content/data/navigation.json", "content/data/redirects.json"]);
const SEO_FIELDS = new Set(["title", "description"]);

const looksLikeText = (value) => /\p{L}/u.test(value) && !/^(\/|https?:|mailto:|tel:|#)/.test(value.trim());

/** The JSON file's string values (never its keys), with where each literal is. */
function jsonStrings(text) {
  const strings = [];
  for (const m of text.matchAll(/"((?:[^"\\\r\n]|\\.)*)"(\s*:)?/g)) {
    if (m[2]) continue;
    try {
      strings.push({ from: m.index, to: m.index + m[1].length + 2, value: JSON.parse(`"${m[1]}"`) });
    } catch {
      // Not a JSON string after all.
    }
  }
  return strings;
}

/** A new frontmatter value as the site's parser reads it back: quoted when it would otherwise become a number, a list or lose its quotes. */
function frontmatterValue(text, quote) {
  const needsQuotes = quote || /^["'[{]/.test(text) || /^(true|false|-?\d+(\.\d+)?)$/i.test(text);
  if (!needsQuotes) return text;
  for (const q of quote ? [quote, quote === '"' ? "'" : '"'] : ['"', "'"]) if (!text.includes(q)) return `${q}${text}${q}`;
  fail("That text can't contain both kinds of quote marks here. Change it in the page settings on the Pages screen.", 400);
}

/** The field holding exactly `text`: on this page first, then in the site's data, then on another page. */
async function storedField(dir, page, source, scalars, text, pages) {
  const wanted = squeezed(text);
  const same = (value) => looksLikeText(value) && squeezed(value) === wanted;

  // This page's own fields, the hero's heading before the title it may repeat.
  const own = scalars.filter((f) => !NOT_TEXT.has(f.key) && same(f.value));
  const ownText = own.filter((f) => !SEO_FIELDS.has(f.key));
  const pick = ownText.length ? ownText : own;
  if (pick.length === 1) return { file: page.file, source, frontmatter: pick[0], where: "page", label: pick[0].key };
  if (pick.length > 1) fail("That text is in more than one of this page's settings, so it's not clear which to change. Change it on the Pages screen.");

  const found = [];
  const dataFiles = [
    "site.config.json",
    ...(await fs.readdir(path.join(dir, "content/data")).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .map((name) => `content/data/${name}`)
      .filter((file) => !NOT_SHARED_TEXT.has(file)),
  ];
  for (const file of dataFiles) {
    const text = await readText(path.join(dir, file));
    if (text === null) continue;
    for (const s of jsonStrings(text)) {
      if (same(s.value)) found.push({ file, source: text, json: s, where: file === "site.config.json" ? "details" : "shared" });
    }
  }
  for (const other of pages) {
    if (found.length > 1) break;
    if (other.file === page.file) continue;
    const text = await readText(inside(dir, other.file));
    if (text === null) continue;
    const end = FRONTMATTER.exec(text)?.[0].length ?? 0;
    const fields = frontmatterScalars(text, end).filter((f) => !NOT_TEXT.has(f.key) && same(f.value));
    // A card shows the page's title or description, whatever else repeats it.
    const shown = fields.filter((f) => SEO_FIELDS.has(f.key));
    for (const f of shown.length ? shown : fields) {
      found.push({ file: other.file, source: text, frontmatter: f, where: "other", label: f.key, title: other.title });
    }
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) fail("That text is stored in more than one place on your site, so it's not clear which to change. Change it where it's kept, or ask Claude.");
  return null;
}

/** Writes the new text into the field storedField found. */
async function writeStored(dir, stored, now) {
  const value = typedText(now.trim());
  let from;
  let to;
  let written;
  if (stored.json) {
    [from, to, written] = [stored.json.from, stored.json.to, JSON.stringify(value)];
  } else {
    const field = stored.frontmatter;
    // A quoted value is replaced with its quotes, which frontmatterValue writes again.
    [from, to] = field.quote ? [field.from - 1, field.to + 1] : [field.from, field.to];
    written = frontmatterValue(value, field.quote);
  }
  const next = stored.source.slice(0, from) + written + stored.source.slice(to);
  if (stored.json) JSON.parse(next);
  await fs.writeFile(inside(dir, stored.file), next);
}

/**
 * Applies one text change typed in the preview to the page at `address` (the path the preview
 * showed, "/about.html"). Returns the changed file and where the text was kept (`where`: "page"
 * for the page itself, "shared" for the site's data, "details" for its details, "other" for
 * another page's `label` field, that page being `title`), or `{ file: null }` when nothing changed.
 */
export async function editPreviewText(key, { address, before, after, index, count } = {}) {
  if (typeof address !== "string" || !address.startsWith("/") || address.length > 500) fail("Which page was that?", 400);
  const was = textField(before, "The old text");
  const now = textField(after, "The new text");
  if (!was.trim()) fail("Click some text to change it.", 400);
  if (spaced(was) === spaced(now)) return { file: null };
  if (!now.trim()) fail("Text can't be emptied here: delete it in the page's text on the Pages screen.", 400);

  const dir = workspaceDir(key);
  let decoded;
  try {
    decoded = decodeURIComponent(address);
  } catch {
    fail("Which page was that?", 400);
  }
  const { page, pages } = await pageAt(dir, decoded);
  if (!page) fail("This page isn't one of your pages (it's made by the site itself), so its text can't be changed here.");

  const release = acquire(key, `changing text on ${page.file}`);
  try {
    const target = inside(dir, page.file);
    const source = await readText(target);
    if (source === null) fail(`${page.file} no longer exists.`, 409);
    const bodyStart = FRONTMATTER.exec(source)?.[0].length ?? 0;
    const scalars = frontmatterScalars(source, bodyStart);
    const fields = frontmatterFields(scalars);
    const visible = visibleText(source, bodyStart, fields);

    const beforeText = spaced(was);
    const { start, beforeEnd, afterEnd } = changedPart(beforeText, spaced(now));
    const inserted = typedText(now.slice(start, afterEnd));
    // A pure insertion needs a character beside it to be found by.
    const [coreStart, coreEnd] = beforeEnd > start ? [start, beforeEnd] : start > 0 ? [start - 1, start] : [0, 1];
    const found = locate(visible.text, beforeText, coreStart, coreEnd, { index, count });

    // Not in the body as a whole: a field holding exactly this text wins over part of a paragraph.
    if (!found?.whole) {
      const stored = await storedField(dir, page, source, scalars, was, pages);
      if (stored) {
        await writeStored(dir, stored, now);
        return { file: stored.file, where: stored.where, label: stored.label ?? null, title: stored.title ?? null };
      }
    }
    if (!found) fail("That text isn't kept on this page or in your site's settings: it's part of the site's design. Ask Claude to change it.");

    const { at } = found;
    let from;
    let to;
    if (beforeEnd > start) {
      const first = at;
      const last = at + (beforeEnd - start) - 1;
      // The replaced characters must be one run of the file: never part of a tag, a link or bold markers.
      for (let i = first + 1; i <= last; i++) {
        if (visible.from[i] !== visible.to[i - 1] && visible.from[i] !== visible.from[i - 1]) {
          fail("That change runs across formatting (bold text, a link…). Change it a piece at a time, or in the page's text on the Pages screen.");
        }
      }
      [from, to] = [visible.from[first], visible.to[last]];
    } else {
      // Typed after a character, or (at the very start) before the first one.
      from = to = start > 0 ? visible.to[at] : visible.from[at];
    }

    // A change to the title or description shown by {{ page.title }}: keep it a valid frontmatter value.
    const field = from < bodyStart ? Object.values(fields).find((f) => from >= f.from && to <= f.to) : null;
    if (from < bodyStart && !field) fail("That change runs across formatting. Change it in the page's text on the Pages screen.");
    if (field?.quote && inserted.includes(field.quote)) fail(`The page's title can't contain ${field.quote} here. Change it in the page settings on the Pages screen.`, 400);

    await fs.writeFile(target, source.slice(0, from) + inserted + source.slice(to));
    return { file: page.file, where: "page", label: null, title: null };
  } finally {
    release();
  }
}
