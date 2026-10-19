"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { safeNext } from "@/lib/safe-next";
import { toast } from "@/lib/toast";
import {
  AuthShell,
  CodeBoxes,
  ErrorMessage,
  Field,
  KeyIcon,
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

/**
 * Reset a forgotten password: an emailed code (POST /auth/password/forgot), then the code with
 * a new password (/auth/password/reset), which signs this browser in. Other browsers stay
 * signed in unless the person then chooses to sign them out (/auth/sessions/end-others).
 */
export function ForgotPasswordForm({ initialEmail, next }: { initialEmail?: string; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [pending, setPending] = useState<{ email: string; token: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [working, setWorking] = useState(false);
  const resendWait = useResendWait();
  const destination = safeNext(next);
  const loginHref = `/login${next ? `?next=${encodeURIComponent(destination)}` : ""}`;

  /** Runs one request; the form stays disabled when it finished (true), while the page changes. */
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

  async function sendCode() {
    const { res, data } = await postJson("/auth/password/forgot", { email: pending?.email ?? email });
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

  function requestCode(e: React.FormEvent) {
    e.preventDefault();
    attempt(sendCode);
  }

  function reset(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    attempt(async () => {
      const { res, data } = await postJson("/auth/password/reset", { ...pending, code, password });
      if (!res.ok) {
        if (data.restart) setPending(null);
        return setError(data.error ?? "Something went wrong. Try again.");
      }
      await askAboutOtherDevices();
      // refresh() re-renders server components (the navbar) with the new session.
      router.replace(destination);
      router.refresh();
      return true;
    });
  }

  async function askAboutOtherDevices() {
    const signOut = await confirmModal(
      "Anyone signed in to your account on another browser, phone or computer will have to log in again with your new password. If you think someone else knew your old password, sign them out.",
      { title: "Password changed. Sign out other devices?", confirmLabel: "Sign out other devices", cancelLabel: "Keep them signed in" },
    );
    if (!signOut) return toast.success("Your password was changed.");
    try {
      const { res } = await postJson("/auth/sessions/end-others", {});
      if (!res.ok) throw new Error();
      toast.success("Password changed. Other devices are signed out.");
    } catch {
      toast.error("Your password was changed, but other devices couldn't be signed out. Reset it again to get another try.");
    }
  }

  if (pending) {
    return (
      <AuthShell panel="reset">
        <StepLabel step={2} label="Choose a new password" />
        <StepIcon>
          <KeyIcon />
        </StepIcon>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          If an account uses <span className="font-medium text-foreground">{pending.email}</span>, we&apos;ve sent it a
          6-digit code. It expires in 15 minutes. If it isn&apos;t there, look in your spam folder.
        </p>

        <form onSubmit={reset} className="mt-7 space-y-5">
          <CodeBoxes value={code} onChange={setCode} disabled={working} invalid={Boolean(error)} />
          <Field label="New password" htmlFor="reset-password" hint="At least 8 characters.">
            <PasswordInput id="reset-password" value={password} onChange={setPassword} disabled={working} isNew />
          </Field>
          {codeSent && !error && <SuccessMessage text="Code sent. Check your inbox." />}
          {error && <ErrorMessage text={error} />}
          <button type="submit" disabled={working || code.length !== 6 || password.length < 8} className={primaryButton}>
            {working ? "Saving…" : "Change password"}
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

  return (
    <AuthShell panel="reset">
      <StepLabel step={1} label="Your email" />
      <StepIcon>
        <MailIcon />
      </StepIcon>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
        Enter the email you log in with. We&apos;ll send you a code to choose a new password.
      </p>

      <form onSubmit={requestCode} className="mt-7 space-y-5">
        <Field label="Email" htmlFor="reset-email">
          <input
            id="reset-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            autoComplete="email"
            autoFocus
            placeholder="you@example.com"
            disabled={working}
            className={inputClass}
          />
        </Field>
        {error && <ErrorMessage text={error} />}
        <button type="submit" disabled={working} className={primaryButton}>
          {working ? "Sending code…" : "Send code"}
        </button>
      </form>

      <p className="mt-6 border-t border-zinc-200 pt-5 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        Remembered it?{" "}
        <Link href={loginHref} className={textLink}>
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
