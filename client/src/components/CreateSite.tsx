"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { repoNameFor, type Repo } from "@/lib/repos";
import { markSiteEntry } from "@/lib/site-entry";
import { Button, Details, Spinner, inputClass } from "./site/ui";

// What a copy goes through; the request is one call, so these advance on a timer while it runs.
const STAGES = ["Copying the website template", "Saving it to your GitHub account", "Giving it a web address"];
const IMPORT_STAGES = ["Checking your repository", "Adding it to your sites", "Giving it a web address"];
const ADOPT_STAGES = ["Checking your repository", "Adding the site tools to it", "Giving it a web address"];
const STAGE_MS = 6000;

type Source = "template" | "existing";
type Candidate = { id: number; fullName: string; private: boolean };
// POST /api/import/inspect: "site" is already a Twinstack site; "other" gets the site tools added.
type Inspection = { repo: string; kind: "site" | "other"; canAdopt: boolean };
const looksLikeRepo = (value: string) => /^[^/\s]+\/[^/\s]+$/.test(value.trim());

type Status =
  | { state: "idle" }
  | { state: "working" }
  | { state: "error"; message: string; reauth?: boolean }
  | { state: "done"; repo: Repo };

/**
 * Makes a new site, in a modal: copies the template into the user's GitHub account (POST
 * …/duplicate, which also turns on GitHub Pages), showing the steps while it works, then opens it
 * in the site editor. "Use a repo I already have" instead makes one of the owner's repos a site
 * (POST /api/import): as it is when it's already a Twinstack site, else with the site tools added.
 */
export function CreateSite({ template, login, onCreated, onCancel }: { template: Repo; login: string; onCreated: (repo: Repo) => void; onCancel?: () => void }) {
  const [source, setSource] = useState<Source>("template");
  const [siteName, setSiteName] = useState("");
  const [customName, setCustomName] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [stage, setStage] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState("");
  const [inspection, setInspection] = useState<Inspection | { error: string } | "checking" | null>(null);
  const [agreed, setAgreed] = useState(false);
  const nameId = useId();
  const router = useRouter();

  const name = customName ?? repoNameFor(siteName);
  const working = status.state === "working" || status.state === "done";
  const importMode = source === "existing" && inspection && typeof inspection === "object" && "kind" in inspection ? inspection : null;
  const stages = source === "template" ? STAGES : importMode?.kind === "other" ? ADOPT_STAGES : IMPORT_STAGES;

  useEffect(() => {
    if (status.state !== "working") return;
    const timer = setInterval(() => setStage((s) => Math.min(s + 1, stages.length - 1)), STAGE_MS);
    return () => clearInterval(timer);
  }, [status.state, stages.length]);

  useEffect(() => {
    if (source !== "existing" || candidates) return;
    fetch("/api/import/candidates")
      .then((res) => (res.ok ? res.json() : { repos: [] }))
      .then((data) => setCandidates(data.repos ?? []))
      .catch(() => setCandidates([]));
  }, [source, candidates]);

  function pick(value: string) {
    setPicked(value);
    setAgreed(false);
    setInspection(looksLikeRepo(value) ? "checking" : null);
  }

  // What the picked repo is, once it looks like owner/name.
  useEffect(() => {
    if (source !== "existing" || !looksLikeRepo(picked)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/import/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: picked.trim() }),
        signal: ctrl.signal,
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          const error =
            data.error === "reauth_required"
              ? "Your GitHub access has expired. Reconnect GitHub."
              : data.error && data.error !== "github_unavailable"
                ? data.error
                : `GitHub didn't answer while checking that repository (error ${res.status}). Try again.`;
          setInspection(res.ok ? data : { error });
        })
        .catch(() => {});
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [source, picked]);

  const canSubmit =
    source === "template" ? Boolean(name) : Boolean(importMode && (importMode.kind === "site" || (importMode.canAdopt && agreed)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStage(0);
    setStatus({ state: "working" });
    try {
      const res =
        source === "template"
          ? await fetch(`/api/repos/${template.owner}/${template.name}/duplicate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // Always public: GitHub Pages can't publish a private repo on a free plan.
              body: JSON.stringify({ name, displayName: siteName.trim(), private: false }),
            })
          : await fetch("/api/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repo: importMode!.repo, mode: importMode!.kind === "site" ? "site" : "adopt", displayName: siteName.trim() }),
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

  const doneStage = status.state === "done" ? stages.length : stage;

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
              {source === "template" ? "Creating" : "Setting up"} {siteName.trim() || (source === "template" ? "your site" : importMode?.repo)}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">This usually takes under a minute. Please keep this page open.</p>
          </div>
          <ol className="mx-auto mt-6 max-w-xs space-y-3 text-sm">
            {[...stages, "Opening your site"].map((label, index) => {
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
              <p className="mt-1 text-sm text-zinc-500">
                {source === "template"
                  ? "Start from a ready-made design. You can change everything afterwards."
                  : "Make a repository from your GitHub account into a site you manage here."}
              </p>
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

          <div role="radiogroup" aria-label="Start from" className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 text-sm dark:bg-zinc-900">
            {(
              [
                ["template", "Start fresh"],
                ["existing", "Use a repo I already have"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={source === value}
                onClick={() => setSource(value)}
                className={`rounded-md px-3 py-1.5 ${source === value ? "bg-background font-medium shadow-sm" : "text-zinc-600 hover:text-foreground dark:text-zinc-400"}`}
              >
                {label}
              </button>
            ))}
          </div>

          {source === "existing" && (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="block font-medium">Which repository?</span>
                <input
                  value={picked}
                  onChange={(e) => pick(e.target.value)}
                  list={`${nameId}-repos`}
                  placeholder={candidates === null ? "Loading your repositories…" : "owner/repository"}
                  className={`${inputClass} mt-1 py-2 font-mono`}
                  autoFocus
                />
                <datalist id={`${nameId}-repos`}>
                  {candidates?.map((repo) => <option key={repo.id} value={repo.fullName} />)}
                </datalist>
                <span className="mt-1 block text-xs text-zinc-500">Only repositories you&apos;re an admin of can be used.</span>
              </label>
              {inspection === "checking" && (
                <p className="flex items-center gap-2 text-sm text-zinc-500">
                  <Spinner /> Checking it…
                </p>
              )}
              {inspection && typeof inspection === "object" && "error" in inspection && (
                <p className="text-sm text-red-700 dark:text-red-300">{inspection.error}</p>
              )}
              {importMode?.kind === "site" && (
                <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  This is already a Twinstack site. It will be added to your sites as it is, and published from it with GitHub Pages.
                </p>
              )}
              {importMode?.kind === "other" && !importMode.canAdopt && (
                <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  This repository has its own package.json, so the site tools can&apos;t be added to it. Start fresh instead, then bring its pages in
                  with Pages → &quot;Bring in a page from another website&quot;.
                </p>
              )}
              {importMode?.kind === "other" && importMode.canAdopt && (
                <div className="space-y-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  <p>This isn&apos;t a Twinstack site yet. The site tools will be added to it in one change on its main branch:</p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>None of its files are changed or removed.</li>
                    <li>Its GitHub Pages switches to the new site, which starts with a simple homepage.</li>
                    <li>Its existing pages stay in the repository. Bring them in with Pages → &quot;Bring in a page from another website&quot;.</li>
                  </ul>
                  <label className="flex items-start gap-2 pt-1 font-medium">
                    <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
                    Add the site tools to {importMode.repo}
                  </label>
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor={nameId} className="block text-sm font-medium">
              What&apos;s your site called?
              {source === "existing" && <span className="font-normal text-zinc-500"> (optional)</span>}
            </label>
            <input
              id={nameId}
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              required={source === "template"}
              maxLength={100}
              placeholder="Bright Bakery"
              className={`${inputClass} mt-1 py-2`}
              autoFocus={source === "template"}
            />
            {source === "template" && name && (
              <p className="mt-1.5 text-xs text-zinc-500">
                Its web address will be <span className="font-medium text-foreground">{login.toLowerCase()}.github.io/{name}</span>. You
                can use your own domain name later.
              </p>
            )}
          </div>

          {source === "template" && <Details summary="More options">
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
          </Details>}

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
            <Button type="submit" variant="primary" className="px-5 py-2" disabled={!canSubmit}>
              {source === "template" ? "Create my site" : "Use this repository"}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
