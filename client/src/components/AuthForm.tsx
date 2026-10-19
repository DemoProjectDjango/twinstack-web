"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { safeNext } from "@/lib/safe-next";

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm shadow-xs transition-colors placeholder:text-zinc-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-500";

export function AuthForm({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // Registering emails a code first; the account is made once it's entered.
  const [pending, setPending] = useState<{ email: string; token: string } | null>(null);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // When "Send a new code" unlocks (the server allows one a minute) and how many seconds its ring
  // takes to drain. `now` only moves when the wait ends: the ring animates in CSS, not per tick.
  const [resendAt, setResendAt] = useState(0);
  const [resendFor, setResendFor] = useState(0);
  const [now, setNow] = useState(0);
  const resendLocked = resendAt > now;

  useEffect(() => {
    if (!resendLocked) return;
    const timer = setTimeout(() => setNow(Date.now()), resendAt - now);
    return () => clearTimeout(timer);
  }, [resendLocked, resendAt, now]);
  const register = mode === "register";
  const destination = safeNext(next);

  async function post(path: string, body: object) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, data: await res.json().catch(() => ({})) };
  }

  /** Runs one request; the form stays disabled when it signed in (true), while the page changes. */
  async function attempt(action: () => Promise<boolean | void>) {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      if ((await action()) === true) return;
    } catch {
      setError("Network error. Check your connection and try again.");
    }
    setWorking(false);
  }

  function signedIn() {
    // refresh() re-renders server components (the navbar) with the new session.
    router.replace(destination);
    router.refresh();
    return true;
  }

  function waitBeforeResend(seconds: unknown) {
    if (typeof seconds !== "number" || seconds <= 0) return;
    setResendAt(Date.now() + seconds * 1000);
    setResendFor(seconds);
    setNow(Date.now());
  }

  async function sendCode() {
    const { res, data } = await post("/auth/register", { name, email, password });
    if (!res.ok) {
      waitBeforeResend(data.retryAfter);
      // On the code screen the countdown already says to wait.
      if (pending && res.status === 429 && data.retryAfter) return;
      return setError(data.error ?? "Something went wrong. Try again.");
    }
    setPending({ email: data.email, token: data.token });
    setCode("");
    setNotice(`We sent a 6-digit code to ${data.email}.`);
    waitBeforeResend(data.retryAfter ?? 60);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    attempt(async () => {
      if (register) return sendCode();
      const { res, data } = await post("/auth/login", { email, password });
      if (!res.ok) return setError(data.error ?? "Something went wrong. Try again.");
      signedIn();
    });
  }

  function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    attempt(async () => {
      const { res, data } = await post("/auth/register/verify", { ...pending, code });
      if (res.ok) return signedIn();
      if (data.restart) setPending(null);
      setError(data.error ?? "Something went wrong. Try again.");
    });
  }

  const switchHref = `${register ? "/login" : "/register"}${next ? `?next=${encodeURIComponent(destination)}` : ""}`;

  if (pending) {
    return (
      <AuthShell register>
        <StepLabel step={2} label="Confirm your email" />
        <div className="mt-6 flex size-12 items-center justify-center rounded-full bg-sky-50 text-sky-600 ring-8 ring-sky-50/50 dark:bg-sky-950 dark:text-sky-400 dark:ring-sky-950/40">
          <MailIcon />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          We sent a 6-digit code to <span className="font-medium text-foreground">{pending.email}</span>. It expires in 15
          minutes. If it isn&apos;t there, look in your spam folder.
        </p>

        <form onSubmit={verify} className="mt-7 space-y-5">
          <CodeBoxes value={code} onChange={setCode} disabled={working} invalid={Boolean(error)} />

          {notice && !error && (
            <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
              <CheckIcon className="size-4 shrink-0" />
              Code sent. Check your inbox.
            </p>
          )}
          {error && <ErrorMessage text={error} />}

          <button type="submit" disabled={working || code.length !== 6} className={primaryButton}>
            {working ? "Checking…" : "Create account"}
          </button>
        </form>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-5 text-sm dark:border-zinc-800">
          <button
            type="button"
            onClick={() => attempt(sendCode)}
            disabled={working || resendLocked}
            title={resendLocked ? "You can ask for a new code once the circle runs out" : undefined}
            className="inline-flex items-center gap-2 font-medium text-sky-700 transition-colors hover:text-sky-900 disabled:cursor-default disabled:text-zinc-400 dark:text-sky-400 dark:hover:text-sky-300 dark:disabled:text-zinc-500"
          >
            {resendLocked && (
              // A ring that empties over the wait; restarts (key) with every new code.
              <svg key={resendAt} viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
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
                  style={{ animationDuration: `${resendFor}s` }}
                />
              </svg>
            )}
            Send a new code
            {resendLocked && <span className="sr-only"> (available in under a minute)</span>}
          </button>
          <button
            type="button"
            onClick={() => {
              setPending(null);
              setError(null);
            }}
            disabled={working}
            className="text-zinc-500 transition-colors hover:text-foreground disabled:opacity-60 dark:text-zinc-400"
          >
            Use a different email
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell register={register}>
      {register && <StepLabel step={1} label="Your details" />}
      <h1 className={`${register ? "mt-6" : ""} text-2xl font-semibold tracking-tight`}>
        {register ? "Create your account" : "Welcome back"}
      </h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
        {register
          ? "We'll email you a code to confirm your address. You'll connect GitHub after this."
          : "Log in to manage your Twinstack site."}
      </p>

      <form onSubmit={submit} className="mt-7 space-y-5">
        {register && (
          <Field label="Name" htmlFor="auth-name">
            <input
              id="auth-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              autoComplete="name"
              placeholder="Jane Smith"
              disabled={working}
              className={inputClass}
            />
          </Field>
        )}
        <Field label="Email" htmlFor="auth-email">
          <input
            id="auth-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            autoComplete="email"
            placeholder="you@example.com"
            disabled={working}
            className={inputClass}
          />
        </Field>
        <Field label="Password" htmlFor="auth-password" hint={register ? "At least 8 characters." : undefined}>
          <div className="relative">
            <input
              id="auth-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={register ? 8 : undefined}
              maxLength={200}
              autoComplete={register ? "new-password" : "current-password"}
              disabled={working}
              className={`${inputClass} pr-16`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((shown) => !shown)}
              className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-zinc-500 hover:text-foreground dark:text-zinc-400"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </Field>

        {error && <ErrorMessage text={error} />}

        <button type="submit" disabled={working} className={primaryButton}>
          {working ? (register ? "Sending code…" : "Logging in…") : register ? "Continue" : "Log in"}
        </button>
      </form>

      <p className="mt-6 border-t border-zinc-200 pt-5 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {register ? "Already have an account?" : "New to Twinstack?"}{" "}
        <Link href={switchHref} className="font-medium text-sky-700 hover:text-sky-900 dark:text-sky-400 dark:hover:text-sky-300">
          {register ? "Log in" : "Create an account"}
        </Link>
      </p>
    </AuthShell>
  );
}

const primaryButton =
  "w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-sky-600/20 transition-colors hover:bg-sky-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-default disabled:bg-sky-600/50 disabled:shadow-none dark:bg-sky-500 dark:hover:bg-sky-400 dark:disabled:bg-sky-500/40";

const PERKS = [
  "A ready-made website with its own free web address",
  "10,000 free Claude credits to write and design pages",
  "Nothing goes live until you press Publish",
];

/** The card: a coloured panel about Twinstack beside the form (the panel only on wider screens). */
function AuthShell({ register, children }: { register: boolean; children: React.ReactNode }) {
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
          <h2 className="text-2xl leading-snug font-semibold text-balance">
            {register ? "Your own website, without writing code." : "Pick up where you left off."}
          </h2>
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

function StepLabel({ step, label }: { step: 1 | 2; label: string }) {
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

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

function ErrorMessage({ text }: { text: string }) {
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

/**
 * Six boxes for the code. One real input lies invisibly over them, so typing, pasting and the
 * phone's "fill code from email" work as in a plain field; the boxes only show its digits.
 */
function CodeBoxes({
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

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7.5 8 5.5 8-5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
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
