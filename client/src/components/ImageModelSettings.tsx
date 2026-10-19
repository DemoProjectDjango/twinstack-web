"use client";

import { useEffect, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { AdminModelSection, ChoiceCard, KeyBadge } from "./AdminModelSection";
import { useModelUsage } from "./ModelCostExplorer";
import { Notice, Spinner } from "./site/ui";

// The admin's choice of image model (GET/PUT /api/admin/image-model, server/src/image-model.js): the
// default every site's pictures are made with until the site picks its own. IMAGE_MODEL in the
// server's .env decides until an admin chooses.

type Price = { input: number; output: number };
type ImageModel = { id: string; name: string; description: string; price: Price | null; pictureCredits: number };

type View = {
  choice: string;
  source: "admin" | "env";
  active: string | null;
  available: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  models: ImageModel[];
};

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: View };

const DESCRIPTION = "The OpenAI model that makes the photos and illustrations Claude adds to pages, paid for in credits. Without it, Claude still draws SVG images.";

export function ImageModelSettings() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  // How many pictures each model made lately, and how many sites chose their own.
  const usage = useModelUsage(30);

  useEffect(() => {
    let cancelled = false;
    api<View>("/api/admin/image-model")
      .then((view) => !cancelled && setState({ status: "ready", view }))
      .catch((err) => !cancelled && setState({ status: "error", message: err instanceof Error ? err.message : "The image models couldn't be loaded." }));
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(model: string) {
    if (state.status !== "ready" || model === state.view.choice) return;
    const next = state.view.models.find((m) => m.id === model);
    if (!next) return;
    const ok = await confirmModal(
      <div className="space-y-3">
        <p>
          Pictures will be made with <strong>{next.name}</strong> for <strong>every site on the default</strong>, starting with the next picture.
        </p>
        <p className="text-sm text-zinc-500">
          Sites that chose their own image model keep it. Up to about {next.pictureCredits.toLocaleString()} credits for a medium landscape picture.
        </p>
      </div>,
      { title: `Switch to ${next.name}?`, confirmLabel: `Use ${next.name}` },
    );
    if (!ok) return;
    setSaving(true);
    try {
      const view = await api<View>("/api/admin/image-model", { method: "PUT", body: { model } });
      setState({ status: "ready", view });
      toast.success(`Pictures are now made with ${next.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Your choice couldn't be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (state.status !== "ready") {
    return (
      <AdminModelSection title="Image model" description={DESCRIPTION} inUse={null} chosen="">
        {state.status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading image models…
          </p>
        ) : (
          <Notice tone="warning">{state.message}</Notice>
        )}
      </AdminModelSection>
    );
  }

  const { view } = state;
  const chosenModel = view.models.find((m) => m.id === view.choice);
  const cheapest = Math.min(...view.models.map((m) => m.pictureCredits));

  return (
    <AdminModelSection
      title="Image model"
      description={DESCRIPTION}
      inUse={view.available ? (chosenModel?.name ?? view.choice) : "SVG drawings only"}
      inUseTone={view.available ? "good" : "warning"}
      chosen={view.source === "admin" ? { by: view.updatedBy, at: view.updatedAt } : "From IMAGE_MODEL in the server's settings"}
      note={usage && usage.overrides.image > 0 ? `${usage.overrides.image} ${usage.overrides.image === 1 ? "site has" : "sites have"} chosen their own` : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">OpenAI</h3>
        <KeyBadge set={view.available} env="OPENAI_API_KEY" />
      </div>
      <fieldset disabled={saving || !view.available} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">Image model</legend>
        {view.models.map((m) => (
          <ChoiceCard key={m.id} name="image-model" value={m.id} checked={m.id === view.choice} disabled={!view.available} onChoose={() => void choose(m.id)}>
            <span className="pr-7 text-base font-semibold">{m.name}</span>
            <span className="mt-1 text-sm text-zinc-500">{m.description}</span>
            <span className="mt-4 rounded-md bg-zinc-50 px-3 py-2 tabular-nums dark:bg-zinc-900">
              <span className="block text-[11px] uppercase tracking-wide text-zinc-500">A medium landscape picture</span>
              <span className="text-lg font-semibold">up to {m.pictureCredits.toLocaleString()}</span> <span className="text-sm text-zinc-500">credits</span>
            </span>
            <span className="mt-auto pt-3">
              <span className="flex flex-wrap gap-1.5">
                {m.id === view.active && view.available && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">In use</span>
                )}
                {m.pictureCredits === cheapest && view.models.length > 1 && (
                  <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950/50 dark:text-sky-300">Cheapest</span>
                )}
              </span>
              <span className="mt-2 block text-xs text-zinc-500 tabular-nums">
                {(() => {
                  const made = usage?.models.find((u) => u.model === m.id);
                  return made
                    ? `Made ${made.requests.toLocaleString()} ${made.requests === 1 ? "picture" : "pictures"} (${made.credits.toLocaleString()} credits) in the last 30 days`
                    : "No pictures in the last 30 days";
                })()}
              </span>
              {m.price && (
                <span className="mt-1 block text-xs text-zinc-500 tabular-nums">
                  Per 1M tokens · ${m.price.input} text in · ${m.price.output} image out
                </span>
              )}
            </span>
          </ChoiceCard>
        ))}
      </fieldset>
    </AdminModelSection>
  );
}
