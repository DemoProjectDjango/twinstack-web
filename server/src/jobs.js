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

/**
 * A step is a process ({ file, args, display, timeoutMs }, optionally with its own cwd and env) or
 * a function ({ display, run }): `run({ log, exec })` logs with `log(text)` and starts processes,
 * which stream and cancel like process steps, with `exec(step)` (resolves to `{ code, output }`).
 * A function step fails by throwing; its message is the last line of the output.
 */
async function runStep(job, step, { cwd, env }) {
  if (!step.run) return runProcess(job, step, { cwd: step.cwd ?? cwd, env: step.env ?? env });
  append(job, `${step.display}\n`);
  const exec = async (child) => {
    if (job.cancelled) return { code: 1, output: "" };
    const start = job.base + job.text.length;
    const code = await runProcess(job, child, { cwd: child.cwd ?? cwd, env: child.env ?? env });
    return { code, output: job.text.slice(Math.max(0, start - job.base)) };
  };
  try {
    await step.run({ log: (text) => append(job, text.endsWith("\n") ? text : `${text}\n`), exec });
    return job.cancelled ? 1 : 0;
  } catch (err) {
    append(job, `\n${err.message}\n`);
    return 1;
  }
}

function runProcess(job, { file, args, display, timeoutMs }, { cwd, env }) {
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
 * always called (and awaited, if it returns a promise) when the job ends;
 * `onSuccess` runs before it's marked done, and `onEnd({ exitCode, output })`
 * after any run that wasn't cancelled, before `release`.
 */
export function startJob({ key, userId, command, label, steps, cwd, env, release, onSuccess, onEnd }) {
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
      if (onEnd && !job.cancelled) {
        try {
          await onEnd({ exitCode, output: job.text });
        } catch (err) {
          append(job, `\n${err.message}\n`);
        }
      }
      // May be async (saving the work log): the job only reads as finished once it's done.
      try {
        await release();
      } catch (err) {
        append(job, `\n${err.message}\n`);
      }
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
