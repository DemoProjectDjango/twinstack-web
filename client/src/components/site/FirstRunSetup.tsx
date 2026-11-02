"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, isHomePage, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { creditsFailedSnapshot, creditsSnapshot, subscribeCredits } from "@/lib/credits-store";
import { TEMPLATE_SITE_NAME as TEMPLATE_NAME } from "@/lib/repos";
import { clearPendingSetup, peekPendingSetup, readAsBase64, setupBody, type SetupAnswers } from "@/lib/setup";
import { clearSiteEntry, readSiteEntry } from "@/lib/site-entry";
import { SetupFlow } from "../setup/SetupFlow";
import { useAssistant } from "./assistant/AssistantProvider";
import { markVisited } from "./HomePanel";
import { useSite } from "./site-context";
import { Button, ErrorText } from "./ui";

// A new site's setup. Create a new site asks its questions before the site exists (setup/SetupFlow:
// what the business does, a brief, the AI's analysis and the questions it chose, then a review), and
// lib/setup.ts hands the answers over. Here they're applied as soon as the site is ready (AutoSetup):
// the logo and photos are uploaded, the server saves the rest (POST …/setup: Business info, the
// header's name and logo, the notes' site profile) and returns the build request, which goes to Ask
// Claude: the homepage, a matching header and footer, and the skill's other pages.
// A site entered from the dashboard without those answers (a repo brought in, or the editor reloaded
// after creating) gets the same questions here instead, with its name first, until it has a real
// name and says what the business does (site.config.json `description`, which Business info also
// sets). Never on a reload (lib/site-entry.ts), and SiteManager mounts it, so moving between screens
// doesn't bring it back. Skipping hides it for this visit.

export function FirstRunSetup() {
  const { owner, repo, overview } = useSite();
  // Only when entered from the dashboard; skipped or finished hides it for the rest of the visit.
  // (The overview loads in the browser, so this renders nothing during hydration either way.)
  const [hidden, setHidden] = useState(() => typeof window === "undefined" || !readSiteEntry(owner, repo));
  // The answers Create a new site collected, if this is the site it just made.
  const [pending] = useState(() => (typeof window === "undefined" ? null : peekPendingSetup(owner, repo)));
  useEffect(() => {
    clearSiteEntry(owner, repo);
    clearPendingSetup(owner, repo);
  }, [owner, repo]);

  if (hidden || !overview) return null;
  if (pending) return <AutoSetup setup={pending} onDone={() => setHidden(true)} />;
  const siteName = overview.site.name?.trim();
  const named = Boolean(siteName) && siteName !== TEMPLATE_NAME;
  // Servers from before `description` was sent: the old rule, the name the site was created with.
  const described = overview.site.description === undefined ? named && siteName !== overview.displayName : Boolean(overview.site.description.trim());
  if (named && described) return null;

  return <AskSetup onDone={() => setHidden(true)} />;
}

/** Saves the setup's answers into the site, then asks Claude to build it. Throws when a save fails. */
function useApplySetup() {
  const { owner, repo, overview, claude, refresh, setStatus } = useSite();
  const { send } = useAssistant();

  return async function apply(setup: SetupAnswers) {
    // 1. The files, where the editor's uploads go.
    let logo: string | undefined;
    if (setup.logo) {
      const saved = await api<{ path: string }>(workspacePath(owner, repo, "/brand/image"), { method: "POST", body: { name: setup.logo.name, data: await readAsBase64(setup.logo) } });
      logo = saved.path;
    }
    const photos: string[] = [];
    for (const photo of setup.photos) {
      const saved = await api<{ path: string }>(workspacePath(owner, repo, "/uploads"), { method: "POST", body: { name: photo.name, data: await readAsBase64(photo) } });
      photos.push(saved.path);
    }
    // 2. The answers, saved by the server, which returns the build request.
    const hasHome = overview?.collections.some((c) => c.pages.some(isHomePage)) ?? false;
    const saved = await api<{ request: string; status: WorkspaceStatus }>(workspacePath(owner, repo, "/setup"), {
      method: "POST",
      body: {
        setup: setupBody(setup, { logo, photos }),
        // A new site has only its starter homepage: Claude needn't look around first.
        options: { hasHome, chrome: Boolean(overview?.features.chromeDesign), fresh: (overview?.collections.flatMap((c) => c.pages).length ?? 0) <= 1 },
      },
    });
    setStatus(saved.status);
    // These answers are the site details the first publish would ask to check.
    markVisited(owner, repo, "details");
    await refresh();
    // 3. Claude builds the site from them.
    if (claude.ready) await send(saved.request);
  };
}

/** The window shown while the setup is saved: a spinner, or what went wrong. */
function SetupWindow({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="first-run-heading"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-zinc-200 bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm dark:border-zinc-800"
    >
      {children}
    </dialog>
  );
}

/**
 * Applies the answers Create a new site collected, once the site can take them: its overview loaded,
 * nothing else running on it, and the account's Claude credits known (so the build isn't skipped
 * for credits still loading).
 */
function AutoSetup({ setup, onDone }: { setup: SetupAnswers; onDone: () => void }) {
  const { busy } = useSite();
  const apply = useApplySetup();
  const credits = useSyncExternalStore(subscribeCredits, creditsSnapshot, () => null);
  const creditsFailed = useSyncExternalStore(subscribeCredits, creditsFailedSnapshot, () => false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(-1);
  const ready = !busy && (credits !== null || creditsFailed);

  useEffect(() => {
    if (!ready || started.current === attempt) return;
    started.current = attempt;
    apply(setup).then(onDone, setError);
    // `apply` is new each render; the attempt and readiness decide when to run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, attempt]);

  return (
    <SetupWindow onCancel={() => error && onDone()}>
      {error ? (
        <div className="p-6 sm:p-8">
          <h2 id="first-run-heading" className="text-lg font-semibold">
            Your answers couldn&apos;t all be saved
          </h2>
          <div className="mt-3">
            <ErrorText error={error} />
          </div>
          <div className="mt-6 flex items-center gap-2">
            <Button variant="ghost" onClick={onDone} className="px-4 py-2 text-zinc-500">
              Skip for now
            </Button>
            <Button
              variant="primary"
              className="ml-auto px-5 py-2"
              onClick={() => {
                setError(null);
                setAttempt(attempt + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center px-8 py-14 text-center" aria-live="polite">
          <span aria-hidden="true" className="size-10 animate-spin rounded-full border-[3px] border-zinc-200 border-t-foreground dark:border-zinc-800" />
          <h2 id="first-run-heading" className="mt-5 text-lg font-semibold">
            Setting up {setup.name || "your site"}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">{setup.photos.length || setup.logo ? "Saving your answers and pictures…" : "Saving your answers…"}</p>
        </div>
      )}
    </SetupWindow>
  );
}

/** The setup questions for a site that opened without answers, its name first. */
function AskSetup({ onDone }: { onDone: () => void }) {
  const { owner, repo, overview, claude } = useSite();
  const apply = useApplySetup();
  const siteName = overview?.site.name?.trim();
  const name = siteName && siteName !== TEMPLATE_NAME ? siteName : (overview?.displayName ?? "");
  return (
    <SetupFlow
      name={name}
      askName
      title="Set up your site"
      planUrl={workspacePath(owner, repo, "/setup/plan")}
      finishLabel={claude.ready ? "Build my site" : "Save my answers"}
      finishNote={claude.ready ? "Then Claude builds your site from your answers." : undefined}
      onCancel={onDone}
      onDone={async (setup) => {
        await apply(setup);
        onDone();
      }}
    />
  );
}
