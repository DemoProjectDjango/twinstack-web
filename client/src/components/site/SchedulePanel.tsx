"use client";

import { useEffect, useState } from "react";
import { api, workspacePath, type ScheduleJob } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

type Schedule = { path: string; jobs: ScheduleJob[]; error: string | null };
type Kind = "generate" | "move";

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_FORM = {
  kind: "generate" as Kind,
  location: "",
  title: "",
  date: "",
  description: "",
  content: "",
  images: "",
  research: true,
  source: "",
};

function jobState(job: ScheduleJob) {
  if (job.done) return `Done${job.completedDate ? ` ${job.completedDate}` : ""}`;
  return new Date(job.date).getTime() <= Date.now() ? "Due" : "Scheduled";
}

export function SchedulePanel() {
  const { owner, repo, overview, busy, run, hasKey, version } = useSite();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, date: today() }));

  // Running jobs marks them done in the file, so reload after every command.
  useEffect(() => {
    let cancelled = false;
    api<Schedule>(workspacePath(owner, repo, "/schedule"))
      .then((s) => !cancelled && setSchedule(s))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  async function save(jobs: ScheduleJob[]) {
    setSaving(true);
    setError(null);
    try {
      setSchedule(await api<Schedule>(workspacePath(owner, repo, "/schedule"), { method: "PUT", body: { jobs } }));
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const base = { location: form.location.trim(), title: form.title.trim(), date: form.date };
    const job: ScheduleJob =
      form.kind === "move"
        ? { ...base, source: form.source.trim(), done: false }
        : {
            ...base,
            description: form.description.trim(),
            ...(form.content.trim() && { content: form.content.trim() }),
            ...(form.images.trim() && {
              images: form.images
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            }),
            research: form.research,
            done: false,
          };
    if (await save([...(schedule?.jobs ?? []), job])) setForm({ ...EMPTY_FORM, kind: form.kind, date: today() });
  }

  function markPending(index: number) {
    const jobs = schedule!.jobs.map((job, i) => {
      if (i !== index) return job;
      const pending: ScheduleJob = { ...job, done: false };
      delete pending.completedDate;
      return pending;
    });
    void save(jobs);
  }

  const jobs = schedule?.jobs ?? [];
  const locations = [
    ...(overview?.collections.map((c) => c.dir) ?? []),
    "content/pages",
    ...(form.kind === "move" ? ["static"] : []),
  ];
  const disabled = busy || saving;

  return (
    <>
      <Section
        title="Scheduled pages"
        description="Dated one-off jobs from scripts/scaffold-schedule.md. A job runs once its date arrives: Claude writes the page from your brief, notes and images, or a finished file is moved into place. Each job is then marked done so it never runs twice."
      >
        <ErrorText error={error} />
        {schedule?.error && <Notice tone="warning">{schedule.error}</Notice>}
        {schedule && jobs.length === 0 && !schedule.error && <p className="text-sm text-zinc-500">No jobs scheduled.</p>}
        {jobs.length > 0 && (
          <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {jobs.map((job, index) => (
              <li key={`${index}-${job.title}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="w-24 font-mono text-xs text-zinc-500">{job.date}</span>
                <span className="text-sm font-medium">{job.title}</span>
                <Badge>{job.source ? "Move" : "Generate"}</Badge>
                <Badge>{jobState(job)}</Badge>
                <span className="font-mono text-xs text-zinc-500">{job.location}</span>
                <span className="ml-auto flex gap-1">
                  {job.done && (
                    <Button variant="ghost" className="px-2 py-1 text-xs" disabled={disabled} onClick={() => markPending(index)}>
                      Mark pending
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs"
                    disabled={disabled}
                    onClick={() => confirm(`Remove "${job.title}" from the schedule?`) && save(jobs.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={disabled} onClick={() => run("schedule", { dryRun: true })}>
            Preview due jobs
          </Button>
          <Button variant="primary" disabled={disabled || !hasKey} onClick={() => run("schedule")}>
            Run due jobs
          </Button>
          <span className="text-xs text-zinc-500">
            The preview prints what Claude would be sent, without calling it.{!hasKey && " Running generate jobs needs your Anthropic key."}
          </span>
        </div>
      </Section>

      <Section title="Add a job">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-2">
          <fieldset className="flex gap-4 text-sm sm:col-span-2">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={form.kind === "generate"} onChange={() => setForm({ ...form, kind: "generate" })} disabled={disabled} />
              Claude writes the page
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={form.kind === "move"} onChange={() => setForm({ ...form, kind: "move" })} disabled={disabled} />
              Move a finished file into place
            </label>
          </fieldset>
          <Field label="Location" hint="A collection folder, a folder under content/pages/, or (for a move) under static/.">
            <input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              list="schedule-locations"
              required
              className={`${inputClass} font-mono`}
              disabled={disabled}
            />
            <datalist id="schedule-locations">
              {locations.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
          <Field label="Title" hint="Also becomes the filename.">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required className={inputClass} disabled={disabled} />
          </Field>
          <Field label="Date">
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required className={inputClass} disabled={disabled} />
          </Field>
          {form.kind === "move" ? (
            <Field label="Source file" hint="The finished file, e.g. content/_scheduled/my-page.html.">
              <input
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
                required
                className={`${inputClass} font-mono`}
                disabled={disabled}
              />
            </Field>
          ) : (
            <>
              <label className="flex items-center gap-2 self-end pb-1.5 text-sm">
                <input type="checkbox" checked={form.research} onChange={(e) => setForm({ ...form, research: e.target.checked })} disabled={disabled} />
                Let Claude search the web for supporting facts
              </label>
              <div className="sm:col-span-2">
                <Field label="Brief" hint="What the page is for and who it's for.">
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    required
                    rows={2}
                    className={inputClass}
                    disabled={disabled}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Notes (optional)" hint="Facts, quotes or copy to write from. Claude won't invent beyond these and the brief.">
                  <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={4} className={inputClass} disabled={disabled} />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Images (optional)" hint="One per line: a path in the repo (assets/img/…) or an https:// URL.">
                  <textarea
                    value={form.images}
                    onChange={(e) => setForm({ ...form, images: e.target.value })}
                    rows={2}
                    className={`${inputClass} font-mono`}
                    disabled={disabled}
                  />
                </Field>
              </div>
            </>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" disabled={disabled}>
              Add job
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}
