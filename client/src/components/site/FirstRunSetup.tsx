"use client";

import { useState } from "react";
import { api, isHomePage, workspacePath, type BrandInfo, type Json, type StaticSection, type WorkspaceStatus } from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
import { markVisited } from "./HomePanel";
import { TEMPLATE_SITE_NAME as TEMPLATE_NAME } from "@/lib/repos";
import { useSite } from "./site-context";
import { Button, ErrorText, Field, inputClass } from "./ui";

// A new site's first visit to Edit site: three questions (the business's name, what it does, a few
// photos), then straight to the site. The answers go where the owner would otherwise type them
// (Business info, the header's name, the site's images), and with the AI set up, it's asked to
// design the homepage from them. Shown while the site still has the template's placeholder name, or
// the name it was created with (which creating it writes into site.config.json), until it's done or
// skipped in this browser.

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

const doneKey = (owner: string, repo: string) => `twinstack:first-run:${owner}/${repo}`;

function readDone(owner: string, repo: string) {
  try {
    return localStorage.getItem(doneKey(owner, repo)) === "done";
  } catch {
    return false;
  }
}

function markDone(owner: string, repo: string) {
  try {
    localStorage.setItem(doneKey(owner, repo), "done");
  } catch {
    // Storage can be blocked; the placeholder name check still hides it once the name is set.
  }
}

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
  const { owner, repo, overview, claude, busy, refresh, setStatus } = useSite();
  const { send } = useAssistant();
  const [hidden, setHidden] = useState(() => readDone(owner, repo));
  // Starts as the name the site was created with, until the owner types.
  const [typedName, setName] = useState<string | null>(null);
  const [what, setWhat] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const siteName = overview?.site.name ?? null;
  const name = typedName ?? overview?.displayName ?? "";
  const unsetUp = !siteName || siteName === TEMPLATE_NAME || siteName === overview?.displayName;
  if (hidden || !overview || !unsetUp) return null;

  function finish() {
    markDone(owner, repo);
    setHidden(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
        if ("description" in data && description) data.description = description;
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

  return (
    <section aria-labelledby="first-run-heading" className="rounded-xl border border-foreground p-5">
      <h3 id="first-run-heading" className="text-lg font-semibold">
        Let&apos;s set up your site
      </h3>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Three quick questions, then you&apos;re straight into your site.
        {claude.ready ? " The AI designs your homepage from your answers." : ""}
      </p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <Field label="1. What's your business called?">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Harbour Street Bakery" className={inputClass} disabled={working} />
        </Field>
        <Field label="2. What do you do?" hint="One or two sentences, the way you'd tell a customer.">
          <textarea
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            rows={2}
            maxLength={600}
            placeholder="A family bakery making sourdough, pastries and celebration cakes every morning."
            className={inputClass}
            disabled={working}
          />
        </Field>
        <Field label="3. A few photos (optional)" hint={`Up to ${MAX_PHOTOS}: your shop, your work, your team. 5 MB each.`}>
          <input
            type="file"
            accept={PHOTO_ACCEPT}
            multiple
            disabled={working}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              const tooBig = picked.find((f) => f.size > MAX_PHOTO_BYTES);
              setError(tooBig ? new Error(`${tooBig.name} is over 5 MB.`) : picked.length > MAX_PHOTOS ? new Error(`Pick at most ${MAX_PHOTOS} photos.`) : null);
              setPhotos(tooBig ? [] : picked.slice(0, MAX_PHOTOS));
            }}
            className="block text-sm"
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={working || busy || !name.trim()}>
            {working ? "Setting up…" : "Set up my site"}
          </Button>
          <Button variant="ghost" disabled={working} onClick={finish}>
            Skip for now
          </Button>
        </div>
      </form>
    </section>
  );
}
