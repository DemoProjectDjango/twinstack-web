import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// Undo and redo for the owner's own edits in the preview (text typed in, the style bar): Ctrl+Z and
// Ctrl+Shift+Z / Ctrl+Y in the editor. Each edit records the whole file before and after it in
// .git/twinstack-undo.json (never a change of its own), newest last, at most MAX_STEPS. Undo puts the
// file back only while it's still exactly as the edit left it, so it never overwrites anything done
// since (the AI's work, a publish that brought in other changes); redo likewise. A new edit clears
// what could be redone. The history belongs to one copy of the site (one browser), like its changes.

const FILE = ".git/twinstack-undo.json";
const MAX_STEPS = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function readHistory(dir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, FILE), "utf8"));
    return { undo: Array.isArray(data.undo) ? data.undo : [], redo: Array.isArray(data.redo) ? data.redo : [] };
  } catch {
    return { undo: [], redo: [] };
  }
}

const writeHistory = (dir, history) => fs.writeFile(path.join(dir, FILE), JSON.stringify(history));

/** What the editor shows: whether there's something to undo or redo, and what. */
export function historyView(history) {
  return {
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    undoLabel: history.undo.at(-1)?.label ?? null,
    redoLabel: history.redo.at(-1)?.label ?? null,
  };
}

/**
 * Records one edit of `file` (repo-relative) in the workspace at `dir`, from `before` to `after`.
 * Called with the workspace already locked by the edit. Never fails the edit: a history that can't
 * be written only means that step can't be undone.
 */
export async function recordEdit(dir, file, before, after, label) {
  if (before === after || Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_FILE_BYTES) return;
  try {
    const history = await readHistory(dir);
    history.undo.push({ file, before, after, label, at: new Date().toISOString() });
    history.undo = history.undo.slice(-MAX_STEPS);
    history.redo = [];
    await writeHistory(dir, history);
  } catch (err) {
    console.error("Couldn't record an edit for undo:", err.message);
  }
}

export async function undoState(key) {
  return historyView(await readHistory(workspaceDir(key)));
}

/** Undoes (`direction` "undo") or redoes ("redo") the latest step. Returns `{ file, label, history }`. */
export async function stepHistory(key, direction) {
  const release = acquire(key, direction === "undo" ? "undoing a change" : "redoing a change");
  try {
    const dir = workspaceDir(key);
    const history = await readHistory(dir);
    const from = direction === "undo" ? history.undo : history.redo;
    const step = from.at(-1);
    if (!step) throw new WorkspaceError(direction === "undo" ? "There's nothing to undo." : "There's nothing to redo.", 409);
    const target = path.resolve(dir, step.file);
    if (!target.startsWith(dir + path.sep)) throw new WorkspaceError("That change can't be undone here.", 409);
    const now = await fs.readFile(target, "utf8").catch(() => null);
    const expected = direction === "undo" ? step.after : step.before;
    if (now !== expected) {
      // Changed since (by the AI, a publish or the file screens): the step can't be applied safely.
      from.pop();
      await writeHistory(dir, history);
      throw new WorkspaceError(`${step.file} was changed since, so this step can't be ${direction === "undo" ? "undone" : "redone"} without losing that. Change it by hand or ask the AI.`, 409);
    }
    await fs.writeFile(target, direction === "undo" ? step.before : step.after);
    from.pop();
    (direction === "undo" ? history.redo : history.undo).push(step);
    await writeHistory(dir, history);
    return { file: step.file, label: step.label, history: historyView(history) };
  } finally {
    release();
  }
}
