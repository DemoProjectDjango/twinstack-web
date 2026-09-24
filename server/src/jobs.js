import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// In-memory job runner. A job is a sequence of processes run in a workspace;
// the browser polls for output by offset. Jobs don't survive a server restart.

const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const KEEP_FINISHED_MS = 60 * 60 * 1000;
const jobs = new Map();

setInterval(() => {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

function append(job, text) {
  job.text += text;
  // Keep the tail; offsets stay absolute so pollers can tell what they missed.
  const overflow = job.text.length - MAX_OUTPUT_CHARS;
  if (overflow > 0) {
    job.text = job.text.slice(overflow);
    job.base += overflow;
  }
}

function runStep(job, { file, args, display, timeoutMs }, { cwd, env }) {
  return new Promise((resolve) => {
    append(job, `$ ${display}\n`);
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    job.child = child;
    const timer = setTimeout(() => {
      append(job, `\nTimed out after ${Math.round(timeoutMs / 60000)} minutes.\n`);
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => append(job, chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => append(job, chunk));
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.child = null;
      resolve(code);
    };
    // A process that fails to start emits "error" and may never emit "close".
    child.on("error", (err) => {
      append(job, `\n${err.message}\n`);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * Starts `steps` in order, stopping at the first non-zero exit. `release` is
 * always called when the job ends; `onSuccess` runs before it's marked done.
 */
export function startJob({ key, userId, command, label, steps, cwd, env, release, onSuccess }) {
  const job = {
    id: randomUUID(),
    key,
    userId,
    command,
    label,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    text: "",
    base: 0,
    child: null,
    cancelled: false,
  };
  jobs.set(job.id, job);

  (async () => {
    let exitCode = 0;
    try {
      for (const step of steps) {
        exitCode = await runStep(job, step, { cwd, env });
        if (exitCode !== 0 || job.cancelled) break;
      }
      if (exitCode === 0 && !job.cancelled && onSuccess) await onSuccess();
    } catch (err) {
      append(job, `\n${err.message}\n`);
      exitCode = exitCode || 1;
    } finally {
      release();
      job.exitCode = exitCode;
      job.status = job.cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
      job.finishedAt = Date.now();
      append(job, `\n${job.status === "succeeded" ? "Done." : `Ended: ${job.status} (exit ${exitCode}).`}\n`);
    }
  })();

  return serializeJob(job);
}

export function serializeJob(job, since = 0) {
  const from = Math.max(since, job.base);
  return {
    id: job.id,
    command: job.command,
    label: job.label,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    output: job.text.slice(from - job.base),
    truncated: since < job.base,
    next: job.base + job.text.length,
  };
}

export function getJob(id, userId) {
  const job = jobs.get(id);
  return job && job.userId === userId ? job : null;
}

export function cancelJob(job) {
  if (job.status !== "running") return;
  job.cancelled = true;
  job.child?.kill();
}

/** The running job in a workspace, so a reloaded page can reattach to it. */
export function activeJobFor(key) {
  for (const job of jobs.values()) {
    if (job.key === key && job.status === "running") return { id: job.id, command: job.command, label: job.label };
  }
  return null;
}
