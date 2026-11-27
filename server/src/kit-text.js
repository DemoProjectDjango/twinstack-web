// Small text helpers for starter kits, with no other imports, so the kits:build script can use them
// too (it runs without the server's settings).

// Search results cut a description off at about 155 characters (the template's lib/seo.js).
const DESCRIPTION_MAX = 155;

/** `text` on one line, cut at a word to fit a search result, with "…" when it was cut. */
export function searchDescription(text) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= DESCRIPTION_MAX) return line;
  const cut = line.slice(0, DESCRIPTION_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,.;:–-]+$/, "")}…`;
}

/**
 * The page `text` with frontmatter `description:` set to `description` (searchDescription'd, double
 * quoted, which the template's markdown.js `coerce` reads back), unless the page already has one or
 * there's nothing to say. Added after `title:`, else at the end of the frontmatter.
 */
export function withDescription(text, description) {
  const value = searchDescription(description);
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!value || !match || /^description:\s*\S/m.test(match[1])) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // coerce only strips the surrounding quotes (no escapes), so a straight " inside becomes a curly one.
  const line = `description: "${value.replace(/"/g, "”")}"`;
  const lines = match[1].split(/\r?\n/).filter((l) => !/^description:\s*$/.test(l));
  const at = lines.findIndex((l) => /^title:/.test(l));
  lines.splice(at >= 0 ? at + 1 : lines.length, 0, line);
  return `---${eol}${lines.join(eol)}${eol}---${text.slice(match[0].length)}`;
}
