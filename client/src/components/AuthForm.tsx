"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { safeNext } from "@/lib/safe-next";
import {
  AuthShell,
  CodeBoxes,
  ErrorMessage,
  Field,
  MailIcon,
  PasswordInput,
  ResendButton,
  StepIcon,
  StepLabel,
  SuccessMessage,
  inputClass,
  postJson,
  primaryButton,
  textLink,
  useResendWait,
} from "@/components/auth/parts";

export function AuthForm({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // Registering emails a code first; the account is made once it's entered.
  const [pending, setPending] = useState<{ email: string; token: string } | null>(null);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const resendWait = useResendWait();
  const register = mode === "register";
  const destination = safeNext(next);
  const nextQuery = next ? `next=${encodeURIComponent(destination)}` : "";

  /** Runs one request; the form stays disabled when it signed in (true), while the page changes. */
  async function attempt(action: () => Promise<boolean | void>) {
    setWorking(true);
    setError(null);
    setCodeSent(false);
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

  async function sendCode() {
    const { res, data } = await postJson("/auth/register", { name, email, password });
    if (!res.ok) {
      resendWait.wait(data.retryAfter);
      // On the code screen the ring already says to wait.
      if (pending && res.status === 429 && data.retryAfter) return;
      return setError(data.error ?? "Something went wrong. Try again.");
    }
    setPending({ email: data.email, token: data.token });
    setCode("");
    setCodeSent(true);
    resendWait.wait(data.retryAfter ?? 60);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    attempt(async () => {
      if (register) return sendCode();
      const { res, data } = await postJson("/auth/login", { email, password });
      if (!res.ok) return setError(data.error ?? "Something went wrong. Try again.");
      return signedIn();
    });
  }

  function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    attempt(async () => {
      const { res, data } = await postJson("/auth/register/verify", { ...pending, code });
      if (res.ok) return signedIn();
      if (data.restart) setPending(null);
      setError(data.error ?? "Something went wrong. Try again.");
    });
  }

  if (pending) {
    return (
      <AuthShell panel="register">
        <StepLabel step={2} label="Confirm your email" />
        <StepIcon>
          <MailIcon />
        </StepIcon>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          We sent a 6-digit code to <span className="font-medium text-foreground">{pending.email}</span>. It expires in 15
          minutes. If it isn&apos;t there, look in your spam folder.
        </p>

        <form onSubmit={verify} className="mt-7 space-y-5">
          <CodeBoxes value={code} onChange={setCode} disabled={working} invalid={Boolean(error)} />
          {codeSent && !error && <SuccessMessage text="Code sent. Check your inbox." />}
          {error && <ErrorMessage text={error} />}
          <button type="submit" disabled={working || code.length !== 6} className={primaryButton}>
            {working ? "Checking…" : "Create account"}
          </button>
        </form>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-5 text-sm dark:border-zinc-800">
          <ResendButton wait={resendWait} disabled={working} onClick={() => attempt(sendCode)} />
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

  const forgotQuery = [email ? `email=${encodeURIComponent(email)}` : "", nextQuery].filter(Boolean).join("&");
  const forgotHref = `/forgot-password${forgotQuery ? `?${forgotQuery}` : ""}`;

  return (
    <AuthShell panel={register ? "register" : "login"}>
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
        <Field
          label="Password"
          htmlFor="auth-password"
          hint={register ? "At least 8 characters." : undefined}
          aside={
            !register && (
              <Link href={forgotHref} className={textLink}>
                Forgot password?
              </Link>
            )
          }
        >
          <PasswordInput id="auth-password" value={password} onChange={setPassword} disabled={working} isNew={register} />
        </Field>

        {error && <ErrorMessage text={error} />}

        <button type="submit" disabled={working} className={primaryButton}>
          {working ? (register ? "Sending code…" : "Logging in…") : register ? "Continue" : "Log in"}
        </button>
      </form>

      <p className="mt-6 border-t border-zinc-200 pt-5 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {register ? "Already have an account?" : "New to Twinstack?"}{" "}
        <Link href={`${register ? "/login" : "/register"}${nextQuery ? `?${nextQuery}` : ""}`} className={textLink}>
          {register ? "Log in" : "Create an account"}
        </Link>
      </p>
    </AuthShell>
  );
}
