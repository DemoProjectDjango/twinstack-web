"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, isHomePage, workspacePath, type BrandInfo, type Json, type StaticSection, type WorkspaceStatus } from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
import { markVisited } from "./HomePanel";
import { TEMPLATE_SITE_NAME as TEMPLATE_NAME } from "@/lib/repos";
import { clearSiteEntry, readSiteEntry } from "@/lib/site-entry";
import { useSite } from "./site-context";
import { Button, ErrorText, inputClass } from "./ui";

// A new site's setup: three questions (the business's name, what it does, a few photos), then
// straight to the site. The answers go where the owner would otherwise type them (Business info,
// the header's name, the site's images), and with the AI set up, it's asked to design the homepage
// from them. Shown when the owner enters the site from the dashboard (lib/site-entry.ts: not on a
// reload, and SiteManager mounts it, so moving between screens doesn't bring it back) until the site
// has a real name and says what the business does (site.config.json `description`, which Business
// info also sets). Skipping hides it for this visit.

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

const isObject = (value: Json | undefined): value is { [key: string]: Json } => value !== null && typeof value === "object" && !Array.isArray(value);

export function FirstRunSetup() {
  const { owner, repo, overview } = useSite();
  // Only when entered from the dashboard; skipped or finished hides it for the rest of the visit.
  // (The overview loads in the browser, so this renders nothing during hydration either way.)
  const [hidden, setHidden] = useState(() => typeof window === "undefined" || !readSiteEntry(owner, repo));
  useEffect(() => clearSiteEntry(owner, repo), [owner, repo]);

  if (hidden || !overview) return null;
  const siteName = overview.site.name?.trim();
  const named = Boolean(siteName) && siteName !== TEMPLATE_NAME;
  // Servers from before `description` was sent: the old rule, the name the site was created with.
  const described = overview.site.description === undefined ? named && siteName !== overview.displayName : Boolean(overview.site.description.trim());
  if (named && described) return null;

  return <SetupDialog onDone={() => setHidden(true)} />;
}

const STEPS = 3;

/**
 * The questions in a centred window, one at a time (name, what the business does, photos), so a
 * new owner meets one calm question instead of a form among the editor's banners. It opens right
 * after Create a new site's window, in the same style.
 */
function SetupDialog({ onDone }: { onDone: () => void }) {
  const { owner, repo, overview, claude, busy, refresh, setStatus } = useSite();
  const { send } = useAssistant();
  const [step, setStep] = useState(0);
  // Starts as the name the site was created with, until the owner types.
  const [typedName, setName] = useState<string | null>(null);
  const [what, setWhat] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const siteName = overview?.site.name ?? null;
  const name = typedName ?? overview?.displayName ?? "";
  const finish = onDone;

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  // Thumbnails of the chosen photos, freed when they change.
  const previews = useMemo(() => photos.map((photo) => ({ name: photo.name, url: URL.createObjectURL(photo) })), [photos]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  function pick(files: FileList | null) {
    const picked = [...photos, ...Array.from(files ?? [])];
    const tooBig = picked.find((f) => f.size > MAX_PHOTO_BYTES);
    setError(tooBig ? new Error(`${tooBig.name} is over 5 MB.`) : picked.length > MAX_PHOTOS ? new Error(`You can add up to ${MAX_PHOTOS} photos.`) : null);
    setPhotos(picked.filter((f) => f.size <= MAX_PHOTO_BYTES).slice(0, MAX_PHOTOS));
  }

  async function submit() {
    const business = name.trim();
    const description = what.trim();
    if (!business) return;
    setWorking(true);
    setError(null);
    try {
      // 1. Business info: the name everywhere it's used, and what the business does.
      const { sections } = await api<{ sections: StaticSection[] }>(workspacePath(owner, repo, "/static-info"));
      const site = sections.find((s) => s.id === "site");
      if (site && isObject(site.data)) {
        const data = { ...site.data };
        const oldName = typeof data.name === "string" ? data.name : "";
        data.name = business;
        if ("shortName" in data && (!data.shortName || data.shortName === oldName || data.shortName === TEMPLATE_NAME)) data.shortName = business;
        // What makes the setup count as answered (FirstRunSetup), so always written.
        data.description = description;
        await api(workspacePath(owner, repo, "/static-info/site"), { method: "PUT", body: { data } });
      }
      // The header shows the logo's name, which starts as the placeholder too.
      const brand = await api<BrandInfo>(workspacePath(owner, repo, "/brand")).catch(() => null);
      const logoText = brand?.brand.logoText;
      if (brand && (!logoText || logoText === TEMPLATE_NAME || logoText === siteName)) {
        const saved = await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/brand"), { method: "PUT", body: { brand: { logoText: business } } });
        setStatus(saved.status);
      }
      // 2. Photos, saved into the site where the page editor's uploads go.
      const paths: string[] = [];
      for (const photo of photos) {
        const saved = await api<{ path: string }>(workspacePath(owner, repo, "/uploads"), {
          method: "POST",
          body: { name: photo.name, data: await readAsBase64(photo) },
        });
        paths.push(saved.path);
      }
      // These answers are the site details the first publish would ask to check.
      markVisited(owner, repo, "details");
      await refresh();
      // 3. The AI designs the homepage from the answers (and makes it if the site has none).
      if (claude.ready) {
        const hasHome = overview?.collections.some((c) => c.pages.some(isHomePage)) ?? false;
        await send(
          [
            `Set up my new site for ${business}.`,
            description && `What we do: ${description}`,
            `${hasHome ? "Design my homepage" : "Create my homepage and design it"} so a first-time visitor understands straight away what we do, why to choose us and what to do next.`,
            paths.length && `Use these photos of ours on it: ${paths.join(", ")}.`,
            "Ask me about anything you need to know instead of guessing.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      finish();
    } catch (err) {
      setError(err);
    } finally {
      setWorking(false);
    }
  }

  // The name and what the business does are needed; photos are optional.
  const canContinue = step === 0 ? Boolean(name.trim()) : step === 1 ? Boolean(what.trim()) : true;
  const last = step === STEPS - 1;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="first-run-heading"
      // Escape skips, like "Skip for now" (never while saving).
      onCancel={(e) => {
        e.preventDefault();
        if (!working) finish();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-zinc-200 bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm dark:border-zinc-800"
    >
      {working ? (
        <div className="flex flex-col items-center px-8 py-14 text-center" aria-live="polite">
          <span aria-hidden="true" className="size-10 animate-spin rounded-full border-[3px] border-zinc-200 border-t-foreground dark:border-zinc-800" />
          <h2 id="first-run-heading" className="mt-5 text-lg font-semibold">
            Setting up {name.trim()}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">{photos.length ? "Saving your details and photos…" : "Saving your details…"}</p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canContinue) return;
            if (last) void submit();
            else setStep(step + 1);
          }}
          className="p-6 sm:p-8"
        >
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {Array.from({ length: STEPS }, (_, i) => (
              <span key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? "bg-foreground" : "bg-zinc-200 dark:bg-zinc-800"}`} />
            ))}
          </div>
          <p className="mt-6 text-xs font-medium text-zinc-500">
            Step {step + 1} of {STEPS}
          </p>

          {step === 0 && (
            <>
              <h2 id="first-run-heading" className="mt-1 text-2xl font-semibold tracking-tight">
                What&apos;s your business called?
              </h2>
              <p className="mt-2 text-sm text-zinc-500">It goes at the top of every page.</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
                placeholder="Harbour Street Bakery"
                aria-label="Business name"
                className={`${inputClass} mt-5 py-3 text-base`}
                autoFocus
              />
            </>
          )}

          {step === 1 && (
            <>
              <h2 id="first-run-heading" className="mt-1 text-2xl font-semibold tracking-tight">
                What does {name.trim() || "your business"} do?
              </h2>
              <p className="mt-2 text-sm text-zinc-500">One or two sentences, the way you&apos;d tell a customer.</p>
              <textarea
                value={what}
                onChange={(e) => setWhat(e.target.value)}
                required
                rows={3}
                maxLength={600}
                placeholder="A family bakery making sourdough, pastries and celebration cakes every morning."
                aria-label="What the business does"
                className={`${inputClass} mt-5 resize-none py-3 text-base`}
                autoFocus
              />
            </>
          )}

          {step === 2 && (
            <>
              <h2 id="first-run-heading" className="mt-1 text-2xl font-semibold tracking-tight">
                Add a few photos
              </h2>
              <p className="mt-2 text-sm text-zinc-500">Your shop, your work, your team. Optional: you can add more later.</p>
              <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-200 px-4 py-8 text-center hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-600 dark:hover:bg-zinc-900">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
                <span className="mt-2 text-sm font-medium">Choose photos</span>
                <span className="mt-0.5 text-xs text-zinc-500">
                  Up to {MAX_PHOTOS}, 5 MB each
                </span>
                <input
                  type="file"
                  accept={PHOTO_ACCEPT}
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    pick(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
              {previews.length > 0 && (
                <ul className="mt-3 grid grid-cols-6 gap-2">
                  {previews.map((p, i) => (
                    <li key={p.url} className="group relative aspect-square overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-900">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a local preview, not a page image */}
                      <img src={p.url} alt={p.name} className="size-full object-cover" />
                      <button
                        type="button"
                        aria-label={`Remove ${p.name}`}
                        onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
                        className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60 text-xs text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div className="mt-4">
            <ErrorText error={error} />
          </div>

          {last && claude.ready && <p className="text-sm text-zinc-500">Then the AI designs your homepage from your answers.</p>}

          <div className="mt-6 flex items-center gap-2">
            {step > 0 ? (
              <Button variant="ghost" onClick={() => setStep(step - 1)} className="px-4 py-2">
                Back
              </Button>
            ) : (
              <Button variant="ghost" onClick={finish} className="px-4 py-2 text-zinc-500">
                Skip for now
              </Button>
            )}
            <Button type="submit" variant="primary" className="ml-auto px-5 py-2" disabled={!canContinue || busy}>
              {!last ? "Continue" : claude.ready ? "Design my homepage" : "Finish"}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
