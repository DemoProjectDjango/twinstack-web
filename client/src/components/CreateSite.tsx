"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { repoNameFor, type Repo } from "@/lib/repos";
import { setPendingSetup, type SetupAnswers } from "@/lib/setup";
import { markSiteEntry } from "@/lib/site-entry";
import { SetupFlow } from "./setup/SetupFlow";
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

// Starting fresh asks the setup questions before the site is made (setup/SetupFlow.tsx): what the
// business does, a brief, the AI's analysis and the questions it chose, then a review. The editor
// applies the answers once the site opens (lib/setup.ts, site/FirstRunSetup.tsx).

/**
 * Makes a new site, in a modal: its name, then the setup questions (full screen), then copies the template into the user's
 * GitHub account (POST …/duplicate, which also turns on GitHub Pages), showing the steps while it
 * works, then opens it in the site editor. "Use a repo I already have" instead makes one of the
 * owner's repos a site (POST /api/import): as it is when it's already a Twinstack site, else with
 * the site tools added.
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
  // The setup questions, full screen, once the name is given (or skipped).
  const [asking, setAsking] = useState(false);
  const nameId = useId();
  const router = useRouter();

  // Skipping the name makes the site with the template's placeholder, "My Website".
  const name = customName ?? repoNameFor(siteName.trim() || "My Website");
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

  const canSubmit = source === "template" ? Boolean(name) : Boolean(importMode && (importMode.kind === "site" || (importMode.canAdopt && agreed)));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (source === "template") setAsking(true);
    else void create(null);
  }

  /** Makes the site (with the setup's answers when starting fresh) and opens it. */
  async function create(setup: SetupAnswers | null) {
    setAsking(false);
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
      // Straight on to the new site, which applies the setup answers as it opens.
      if (setup) setPendingSetup(data.repo.owner, data.repo.name, setup);
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
        // A file picker closed without a choice fires `cancel` on its input, and it bubbles here.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        // During the questions, only the close button leaves: the answers aren't lost by accident.
        if (!asking) close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !asking) close();
      }}
      className={`m-auto w-[calc(100%-2rem)] ${asking ? "max-w-xl" : "max-w-lg"} ${asking ? "max-h-[calc(100dvh-2rem)] overflow-hidden" : "overflow-visible"} rounded-xl border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800`}
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
      ) : asking ? (
        // The setup questions, in this same window so its look doesn't change after the name.
        // The title and the steps' progress stay in view; the step itself scrolls (SetupFlow).
        <div className="flex max-h-[calc(100dvh-2rem-2px)] flex-col px-6 pt-6">
          <div className="flex shrink-0 items-start gap-3">
            <div>
              <h2 id={`${nameId}-title`} className="text-lg font-semibold">
                Create a new site
              </h2>
              <p className="mt-1 text-sm text-zinc-500">A few questions about your business. Nothing is created until you&apos;ve checked your answers.</p>
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
          <div className="mt-5 flex min-h-0 flex-col">
            <SetupFlow
              embedded
              name={siteName.trim()}
              finishLabel="Create my site"
              finishNote="Then your site is made, and Claude builds it from your answers."
              onBack={() => setAsking(false)}
              onCancel={close}
              onDone={(setup) => create(setup)}
            />
          </div>
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

          <>
            {source === "template" && (
              <div>
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className={`h-1 flex-1 rounded-full ${i === 0 ? "bg-foreground" : "bg-zinc-200 dark:bg-zinc-800"}`} />
                  ))}
                </div>
                <p className="mt-3 text-xs font-medium text-zinc-500">Step 1</p>
              </div>
            )}
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
                <RepoPicker candidates={candidates} picked={picked} onPick={pick} />
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
            {source === "template" && <p className="text-sm text-zinc-500">Next: a few questions about your business, chosen by the AI from what you tell it. Nothing is created until you&apos;ve checked your answers.</p>}
          </>

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
              <Button onClick={close} className="mr-auto px-4 py-2">
                Cancel
              </Button>
            )}
            {source === "template" && (
              <Button variant="ghost" onClick={() => setAsking(true)} className="px-4 py-2 text-zinc-500">
                Skip
              </Button>
            )}
            <Button type="submit" variant="primary" className="px-5 py-2" disabled={!canSubmit}>
              {source === "template" ? "Continue" : "Use this repository"}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

function RepoIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3.5 2.5h8a1 1 0 0 1 1 1v9.5h-8.5a1.5 1.5 0 0 1 0-3h8.5" strokeLinejoin="round" />
      <path d="M3.5 2.5v9" />
    </svg>
  );
}

function VisibilityBadge({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        isPrivate
          ? "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"
          : "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
      }`}
    >
      {isPrivate ? "Private" : "Public"}
    </span>
  );
}

function RepoName({ fullName }: { fullName: string }) {
  const [owner, name] = fullName.split("/");
  return (
    <span className="min-w-0 truncate">
      <span className="text-zinc-500">{owner} / </span>
      <span className="font-medium text-foreground">{name}</span>
    </span>
  );
}

/**
 * Picks one of the owner's repositories from a dropdown: a select-style button that opens a
 * search box over a scrollable list (arrow keys and Enter work; Escape or a click outside closes
 * it). A typed owner/name that isn't listed can still be used, since the list only has repos
 * GitHub returned.
 */
function RepoPicker({ candidates, picked, onPick }: { candidates: Candidate[] | null; picked: string; onPick: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const q = query.trim().toLowerCase();
  const matches = (candidates ?? []).filter((repo) => repo.fullName.toLowerCase().includes(q));
  const typed = looksLikeRepo(query) && !matches.some((repo) => repo.fullName.toLowerCase() === q) ? query.trim() : null;
  const options = [...matches.map((repo) => repo.fullName), ...(typed ? [typed] : [])];
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
  const chosen = candidates?.find((repo) => repo.fullName === picked);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function show() {
    setQuery("");
    const index = candidates?.findIndex((repo) => repo.fullName === picked) ?? -1;
    setActive(Math.max(index, 0));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function choose(value: string) {
    onPick(value);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      // Never submit the form from the search box.
      e.preventDefault();
      if (options[activeIndex]) choose(options[activeIndex]);
    } else if (e.key === "Escape") {
      // Close the dropdown, not the whole dialog.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  return (
    <div ref={rootRef} className="relative text-sm">
      <span className="block font-medium">Which repository?</span>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        autoFocus
        className={`mt-1 flex w-full items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left hover:border-zinc-400 dark:hover:border-zinc-500 ${
          open ? "border-zinc-500 ring-2 ring-zinc-200 dark:ring-zinc-800" : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <RepoIcon className="size-4 shrink-0 text-zinc-500" />
        {picked ? (
          <RepoName fullName={picked} />
        ) : (
          <span className="truncate text-zinc-400">{candidates === null ? "Loading your repositories…" : "Choose a repository"}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {chosen && <VisibilityBadge isPrivate={chosen.private} />}
          <svg
            viewBox="0 0 16 16"
            className={`size-4 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-zinc-200 bg-background shadow-lg dark:border-zinc-800">
          <div className="flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
            <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-label="Search your repositories"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={options.length ? `${listId}-${activeIndex}` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search or type owner/repository"
              className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-zinc-400"
              autoFocus
            />
            {candidates && candidates.length > 0 && (
              <span className="shrink-0 text-xs text-zinc-400">
                {matches.length}/{candidates.length}
              </span>
            )}
          </div>

          {candidates === null ? (
            <div className="flex items-center gap-2 px-3 py-5 text-zinc-500">
              <Spinner /> Loading your repositories…
            </div>
          ) : options.length === 0 ? (
            <div className="px-3 py-5 text-center text-zinc-500">
              {candidates.length === 0 ? "No repositories you can use were found." : `No repositories match “${query.trim()}”.`}
              <span className="mt-1 block text-xs">You can also type one as owner/repository.</span>
            </div>
          ) : (
            <ul ref={listRef} id={listId} role="listbox" aria-label="Your repositories" className="max-h-56 overflow-y-auto py-1">
              {options.map((fullName, index) => {
                const repo = index < matches.length ? matches[index] : null;
                const isPicked = fullName === picked;
                return (
                  <li
                    key={repo ? repo.id : `typed-${fullName}`}
                    id={`${listId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={isPicked}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(fullName)}
                    className={`mx-1 flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 ${index === activeIndex ? "bg-zinc-100 dark:bg-zinc-900" : ""}`}
                  >
                    <RepoIcon className="size-4 shrink-0 text-zinc-400" />
                    {repo ? (
                      <RepoName fullName={fullName} />
                    ) : (
                      <span className="min-w-0 truncate">
                        Use <span className="font-medium">{fullName}</span>
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {repo && <VisibilityBadge isPrivate={repo.private} />}
                      <span className={`w-4 text-foreground ${isPicked ? "" : "invisible"}`} aria-hidden="true">
                        ✓
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <span className="mt-1.5 block text-xs text-zinc-500">Only repositories you&apos;re an admin of are listed.</span>
    </div>
  );
}
