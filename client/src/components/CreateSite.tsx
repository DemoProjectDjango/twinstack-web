"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { repoNameFor, type Repo } from "@/lib/repos";
import { markSiteEntry } from "@/lib/site-entry";
import { Button, Details, Spinner, inputClass } from "./site/ui";

// What a copy goes through; the request is one call, so these advance on a timer while it runs.
const STAGES = ["Copying the website template", "Saving it to your GitHub account", "Giving it a web address"];
const STAGE_MS = 6000;

type Status =
  | { state: "idle" }
  | { state: "working" }
  | { state: "error"; message: string; reauth?: boolean }
  | { state: "done"; repo: Repo };

/**
 * Makes a new site, in a modal: copies the template into the user's GitHub account (POST
 * …/duplicate, which also turns on GitHub Pages), showing the steps while it works, then opens it
 * in the site editor.
 */
export function CreateSite({ template, login, onCreated, onCancel }: { template: Repo; login: string; onCreated: (repo: Repo) => void; onCancel?: () => void }) {
  const [siteName, setSiteName] = useState("");
  const [customName, setCustomName] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [stage, setStage] = useState(0);
  const nameId = useId();
  const router = useRouter();

  const name = customName ?? repoNameFor(siteName);
  const working = status.state === "working" || status.state === "done";

  useEffect(() => {
    if (status.state !== "working") return;
    const timer = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), STAGE_MS);
    return () => clearInterval(timer);
  }, [status.state]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStage(0);
    setStatus({ state: "working" });
    try {
      const res = await fetch(`/api/repos/${template.owner}/${template.name}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Always public: GitHub Pages can't publish a private repo on a free plan.
        body: JSON.stringify({ name, displayName: siteName.trim(), private: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reauth = data.error === "reauth_required";
        return setStatus({
          state: "error",
          reauth,
          message: reauth
            ? (data.message ?? "Your GitHub access has expired.")
            : (data.message ?? data.error ?? "Creating the site didn't work. Try again."),
        });
      }
      setStatus({ state: "done", repo: data.repo });
      onCreated(data.repo);
      // Straight on to the new site.
      markSiteEntry(data.repo.owner, data.repo.name);
      router.push(`/sites/${encodeURIComponent(data.repo.owner)}/${encodeURIComponent(data.repo.name)}`);
    } catch {
      setStatus({ state: "error", message: "Network error. The site may still have been created: refresh this page to check." });
    }
  }

  // showModal() traps focus and dims the page. While the site is being made the dialog can't be
  // closed (Escape, the backdrop and Cancel do nothing): leaving wouldn't stop it on GitHub.
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  const close = () => {
    if (!working) onCancel?.();
  };

  const doneStage = status.state === "done" ? STAGES.length : stage;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${nameId}-title`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800"
    >
      {working ? (
        <div className="p-6" aria-live="polite">
          <div className="flex flex-col items-center text-center">
            <span
              aria-hidden="true"
              className="size-10 animate-spin rounded-full border-[3px] border-zinc-200 border-t-foreground dark:border-zinc-800"
            />
            <h2 id={`${nameId}-title`} className="mt-4 text-lg font-semibold">
              Creating {siteName.trim() || "your site"}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">This usually takes under a minute. Please keep this page open.</p>
          </div>
          <ol className="mx-auto mt-6 max-w-xs space-y-3 text-sm">
            {[...STAGES, "Opening your site"].map((label, index) => {
              const state = index < doneStage ? "done" : index === doneStage ? "now" : "later";
              return (
                <li key={label} className={`flex items-center gap-3 ${state === "later" ? "text-zinc-400" : ""}`}>
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {state === "done" ? (
                      <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500 text-xs text-white">✓</span>
                    ) : state === "now" ? (
                      <Spinner />
                    ) : (
                      <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                    )}
                  </span>
                  <span className={state === "now" ? "font-medium" : ""}>
                    {label}
                    {state === "done" && <span className="sr-only"> (done)</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5 p-6">
          <div className="flex items-start gap-3">
            <div>
              <h2 id={`${nameId}-title`} className="text-lg font-semibold">
                Create a new site
              </h2>
              <p className="mt-1 text-sm text-zinc-500">Start from a ready-made design. You can change everything afterwards.</p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="-mr-2 -mt-1 ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-900"
            >
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div>
            <label htmlFor={nameId} className="block text-sm font-medium">
              What&apos;s your site called?
            </label>
            <input
              id={nameId}
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              required
              maxLength={100}
              placeholder="Bright Bakery"
              className={`${inputClass} mt-1 py-2`}
              autoFocus
            />
            {name && (
              <p className="mt-1.5 text-xs text-zinc-500">
                Its web address will be <span className="font-medium text-foreground">{login.toLowerCase()}.github.io/{name}</span>. You
                can use your own domain name later.
              </p>
            )}
          </div>

          <Details summary="More options">
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Name on GitHub</span>
                <input
                  value={name}
                  onChange={(e) => setCustomName(e.target.value)}
                  pattern="[A-Za-z0-9._\-]{1,100}"
                  title="Letters, numbers, '.', '-' or '_'"
                  className={`${inputClass} mt-1 font-mono`}
                />
                <span className="mt-1 block text-xs text-zinc-500">Also the last part of the web address.</span>
              </label>
            </div>
          </Details>

          {status.state === "error" && (
            <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {status.message}{" "}
              {status.reauth && (
                <a href="/auth/github" className="font-medium underline">
                  Reconnect GitHub
                </a>
              )}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {onCancel && (
              <Button onClick={close} className="px-4 py-2">
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" className="px-5 py-2" disabled={!name}>
              Create my site
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
