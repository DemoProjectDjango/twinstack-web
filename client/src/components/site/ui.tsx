import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ApiError } from "@/lib/site-api";

const VARIANTS = {
  primary: "bg-foreground text-background hover:opacity-90",
  secondary: "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900",
  danger: "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
  ghost: "hover:bg-zinc-100 dark:hover:bg-zinc-900",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export const inputClass =
  "w-full rounded-md border border-zinc-300 bg-background px-2.5 py-1.5 text-sm disabled:opacity-60 dark:border-zinc-700";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <h3 className="font-semibold">{title}</h3>
      {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const TONES = {
  info: "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  success: "border-green-300 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200",
};

export function Notice({ tone = "info", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <div className={`rounded-md border px-3 py-2 text-sm ${TONES[tone]}`}>{children}</div>;
}

/** Shows an error, with the fix inline when there is one. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {message}{" "}
      {error instanceof ApiError && error.reauth && (
        <a href="/auth/github" className="font-medium underline">
          Reconnect GitHub
        </a>
      )}
      {error instanceof ApiError && error.needsAnthropicKey && (
        <Link href="/dashboard#anthropic-key" className="font-medium underline">
          Add your key
        </Link>
      )}
    </p>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </span>
  );
}
