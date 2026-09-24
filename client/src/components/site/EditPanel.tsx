"use client";

import { useEffect, useState } from "react";
import { api, workspacePath } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

type QueueJob = { file: string; instruction: string };
type QueueFile = { _comment?: string; queue: QueueJob[] };

export function EditPanel({ initialFile }: { initialFile: string | null }) {
  const { owner, repo, overview, busy, run, hasKey, version } = useSite();
  const [file, setFile] = useState(initialFile ?? "");
  const [instruction, setInstruction] = useState("");

  const [queueFile, setQueueFile] = useState<QueueFile | null>(null);
  const [queueError, setQueueError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [newJob, setNewJob] = useState<QueueJob>({ file: "", instruction: "" });

  // Reload after every command: running the queue removes finished jobs from the file.
  useEffect(() => {
    let cancelled = false;
    api<{ content: string; exists: boolean }>(workspacePath(owner, repo, "/files/page-commands"))
      .then(({ content, exists }) => {
        if (cancelled) return;
        const parsed = exists ? (JSON.parse(content) as QueueFile) : { queue: [] };
        setQueueFile({ ...parsed, queue: parsed.queue ?? [] });
      })
      .catch((err) => !cancelled && setQueueError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const files = [
    ...(overview?.collections.flatMap((c) => c.pages.map((p) => p.file)) ?? []),
    ...(overview?.otherEditable ?? []),
  ];
  // Blank placeholder entries left by the script aren't real jobs.
  const queue = queueFile?.queue.filter((job) => job.file || job.instruction) ?? [];

  async function saveQueue(next: QueueJob[]) {
    setSaving(true);
    setQueueError(null);
    try {
      const content = `${JSON.stringify({ _comment: queueFile?._comment, queue: next }, null, 2)}\n`;
      await api(workspacePath(owner, repo, "/files/page-commands"), { method: "PUT", body: { content } });
      setQueueFile((prev) => ({ ...prev, queue: next }));
      return true;
    } catch (err) {
      setQueueError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function addToQueue(e: React.FormEvent) {
    e.preventDefault();
    if (await saveQueue([...queue, { file: newJob.file.trim(), instruction: newJob.instruction.trim() }])) {
      setNewJob({ file: "", instruction: "" });
    }
  }

  const disabled = busy || !hasKey;

  return (
    <>
      {!hasKey && <Notice tone="warning">Add your Anthropic API key on the dashboard to use Claude edits.</Notice>}

      <Section
        title="Edit one file"
        description="Claude rewrites the whole file from your instruction, following the site's house rules. It refuses to write output that looks truncated or breaks the template syntax."
      >
        <div className="space-y-3">
          <Field label="File" hint="A content file, template, styles/main.css or site.config.json. A page slug or URL also works.">
            <input value={file} onChange={(e) => setFile(e.target.value)} list="edit-files" className={`${inputClass} font-mono`} disabled={disabled} />
            <datalist id="edit-files">
              {files.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
          <Field label="Instruction">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Add a short section listing the 5 most recent blog posts"
              className={inputClass}
              disabled={disabled}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={disabled || !file.trim() || !instruction.trim()} onClick={() => run("page-edit", { page: file, instruction, dryRun: true })}>
              Preview change
            </Button>
            <Button
              variant="primary"
              disabled={disabled || !file.trim() || !instruction.trim()}
              onClick={() => run("page-edit", { page: file, instruction })}
            >
              Apply change
            </Button>
            <span className="text-xs text-zinc-500">Preview prints the proposed file in the output without writing it. Both call Claude.</span>
          </div>
        </div>
      </Section>

      <Section title="Edit queue" description="Edits saved in scripts/page-commands.json and applied in order. Each one is removed from the queue once it's written; a failed edit stops the run.">
        <ErrorText error={queueError} />
        {queueFile && queue.length === 0 && <p className="text-sm text-zinc-500">The queue is empty.</p>}
        {queue.length > 0 && (
          <ol className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {queue.map((job, index) => (
              <li key={`${index}-${job.file}`} className="flex items-start gap-3 px-3 py-2">
                <span className="text-xs text-zinc-500">{index + 1}.</span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs">{job.file}</p>
                  <p className="text-sm">{job.instruction}</p>
                </div>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={busy || saving}
                  onClick={() => saveQueue(queue.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
        )}

        <form onSubmit={addToQueue} className="mt-4 grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)_auto] sm:items-end">
          <Field label="File">
            <input
              value={newJob.file}
              onChange={(e) => setNewJob({ ...newJob, file: e.target.value })}
              list="edit-files"
              required
              className={`${inputClass} font-mono`}
              disabled={busy || saving}
            />
          </Field>
          <Field label="Instruction">
            <input
              value={newJob.instruction}
              onChange={(e) => setNewJob({ ...newJob, instruction: e.target.value })}
              required
              className={inputClass}
              disabled={busy || saving}
            />
          </Field>
          <Button type="submit" disabled={busy || saving || !newJob.file.trim() || !newJob.instruction.trim()}>
            Add to queue
          </Button>
        </form>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={disabled || queue.length === 0} onClick={() => run("page-edit-queue", { dryRun: true })}>
            Preview queue
          </Button>
          <Button variant="primary" disabled={disabled || queue.length === 0} onClick={() => run("page-edit-queue")}>
            Run queue
          </Button>
        </div>
      </Section>
    </>
  );
}
