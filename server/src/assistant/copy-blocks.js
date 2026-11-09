import { checkRepoTextWrite, readRepoText } from "../repo-files.js";
import { WorkspaceError } from "../workspace.js";

// Adds text from an attached file to the end of many site files without Claude retyping it. Claude
// names the attachment; this finds each code block and the file it belongs to, so the copy is exact
// and costs a few tokens however long the attachment is.

const MAX_BLOCKS = 500;
const REPO_PATH = /(?:^|[\s`"'(])((?:content|styles|static|assets|knowledge)\/[^\s`"')]+\.[a-z0-9]+|site\.config\.json)/i;
const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/** The text's headings and fenced code blocks, in order, each with its 1-based line. */
export function outlineOf(text) {
  const items = [];
  const lines = text.split(/\r?\n/);
  let fence = null;
  lines.forEach((line, index) => {
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence.mark[0] && mark.length >= fence.mark.length && line.trim() === mark) {
        items.push({ type: "block", line: fence.line, text: fence.body.join("\n") });
        fence = null;
      } else fence.body.push(line);
      return;
    }
    if (mark) {
      fence = { mark, line: index + 1, body: [] };
      return;
    }
    const heading = HEADING.exec(line);
    items.push(heading ? { type: "heading", line: index + 1, level: heading[1].length, text: heading[2].trim() } : { type: "text", line: index + 1, text: line });
  });
  return items;
}

/**
 * Each code block whose file is named just before it, in a heading or a line of text: { file, text, line }.
 * `section` keeps only what's under the first heading containing those words, so a code block
 * elsewhere in the attachment (a different step) is never applied by accident.
 */
export function findBlocks(text, section = null) {
  let items = outlineOf(text);
  if (section) {
    const wanted = section.toLowerCase();
    const start = items.findIndex((item) => item.type === "heading" && item.text.toLowerCase().includes(wanted));
    if (start < 0) throw new WorkspaceError(`The attachment has no heading containing "${section}".`, 400);
    const after = items.slice(start + 1);
    const end = after.findIndex((item) => item.type === "heading" && item.level <= items[start].level);
    items = end < 0 ? after : after.slice(0, end);
  }
  const blocks = [];
  let file = null;
  for (const item of items) {
    if (item.type === "block") {
      if (file) blocks.push({ file, text: item.text.trim(), line: item.line });
      file = null;
    } else {
      const named = REPO_PATH.exec(item.text)?.[1];
      // A heading sets the target, or clears the last one, so a file named earlier can't leak onto it.
      if (named || item.type === "heading") file = named ?? null;
    }
  }
  return blocks;
}

/** The text with `addition` after everything already there, a blank line between, in the file's own line endings. */
export function appended(before, addition) {
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  return `${before.trimEnd()}${newline}${newline}${addition.trim().replace(/\r?\n/g, newline)}${newline}`;
}

/** Why a block can't go on a page, or null: script tags left open, or structured data Google can't read. */
function blockProblem(text) {
  if ((text.match(/<script\b/gi) ?? []).length !== (text.match(/<\/script\s*>/gi) ?? []).length) return "a script tag isn't closed";
  for (const match of text.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      JSON.parse(match[1]);
    } catch (err) {
      return `its structured data isn't valid JSON (${err.message})`;
    }
  }
  return null;
}

/**
 * What adding the attachment's blocks would do, changing nothing: `ready` ({ file, content, version }),
 * `skipped` (files) and `failed` ({ file, reason }). Corrections are { file, find, replace }, for
 * fixes the owner decided on; one that matches nothing fails that block rather than being ignored.
 */
export async function planBlocks(key, text, { section = null, skipIfContains = null, corrections = [] } = {}) {
  const blocks = findBlocks(text, section);
  if (!blocks.length) throw new WorkspaceError("No code block in the attachment has a site file named just before it (a heading or line such as `content/pages/about.md`).", 400);
  if (blocks.length > MAX_BLOCKS) throw new WorkspaceError(`The attachment has ${blocks.length} blocks: at most ${MAX_BLOCKS} can be added at once.`, 400);
  const plan = { ready: [], skipped: [], failed: [] };
  const counts = new Map();
  for (const { file } of blocks) counts.set(file, (counts.get(file) ?? 0) + 1);
  const known = new Set(blocks.map((b) => b.file));
  for (const correction of corrections) {
    if (!known.has(correction.file)) plan.failed.push({ file: correction.file, reason: "a correction names a file with no block" });
  }
  for (const block of blocks) {
    const { file } = block;
    if (counts.get(file) > 1) {
      if (!plan.failed.some((f) => f.file === file)) plan.failed.push({ file, reason: `the attachment has ${counts.get(file)} blocks for it` });
      continue;
    }
    try {
      let addition = block.text;
      let missing = null;
      for (const correction of corrections.filter((c) => c.file === file)) {
        if (!addition.includes(correction.find)) missing = correction.find;
        else addition = addition.split(correction.find).join(correction.replace);
      }
      if (missing) {
        plan.failed.push({ file, reason: `the correction's text isn't in its block: "${missing.slice(0, 80)}"` });
        continue;
      }
      const problem = blockProblem(addition);
      if (problem) {
        plan.failed.push({ file, reason: problem });
        continue;
      }
      const current = await readRepoText(key, file);
      if (!current.exists) {
        plan.failed.push({ file, reason: "the site has no such file" });
        continue;
      }
      if (skipIfContains && current.content.includes(skipIfContains)) {
        plan.skipped.push(file);
        continue;
      }
      const content = appended(current.content, addition);
      await checkRepoTextWrite(key, file, content);
      plan.ready.push({ file, content, version: current.version });
    } catch (err) {
      if (!(err instanceof WorkspaceError)) throw err;
      plan.failed.push({ file, reason: err.message });
    }
  }
  return plan;
}

const someOf = (list) => list.slice(0, 20).join("; ") + (list.length > 20 ? `; and ${list.length - 20} more` : "");

/** One plain report of a plan, for Claude and the card. */
export function describePlan(plan, verb) {
  const failed = plan.failed.map((f) => `${f.file}: ${f.reason}`);
  return [
    `${verb} ${plan.ready.length} file(s).`,
    plan.skipped.length ? `Skipped ${plan.skipped.length} that already have it.` : "",
    failed.length ? `Couldn't do ${failed.length}: ${someOf(failed)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
