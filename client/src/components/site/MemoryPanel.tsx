"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type Memory } from "@/lib/site-api";
import { LiveDiff } from "./LiveDiff";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Section, inputClass } from "./ui";

type DataFile = { content: string; exists: boolean; path: string };

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

export function MemoryPanel() {
  const { overview } = useSite();
  if (overview && !overview.features.memory) {
    return (
      <Section title="AI notes about your site">
        <Notice>
          Your site was made before the AI could keep notes, so it doesn&apos;t remember earlier work here yet. Install the
          latest site update (Edit site offers it) to turn this on.
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
      title="Notes for the AI"
      description={
        <>
          knowledge/notes.md: standing instructions the AI follows on every request (voice, audience, decisions, things to avoid).
          Text inside &lt;!-- --&gt; comments and headings with nothing under them aren&apos;t sent. Saving makes it a change
          to publish like any other; the AI uses it here straight away.
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
            aria-label="Notes for the AI"
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

/** Who made an entry's change: the owner's own edits are logged as "owner:…", everything else is the AI's. */
const byOwner = (command: string) => command.startsWith("owner:");

/** Read-only: entries are written by the app, so what the AI reads is what actually happened. */
function WorkLogSection() {
  const { owner, repo, version } = useSite();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<Memory>(workspacePath(owner, repo, "/memory"))
      .then((result) => {
        if (cancelled) return;
        setMemory(result);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
    // Every change (the AI's or the owner's) may add an entry, so reload after each one.
  }, [owner, repo, version]);

  // Newest first; only the newest `sent` lines go to the AI.
  const lines = memory ? [...memory.lines].reverse() : [];

  return (
    <Section
      title="Work log"
      description={
        <>
          Every change made to your site, newest first: what the AI changed for you, and the edits you made yourself. The AI
          reads the newest {memory?.sent ?? 60} before every request, including changes that aren&apos;t published yet, so it
          builds on your work instead of undoing it. The log is written automatically and can&apos;t be edited.
        </>
      }
    >
      <ErrorText error={error} />
      {!memory && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {memory && lines.length === 0 && (
        <p className="text-sm text-zinc-500">Nothing yet. Each change you or the AI make adds an entry here.</p>
      )}
      {lines.length > 0 && (
        <ol className="h-96 divide-y divide-zinc-200 overflow-y-auto overscroll-contain rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {lines.map((line, index) => {
            const parsed = parseLine(line);
            const sent = memory !== null && index < memory.sent;
            const summary = parsed?.summary ?? summaryOf(line);
            return (
              <li key={line} className={`px-3 py-2 text-sm ${sent ? "" : "opacity-60"}`}>
                {parsed ? (
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                    <span>{parsed.date}</span>
                    <span
                      className={`rounded px-1.5 py-px font-medium ${
                        byOwner(parsed.command)
                          ? "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                          : "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                      }`}
                    >
                      {byOwner(parsed.command) ? "You" : "AI"}
                    </span>
                    <span className="font-mono">{parsed.command}</span>
                    <span className="truncate font-mono">{parsed.file}</span>
                    {!sent && <span>· older than the newest {memory?.sent}, not sent</span>}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-500">Written by hand{!sent && ` · older than the newest ${memory?.sent}, not sent`}</div>
                )}
                <div className="mt-0.5 break-words">
                  <p>{parsed ? parsed.what || <span className="text-zinc-500">(no instruction)</span> : line.split("\n")[0].slice(2)}</p>
                  {summary.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-600 dark:text-zinc-400">
                      {summary.map((point, i) => (
                        <li key={i}>{point}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
