"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { repoNameFor, type Repo } from "@/lib/repos";
import { Button, Details, inputClass } from "./site/ui";

// What a copy goes through; the request is one call, so these advance on a timer while it runs.
const STAGES = ["Copying the website template", "Saving it to your GitHub account", "Giving it a web address"];
const STAGE_MS = 6000;

type Status =
  | { state: "idle" }
  | { state: "working" }
  | { state: "error"; message: string; reauth?: boolean }
  | { state: "done"; repo: Repo };

/**
 * Makes a new site: copies the template into the user's GitHub account (POST …/duplicate, which
 * also turns on GitHub Pages) and opens it in the site editor.
 */
export function CreateSite({ template, login, onCreated, onCancel }: { template: Repo; login: string; onCreated: (repo: Repo) => void; onCancel?: () => void }) {
  const [siteName, setSiteName] = useState("");
  const [customName, setCustomName] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(false);
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
        body: JSON.stringify({ name, private: isPrivate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reauth = data.error === "reauth_required";
        return setStatus({
          state: "error",
          reauth,
          message: reauth ? (data.message ?? "Your GitHub access has expired.") : (data.error ?? "Creating the site didn't work. Try again."),
        });
      }
      setStatus({ state: "done", repo: data.repo });
      onCreated(data.repo);
      // Straight on to the new site.
      router.push(`/sites/${encodeURIComponent(data.repo.owner)}/${encodeURIComponent(data.repo.name)}`);
    } catch {
      setStatus({ state: "error", message: "Network error. The site may still have been created: refresh this page to check." });
    }
  }

  if (working) {
    return (
      <section className="rounded-lg border border-foreground p-5" aria-live="polite">
        <h3 className="font-semibold">Creating your site</h3>
        <ol className="mt-4 space-y-2 text-sm">
          {[...STAGES, "Opening your site"].map((label, index) => {
            const doneStage = status.state === "done" ? STAGES.length : stage;
            const state = index < doneStage ? "done" : index === doneStage ? "now" : "later";
            return (
              <li key={label} className={`flex items-center gap-2 ${state === "later" ? "text-zinc-400" : ""}`}>
                <span aria-hidden="true" className="w-4 text-center">
                  {state === "done" ? "✓" : state === "now" ? "…" : "·"}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-xs text-zinc-500">This usually takes under a minute. Keep this page open.</p>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-foreground p-5">
      <div className="flex items-center gap-3">
        <h3 className="font-semibold">Create your site</h3>
        {onCancel && (
          <Button variant="ghost" className="ml-auto" onClick={onCancel}>
            Cancel
          </Button>
        )}
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
          <p className="mt-1 text-xs text-zinc-500">
            Its web address will be <span className="font-mono">https://{login}.github.io/{name}/</span>. You can use your own
            domain name later.
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
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="mt-1" />
            <span>
              Keep the site&apos;s files private on GitHub
              <span className="block text-xs text-zinc-500">
                The published site is public either way. Publishing a private one needs a paid GitHub plan.
              </span>
            </span>
          </label>
        </div>
      </Details>

      {status.state === "error" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {status.message}{" "}
          {status.reauth && (
            <a href="/auth/github" className="font-medium underline">
              Reconnect GitHub
            </a>
          )}
        </p>
      )}

      <Button type="submit" variant="primary" className="px-5 py-2" disabled={!name}>
        Create my site
      </Button>
    </form>
  );
}
