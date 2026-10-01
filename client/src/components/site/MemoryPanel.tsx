"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type Memory, type WorkspaceStatus } from "@/lib/site-api";
import { LiveDiff } from "./LiveDiff";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Section, inputClass } from "./ui";

type DataFile = { content: string; exists: boolean; path: string };
type MemoryResult = Memory & { status: WorkspaceStatus };

const MAX_SUMMARY_POINTS = 5;

/** An entry's summary: the "  - " points under its line, without the dashes. */
function summaryOf(entry: string) {
  return entry
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

/**
 * A written entry, "- <date> · <command> · <file>[ · <what was asked>]" plus
 * its summary points, split up; null for a hand-written one.
 */
function parseLine(entry: string) {
  const line = entry.split("\n")[0];
  const parts = line.slice(2).split(" · ");
  if (parts.length < 3 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) return null;
  return { date: parts[0], command: parts[1], file: parts[2], what: parts.slice(3).join(" · "), summary: summaryOf(entry) };
}

function buildLine({ date, command, file, what, summary }: NonNullable<ReturnType<typeof parseLine>>) {
  const text = what.replace(/\s+/g, " ").trim();
  const points = summary.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, MAX_SUMMARY_POINTS);
  return [`- ${date} · ${command} · ${file}${text ? ` · ${text}` : ""}`, ...points.map((p) => `  - ${p}`)].join("\n");
}

export function MemoryPanel() {
  const { overview } = useSite();
  if (overview && !overview.features.memory) {
    return (
      <Section title="Claude memory">
        <Notice>
          This site&apos;s scripts were copied before Claude&apos;s memory existed, so Claude doesn&apos;t keep notes or a work log
          here yet. A copy needs <code className="font-mono">scripts/lib/knowledge.js</code> and the updated scripts from the
          template.
        </Notice>
      </Section>
    );
  }
  return (
    <>
      <NotesSection />
      <WorkLogSection />
    </>
  );
}

/* ------------------------------------------------------------------ notes */

function NotesSection() {
  const { owner, repo, busy, version, refresh } = useSite();
  const [saved, setSaved] = useState<string | null>(null);
  const savedRef = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<DataFile>(workspacePath(owner, repo, "/files/knowledge-notes"))
      .then(({ content }) => {
        if (cancelled) return;
        // Keep unsaved edits; only follow the file when the editor matches what was saved.
        const previous = savedRef.current;
        setDraft((current) => (previous === null || current === previous ? content : current));
        savedRef.current = content;
        setSaved(content);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
    // A Claude command may have edited the notes (md:edit), so reload after commands.
  }, [owner, repo, version]);

  const dirty = saved !== null && draft !== saved;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const file = await api<DataFile>(workspacePath(owner, repo, "/files/knowledge-notes"), {
        method: "PUT",
        body: { content: draft },
      });
      savedRef.current = file.content;
      setSaved(file.content);
      setDraft(file.content);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Notes for Claude"
      description={
        <>
          knowledge/notes.md: standing instructions Claude follows on every request (voice, audience, decisions, things to avoid).
          Text inside &lt;!-- --&gt; comments and headings with nothing under them aren&apos;t sent. Saving makes it a change
          to publish like any other; Claude uses it here straight away.
        </>
      }
    >
      <ErrorText error={error} />
      {saved === null && !error ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs leading-relaxed`}
            disabled={busy || saving}
            aria-label="Notes for Claude"
          />
          {saved !== null && (
            <div className="mt-3">
              <LiveDiff before={saved} after={draft} label="Unsaved changes" />
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!dirty || busy || saving} onClick={save}>
              {saving ? "Saving…" : "Save notes"}
            </Button>
            {dirty && (
              <Button variant="ghost" disabled={saving} onClick={() => setDraft(saved ?? "")}>
                Undo changes
              </Button>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

/* --------------------------------------------------------------- work log */

function WorkLogSection() {
  const { owner, repo, busy, version, setStatus } = useSite();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState(false);
  // `summary` is edited as text, one point per line.
  const [editing, setEditing] = useState<{ line: string; what: string; summary: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<Memory>(workspacePath(owner, repo, "/memory"))
      .then((result) => !cancelled && setMemory(result))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
    // Every Claude command may add lines, so reload after commands.
  }, [owner, repo, version]);

  async function change(action: "forget" | "replace" | "clear", body: Record<string, string> = {}) {
    setWorking(true);
    setError(null);
    try {
      const result = await api<MemoryResult>(workspacePath(owner, repo, `/memory/${action}`), { method: "POST", body });
      const { status, ...next } = result;
      setMemory(next);
      setStatus(status);
      setEditing(null);
    } catch (err) {
      setError(err);
    } finally {
      setWorking(false);
    }
  }

  function saveEdit() {
    if (!editing) return;
    const parsed = parseLine(editing.line);
    if (!parsed) return;
    change("replace", { line: editing.line, replacement: buildLine({ ...parsed, what: editing.what, summary: editing.summary.split("\n") }) });
  }

  function clearAll() {
    if (!confirm("Clear Claude's memory of earlier work on this site? Claude's next requests start without it. Your notes stay.")) {
      return;
    }
    change("clear");
  }

  const disabled = busy || working;
  // Newest first; only the newest `sent` lines go to Claude.
  const lines = memory ? [...memory.lines].reverse() : [];

  return (
    <Section
      title="Work log"
      description={
        <>
          One entry per change Claude made that was kept, newest first: what was asked, and Claude&apos;s summary of what it
          changed. Claude reads the newest {memory?.sent ?? 60} before every request, including changes that aren&apos;t
          published or merged yet. Edit an entry to correct what it says, or remove one that&apos;s wrong or was undone.
          Removed entries stay forgotten even if an older branch still has them.
        </>
      }
    >
      <ErrorText error={error} />
      {!memory && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {memory && lines.length === 0 && (
        <p className="text-sm text-zinc-500">Nothing yet. Each change Claude makes that you keep adds an entry here.</p>
      )}
      {lines.length > 0 && (
        <ol className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {lines.map((line, index) => {
            const parsed = parseLine(line);
            const sent = memory !== null && index < memory.sent;
            const isEditing = editing?.line === line;
            return (
              <li key={line} className={`px-3 py-2 text-sm ${sent ? "" : "opacity-60"}`}>
                {parsed ? (
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                    <span>{parsed.date}</span>
                    <span className="font-mono">{parsed.command}</span>
                    <span className="truncate font-mono">{parsed.file}</span>
                    {!sent && <span>· older than the newest {memory?.sent}, not sent</span>}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-500">Written by hand{!sent && ` · older than the newest ${memory?.sent}, not sent`}</div>
                )}
                {isEditing ? (
                  <div className="mt-1.5 space-y-2">
                    <input
                      value={editing.what}
                      onChange={(e) => setEditing({ ...editing, what: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className={inputClass}
                      maxLength={400}
                      disabled={working}
                      aria-label="What was asked"
                      autoFocus
                    />
                    <label className="block text-xs text-zinc-500">
                      Summary of what changed, one point per line (up to {MAX_SUMMARY_POINTS})
                      <textarea
                        value={editing.summary}
                        onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
                        onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                        rows={Math.min(6, Math.max(2, editing.summary.split("\n").length + 1))}
                        className={`${inputClass} mt-1 text-sm`}
                        maxLength={1100}
                        disabled={working}
                      />
                    </label>
                    <div className="flex gap-2">
                      <Button variant="primary" disabled={working} onClick={saveEdit}>
                        Save
                      </Button>
                      <Button variant="ghost" disabled={working} onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-0.5 flex items-start gap-2">
                    <div className="min-w-0 flex-1 break-words">
                      <p>{parsed ? parsed.what || <span className="text-zinc-500">(no instruction)</span> : line.split("\n")[0].slice(2)}</p>
                      {(parsed?.summary ?? summaryOf(line)).length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-600 dark:text-zinc-400">
                          {(parsed?.summary ?? summaryOf(line)).map((point, i) => (
                            <li key={i}>{point}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {parsed && (
                      <Button
                        variant="ghost"
                        className="px-2 py-0.5 text-xs"
                        disabled={disabled}
                        onClick={() => setEditing({ line, what: parsed.what, summary: parsed.summary.join("\n") })}
                      >
                        Edit
                      </Button>
                    )}
                    <Button variant="ghost" className="px-2 py-0.5 text-xs" disabled={disabled} onClick={() => change("forget", { line })}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {lines.length > 0 && (
        <div className="mt-3">
          <Button variant="danger" disabled={disabled} onClick={clearAll}>
            Clear memory
          </Button>
        </div>
      )}
    </Section>
  );
}
