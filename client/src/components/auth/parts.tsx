"use client";

import { useEffect, useState } from "react";

// The pieces the log-in, sign-up and password reset forms share: the card, fields, the
// emailed-code boxes and the "Send a new code" ring.

export const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm shadow-xs transition-colors placeholder:text-zinc-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-500";

export const primaryButton =
  "w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-sky-600/20 transition-colors hover:bg-sky-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-default disabled:bg-sky-600/50 disabled:shadow-none dark:bg-sky-500 dark:hover:bg-sky-400 dark:disabled:bg-sky-500/40";

export const textLink = "font-medium text-sky-700 hover:text-sky-900 dark:text-sky-400 dark:hover:text-sky-300";

/** POSTs JSON to the API (through the Next rewrite) and reads the JSON reply, {} when there's none. */
export async function postJson(path: string, body: object) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, data: await res.json().catch(() => ({})) };
}

/**
 * The wait before another code may be asked for (the server allows one a minute and says
 * how long is left as retryAfter). `now` only moves when the wait ends: the ring animates
 * in CSS, not per tick.
 */
export function useResendWait() {
  const [until, setUntil] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [now, setNow] = useState(0);
  const locked = until > now;

  useEffect(() => {
    if (!locked) return;
    const timer = setTimeout(() => setNow(Date.now()), until - now);
    return () => clearTimeout(timer);
  }, [locked, until, now]);

  function wait(retryAfter: unknown) {
    if (typeof retryAfter !== "number" || retryAfter <= 0) return;
    setUntil(Date.now() + retryAfter * 1000);
    setSeconds(retryAfter);
    setNow(Date.now());
  }

  return { locked, until, seconds, wait };
}

const PANELS = {
  register: "Your own website, without writing code.",
  login: "Pick up where you left off.",
  reset: "Back into your account in a minute.",
};

const PERKS = [
  "A ready-made website with its own free web address",
  "10,000 free Claude credits to write and design pages when you connect GitHub",
  "Nothing goes live until you press Publish",
];

/** The card: a coloured panel about Twinstack beside the form (the panel only on wider screens). */
export function AuthShell({ panel, children }: { panel: keyof typeof PANELS; children: React.ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/5 md:grid-cols-[5fr_6fr] dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30">
      <aside className="relative hidden overflow-hidden bg-linear-to-br from-sky-600 via-sky-700 to-indigo-800 p-10 text-white md:flex md:flex-col">
        {/* Soft light in the corner, for depth. */}
        <div aria-hidden="true" className="absolute -top-24 -right-24 size-72 rounded-full bg-white/10 blur-3xl" />
        <div className="relative flex items-center gap-2.5 font-semibold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/25">
            <LayersIcon />
          </span>
          Twinstack
        </div>
        <div className="relative mt-auto">
          <h2 className="text-2xl leading-snug font-semibold text-balance">{PANELS[panel]}</h2>
          <ul className="mt-6 space-y-3 text-sm text-sky-50">
            {PERKS.map((perk) => (
              <li key={perk} className="flex gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-white/15">
                  <CheckIcon className="size-3" />
                </span>
                {perk}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <div className="px-6 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}

export function StepLabel({ step, label }: { step: 1 | 2; label: string }) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-wider text-sky-700 uppercase dark:text-sky-400">
        Step {step} of 2 · {label}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5" aria-hidden="true">
        {[1, 2].map((n) => (
          <span key={n} className={`h-1 rounded-full ${n <= step ? "bg-sky-500" : "bg-zinc-200 dark:bg-zinc-800"}`} />
        ))}
      </div>
    </div>
  );
}

/** A round icon above a step's heading. */
export function StepIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 flex size-12 items-center justify-center rounded-full bg-sky-50 text-sky-600 ring-8 ring-sky-50/50 dark:bg-sky-950 dark:text-sky-400 dark:ring-sky-950/40">
      {children}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  aside,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  /** Shown at the right of the label, e.g. "Forgot password?". */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {aside && <div className="text-sm">{aside}</div>}
      </div>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

/** A password input with a Show/Hide button. */
export function PasswordInput({
  id,
  value,
  onChange,
  disabled,
  isNew,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  /** A password being chosen (8+ characters, the browser may suggest one), not one being typed in. */
  isNew: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        minLength={isNew ? 8 : undefined}
        maxLength={200}
        autoComplete={isNew ? "new-password" : "current-password"}
        disabled={disabled}
        className={`${inputClass} pr-16`}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-zinc-500 hover:text-foreground dark:text-zinc-400"
        aria-label={shown ? "Hide password" : "Show password"}
      >
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function ErrorMessage({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 size-4 shrink-0" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      </svg>
      {text}
    </p>
  );
}

export function SuccessMessage({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
      <CheckIcon className="size-4 shrink-0" />
      {text}
    </p>
  );
}

/**
 * Six boxes for the code. One real input lies invisibly over them, so typing, pasting and the
 * phone's "fill code from email" work as in a plain field; the boxes only show its digits.
 */
export function CodeBoxes({
  value,
  onChange,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, 5);
  return (
    <div>
      <label htmlFor="auth-code" className="block text-sm font-medium">
        Code
      </label>
      <div className="relative mt-1.5">
        <input
          id="auth-code"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          required
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          autoComplete="one-time-code"
          autoFocus
          disabled={disabled}
          className="absolute inset-0 z-10 size-full cursor-text text-base opacity-0"
        />
        <div className="grid grid-cols-6 gap-2" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => {
            const current = focused && !disabled && i === active;
            const border = current
              ? "border-sky-500 ring-4 ring-sky-500/15"
              : invalid
                ? "border-red-300 dark:border-red-900"
                : value[i]
                  ? "border-zinc-400 dark:border-zinc-600"
                  : "border-zinc-300 dark:border-zinc-700";
            return (
              <div
                key={i}
                className={`flex h-12 items-center justify-center rounded-lg border bg-white font-mono text-xl font-semibold tabular-nums transition-colors dark:bg-zinc-900 ${border} ${disabled ? "opacity-60" : ""}`}
              >
                {value[i] ?? (current ? <span className="h-5 w-px animate-pulse bg-sky-500" /> : "")}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** "Send a new code", greyed out behind a draining ring while the wait lasts. */
export function ResendButton({
  wait,
  disabled,
  onClick,
}: {
  wait: ReturnType<typeof useResendWait>;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || wait.locked}
      title={wait.locked ? "You can ask for a new code once the circle runs out" : undefined}
      className="inline-flex items-center gap-2 font-medium text-sky-700 transition-colors hover:text-sky-900 disabled:cursor-default disabled:text-zinc-400 dark:text-sky-400 dark:hover:text-sky-300 dark:disabled:text-zinc-500"
    >
      {wait.locked && (
        // A ring that empties over the wait; restarts (key) with every new code.
        <svg key={wait.until} viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="2" className="stroke-zinc-200 dark:stroke-zinc-800" />
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            pathLength={100}
            className="resend-ring stroke-sky-500"
            style={{ animationDuration: `${wait.seconds}s` }}
          />
        </svg>
      )}
      Send a new code
      {wait.locked && <span className="sr-only"> (available in under a minute)</span>}
    </button>
  );
}

export function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7.5 8 5.5 8-5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" className={className} aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The stacked layers of the app icon (app/icon.svg). */
function LayersIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
      <path d="M16 6.5 25 11 16 15.5 7 11Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7 16.5 16 21 25 16.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 21.5 16 26 25 21.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
