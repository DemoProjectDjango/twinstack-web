"use client";

import { useEffect, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";
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

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ImageModelSettings() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [saving, setSaving] = useState(false);

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

  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading image models…
      </p>
    );
  }
  if (state.status === "error") return <Notice tone="warning">{state.message}</Notice>;

  const { view } = state;
  return (
    <div className="space-y-4">
      {!view.available && <Notice tone="warning">Pictures can&apos;t be made until OPENAI_API_KEY is set on the server. Claude still draws SVG images.</Notice>}
      <fieldset disabled={saving || !view.available} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">Image model</legend>
        {view.models.map((m) => (
          <label
            key={m.id}
            className={`flex items-start gap-3 rounded-md border border-zinc-200 p-3 has-checked:border-zinc-900 dark:border-zinc-800 dark:has-checked:border-zinc-100 ${view.available ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
          >
            <input type="radio" name="image-model" value={m.id} checked={m.id === view.choice} onChange={() => void choose(m.id)} className="mt-1" />
            <span className="min-w-0">
              <span className="block text-sm font-bold">{m.name}</span>
              <span className="block text-sm text-zinc-500">{m.description}</span>
              <span className="mt-2 block text-xs text-zinc-500 tabular-nums">
                {m.price && `$${m.price.input} text in / $${m.price.output} image out per 1M tokens · `}
                up to {m.pictureCredits.toLocaleString()} credits a medium landscape picture
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-zinc-500">
        {view.source === "admin" && view.updatedAt
          ? `Chosen by ${view.updatedBy ?? "an admin"} on ${dateFormat.format(new Date(view.updatedAt))}.`
          : "Nobody has chosen yet: this is IMAGE_MODEL from the server's settings."}
      </p>
    </div>
  );
}
