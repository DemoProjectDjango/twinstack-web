import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { BUY_CREDITS_HREF, CLAUDE_SETUP_HREF } from "@/lib/claude";
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
        <Link href={CLAUDE_SETUP_HREF} className="font-medium underline">
          Set up Claude
        </Link>
      )}
      {error instanceof ApiError && error.outOfCredits && (
        <Link href={BUY_CREDITS_HREF} className="font-medium underline">
          Buy credits
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

/** A section heading for a whole screen of the site editor, with what it's for. */
export function ScreenHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-sm text-zinc-500">{description}</p>}
      </div>
      {children}
    </header>
  );
}

/** Nothing here yet: one sentence and the one thing to do about it. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-10 text-center dark:border-zinc-700">
      <p className="font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">{children}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export type Step = { id: string; title: string; text?: ReactNode; done: boolean; optional?: boolean; action?: ReactNode };

/** Numbered steps with ticks; the first step that isn't done is highlighted as the one to do next. */
export function StepList({ steps }: { steps: Step[] }) {
  const current = steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);
  return (
    <ol className="space-y-2">
      {steps.map((step, index) => {
        const active = step === current;
        return (
          <li
            key={step.id}
            className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${
              active ? "border-foreground" : "border-zinc-200 dark:border-zinc-800"
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-medium ${
                step.done ? "bg-green-600 text-white" : active ? "bg-foreground text-background" : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {step.done ? "✓" : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`font-medium ${step.done ? "text-zinc-500 line-through decoration-zinc-400" : ""}`}>
                {step.title}
                {step.optional && <span className="ml-2 text-xs font-normal text-zinc-500">Optional</span>}
                <span className="sr-only">{step.done ? " (done)" : ""}</span>
              </p>
              {step.text && !step.done && <p className="mt-0.5 text-sm text-zinc-500">{step.text}</p>}
            </div>
            {step.action && !step.done && <div className="flex shrink-0 flex-wrap gap-2">{step.action}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** A row of mutually exclusive choices (tabs within a screen). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex w-fit max-w-full flex-wrap gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-800">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded px-3 py-1 text-sm font-medium ${
            value === option.value ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Technical detail most people never need, folded away. */
export function Details({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer select-none px-3 py-2 text-zinc-600 hover:text-foreground dark:text-zinc-400">{summary}</summary>
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">{children}</div>
    </details>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-foreground dark:border-zinc-700"
    />
  );
}
