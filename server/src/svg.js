import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// Images Claude draws (the assistant's create_image): SVG markup, checked against an allowlist of
// drawing elements and attributes before it's stored in the site, where it's public. Anything else
// is refused rather than cleaned up, so what's saved is exactly what was shown on the card. No
// scripts, links, styles sheets, external images or fonts: shapes, text, gradients and filters.

export const DRAWN_DIR = "assets/img/drawn";
export const MAX_SVG_CHARS = 100_000;

const ELEMENTS = new Set([
  "svg", "g", "defs", "title", "desc", "symbol", "use",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask",
  "filter", "feBlend", "feColorMatrix", "feComposite", "feDropShadow", "feFlood", "feGaussianBlur",
  "feMerge", "feMergeNode", "feMorphology", "feOffset",
]);
// Attribute names: plain presentation and geometry ones, plus the namespaces and references below.
const ATTRIBUTE = /^(?:[a-zA-Z][a-zA-Z0-9-]*|xmlns(?::xlink)?|xlink:href|xml:space|xml:lang)$/;
// References may only point inside the image (#id).
const REFERENCE = new Set(["href", "xlink:href"]);
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

/** Why a value can't be used (it could load or run something), or null. */
function unsafeValue(value) {
  if (/javascript:|vbscript:|data:|expression\s*\(|@import|behavior\s*:|-moz-binding/i.test(value)) return "it links to code or data";
  // url(…) only for the image's own gradients, patterns, clips and filters.
  if (/url\s*\(\s*['"]?(?!#)/i.test(value)) return "it loads something from outside the image";
  return null;
}

/**
 * Checks Claude's SVG: `{ svg }` (trimmed, without an XML declaration, with the SVG namespace) or
 * `{ problem }`, a reason to send back so it can draw it again.
 */
export function checkSvg(input) {
  if (typeof input !== "string" || !input.trim()) return { problem: "it's empty" };
  if (input.length > MAX_SVG_CHARS) return { problem: `it's over ${MAX_SVG_CHARS.toLocaleString("en")} characters` };
  let text = input
    .trim()
    .replace(/^<\?xml[^>]*\?>\s*/i, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  if (/<!|<\?/.test(text)) return { problem: "it has a DOCTYPE, CDATA or processing instruction" };

  const open = [];
  let root = null;
  let last = 0;
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", last)) {
    const between = text.slice(last, at);
    if (ENTITY.test(between)) return { problem: "it uses an entity other than &amp; &lt; &gt; &quot; &apos;" };
    if (!open.length && between.trim()) return { problem: "it has text outside the <svg> element" };
    TAG.lastIndex = at;
    const match = TAG.exec(text);
    if (!match) return { problem: `it has a malformed tag near "${text.slice(at, at + 30)}"` };
    const [whole, closing, name, attributes, selfClosing] = match;
    if (!ELEMENTS.has(name)) return { problem: `<${name}> isn't allowed (only shapes, text, gradients, patterns, clips, masks and filters)` };
    if (closing) {
      if (open.pop() !== name) return { problem: `</${name}> doesn't match the element it closes` };
    } else {
      if (!root) {
        if (name !== "svg") return { problem: "it must start with <svg>" };
        root = { attributes };
      } else if (!open.length) {
        return { problem: "it has more than one top-level element" };
      }
      for (const [, attr, double, single] of attributes.matchAll(ATTR)) {
        const value = double ?? single;
        if (value === undefined) return { problem: `the attribute ${attr} has no quoted value` };
        if (!ATTRIBUTE.test(attr) || /^on/i.test(attr)) return { problem: `the attribute ${attr} isn't allowed` };
        if (REFERENCE.has(attr) && !value.startsWith("#")) return { problem: `${attr} may only point inside the image (#id)` };
        if (ENTITY.test(value)) return { problem: "it uses an entity other than &amp; &lt; &gt; &quot; &apos;" };
        const problem = unsafeValue(value);
        if (problem) return { problem: `the attribute ${attr}: ${problem}` };
      }
      if (!selfClosing) open.push(name);
    }
    last = at + whole.length;
    if (!open.length) break;
  }
  if (!root) return { problem: "it has no <svg> element" };
  if (open.length) return { problem: `<${open.at(-1)}> is never closed` };
  if (text.slice(last).trim()) return { problem: "it has content after </svg>" };
  if (!/\sviewBox\s*=/.test(root.attributes)) return { problem: "the <svg> needs a viewBox, so it scales to any size" };

  text = text.slice(0, last);
  // Served as a file, an SVG without its namespace shows as plain text.
  if (!/\sxmlns\s*=/.test(root.attributes)) text = text.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg: text };
}

/** Width over height from a checked SVG's viewBox, or null when it can't be read. */
export function svgAspect(svg) {
  const viewBox = /^<svg\b[^>]*\sviewBox\s*=\s*["']([^"']*)["']/.exec(svg)?.[1];
  const [, , width, height] = (viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

/** An image's preview for the assistant's card: a data: URL of the checked SVG. */
export const svgPreview = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

/** A file name for a drawn image: lowercase letters, numbers and dashes. */
export function drawnName(name) {
  return (
    String(name ?? "")
      .replace(/\.svg$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image"
  );
}

/**
 * Saves a drawn image to assets/img/drawn/<name>.svg (numbered when the name is taken), checking it
 * again first: it was stored with the proposal in between. Returns its path in the repo.
 */
export async function saveDrawnImage(key, name, markup) {
  const { svg, problem } = checkSvg(markup);
  if (problem) throw new WorkspaceError(`The image can't be saved: ${problem}.`, 400);
  const base = drawnName(name);
  const release = acquire(key, "saving an image");
  try {
    const dir = path.join(workspaceDir(key), DRAWN_DIR);
    await fs.mkdir(dir, { recursive: true });
    let file = `${base}.svg`;
    for (let n = 2; existsSync(path.join(dir, file)); n++) file = `${base}-${n}.svg`;
    await fs.writeFile(path.join(dir, file), `${svg}\n`);
    return `${DRAWN_DIR}/${file}`;
  } finally {
    release();
  }
}
