import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { neutralText } from "./ai-errors.js";

// In-memory job runner. A job is a sequence of processes run in a workspace;
// the browser polls for output by offset. Jobs don't survive a server restart.

const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const KEEP_FINISHED_MS = 60 * 60 * 1000;
const jobs = new Map();

/* ------------------------------------------------------------ queue */

// Builds, Claude commands and site updates all run on this machine, so only so many run at once:
// the rest wait in line, first come first served, and start as places free up. One account may
// run at most MAX_JOBS_PER_USER at once, so one owner can't fill the machine. A waiting job reads
// as running (its workspace stays locked, so nothing else changes it meanwhile), says in its output
// where it is in line, and can be cancelled while it waits.
const envCount = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
export const MAX_RUNNING_JOBS = envCount("MAX_RUNNING_JOBS", Math.max(2, availableParallelism()));
export const MAX_JOBS_PER_USER = envCount("MAX_JOBS_PER_USER", 3);

// Jobs waiting, in order: { job, resolve }.
const waiting = [];
// Running jobs per account, and in all.
const runningByUser = new Map();
let runningJobs = 0;

const runningFor = (userId) => runningByUser.get(userId) ?? 0;

/** Starts every waiting job there's now room for, in order, skipping accounts at their own limit. */
function startWaiting() {
  for (let i = 0; i < waiting.length && runningJobs < MAX_RUNNING_JOBS; ) {
    const entry = waiting[i];
    if (runningFor(entry.job.userId) >= MAX_JOBS_PER_USER) {
      i++;
      continue;
    }
    waiting.splice(i, 1);
    entry.resolve(take(entry.job));
  }
  for (const [index, { job }] of waiting.entries()) job.queuePosition = index + 1;
}

/** Takes a running place for `job`; resolves to the function that gives it back (once). */
function take(job) {
  runningJobs++;
  runningByUser.set(job.userId, runningFor(job.userId) + 1);
  job.queuePosition = 0;
  let given = false;
  return () => {
    if (given) return;
    given = true;
    runningJobs--;
    const left = runningFor(job.userId) - 1;
    if (left > 0) runningByUser.set(job.userId, left);
    else runningByUser.delete(job.userId);
    startWaiting();
  };
}

/**
 * A running place for `job`, at once when there's room, else after waiting in line. Resolves to
 * the function that gives it back, or null when the job was cancelled while it waited.
 */
function placeFor(job) {
  // Jobs still in line while there's room are only waiting for their own account, so they don't block this one.
  if (runningJobs < MAX_RUNNING_JOBS && runningFor(job.userId) < MAX_JOBS_PER_USER) {
    return Promise.resolve(take(job));
  }
  return new Promise((resolve) => {
    waiting.push({ job, resolve });
    job.queuePosition = waiting.length;
    append(job, `Waiting for a free place to run (${job.queuePosition === 1 ? "next in line" : `${job.queuePosition - 1} ahead`})…\n`);
    startWaiting();
  });
}

/** Takes a waiting job out of the line; true when it was waiting. */
function leaveLine(job) {
  const index = waiting.findIndex((entry) => entry.job === job);
  if (index === -1) return false;
  const [entry] = waiting.splice(index, 1);
  entry.resolve(null);
  startWaiting();
  return true;
}

/** How busy the machine is, for the admin pages and logs. */
export const queueState = () => ({ running: runningJobs, waiting: waiting.length, maxRunning: MAX_RUNNING_JOBS, maxPerUser: MAX_JOBS_PER_USER });

setInterval(() => {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

// A provider's error never reaches a job's log as it came back (status codes, raw JSON, provider
// names): every line goes through neutralText (ai-errors.js) on its way in. A process's output is
// passed on in whole lines for that; a part line waits at most LINE_WAIT_MS (a progress line).
const LINE_WAIT_MS = 400;

/** What a process writes to one of its streams, appended to the job's output a whole line at a time. */
function lineWriter(job) {
  let partial = "";
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (partial) append(job, neutralText(partial));
    partial = "";
  };
  return {
    write(chunk) {
      const text = partial + chunk;
      const end = text.lastIndexOf("\n");
      if (end >= 0) {
        append(job, neutralText(text.slice(0, end + 1)));
        partial = text.slice(end + 1);
      } else partial = text;
      clearTimeout(timer);
      timer = partial ? setTimeout(flush, LINE_WAIT_MS) : null;
    },
    flush,
  };
}

/** append, with any provider error put in plain words. */
const appendSafe = (job, text) => append(job, neutralText(text));

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
 * a function ({ display, run }): `run({ log, exec, cwd })` logs with `log(text)` and starts processes,
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
    await step.run({ log: (text) => appendSafe(job, text.endsWith("\n") ? text : `${text}\n`), exec, cwd: step.cwd ?? cwd, signal: job.abort.signal });
    return job.cancelled ? 1 : 0;
  } catch (err) {
    appendSafe(job, `\n${err.message}\n`);
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
    const out = lineWriter(job);
    const err = lineWriter(job);
    child.stdout.setEncoding("utf8").on("data", (chunk) => out.write(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => err.write(chunk));
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.flush();
      err.flush();
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
    // Function steps get its signal, so a cancel stops them (a browser closed, a loop ended) at once.
    abort: new AbortController(),
    queuePosition: 0,
  };
  jobs.set(job.id, job);

  (async () => {
    let exitCode = 0;
    let givePlaceBack = null;
    try {
      const wasQueued = () => job.text.length > 0;
      givePlaceBack = await placeFor(job);
      if (!givePlaceBack) exitCode = 1;
      else if (wasQueued()) append(job, "Starting.\n");
      for (const step of givePlaceBack && !job.cancelled ? steps : []) {
        exitCode = await runStep(job, step, { cwd, env });
        if (exitCode !== 0 || job.cancelled) break;
      }
      if (exitCode === 0 && !job.cancelled && onSuccess) await onSuccess();
    } catch (err) {
      appendSafe(job, `\n${err.message}\n`);
      exitCode = exitCode || 1;
    } finally {
      givePlaceBack?.();
      if (onEnd && !job.cancelled) {
        try {
          await onEnd({ exitCode, output: job.text });
        } catch (err) {
          appendSafe(job, `\n${err.message}\n`);
        }
      }
      // May be async (saving the work log): the job only reads as finished once it's done.
      try {
        await release();
      } catch (err) {
        appendSafe(job, `\n${err.message}\n`);
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
    // Its place in line while it waits to run (1 = next), else 0.
    queuePosition: job.queuePosition,
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
  leaveLine(job);
  job.child?.kill();
  job.abort?.abort();
}

/** The running job in a workspace, so a reloaded page can reattach to it. */
export function activeJobFor(key) {
  for (const job of jobs.values()) {
    if (job.key === key && job.status === "running") return { id: job.id, command: job.command, label: job.label };
  }
  return null;
}
