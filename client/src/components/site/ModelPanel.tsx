"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, workspacePath } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { useSite } from "./site-context";
import { Notice, ScreenHeader, Spinner, inputClass } from "./ui";

// The site's AI settings (GET/PUT …/ai-models): how routine work is done (server/src/fast-model.js)
// and how pictures are made (server/src/image-model.js), as neutral choices the server maps to
// models (server/src/model-tiers.js). Owners never see a model's name; admins get them as `models`.
// "default" follows the one chosen for everyone on /admin/models.

type Tier = "default" | "best" | "balanced" | "fastest" | "custom";

type Choice = { id: Tier; label: string; description: string; available: boolean };

/** What an admin also sees: the models behind the choices. */
type AdminModels = { choice: string; default: { name: string } | null; active: { name: string } | null };

type FastView = {
  choice: Tier;
  /** The site's choice can't run any more, so it's on the default. */
  unavailable: boolean;
  default: Tier;
  active: Tier;
  options: (Choice & { creditsPer1000Words: number | null })[];
  models?: AdminModels;
};

type ImageView = {
  choice: Tier;
  unavailable: boolean;
  /** Pictures can be made on this server at all. */
  available: boolean;
  default: Tier;
  active: Tier | null;
  options: (Choice & { pictureCredits: number | null })[];
  models?: AdminModels;
};

type Views = { fast: FastView; image: ImageView };
type Kind = keyof Views;
type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; views: Views };

/** One entry of a dropdown, with what's shown under it once picked. */
type Option = { id: string; label: string; description: string; note: string | null };

const wordsNote = (credits: number | null) => (credits ? `About ${credits.toLocaleString()} credits per 1,000 words it writes.` : null);

const pictureNote = (credits: number | null) => (credits ? `Up to about ${credits.toLocaleString()} credits for a medium-quality landscape picture.` : null);

const labelOf = (options: Choice[], id: Tier | null) => options.find((o) => o.id === id)?.label ?? null;

function fastOptions(view: FastView): Option[] {
  return view.options
    .filter((o) => o.available || o.id === view.choice)
    .map((o) => ({
      id: o.id,
      label: o.id === "default" ? `${o.label} (${labelOf(view.options, view.default) ?? "Best quality"})` : o.label,
      description: o.description,
      note: wordsNote(o.creditsPer1000Words),
    }));
}

function imageOptions(view: ImageView): Option[] {
  return view.options
    .filter((o) => o.available || o.id === view.choice)
    .map((o) => ({
      id: o.id,
      label: o.id === "default" ? `${o.label} (${labelOf(view.options, view.default) ?? "Balanced"})` : o.label,
      description: o.description,
      note: pictureNote(o.pictureCredits),
    }));
}

/** For admins only: the model names behind a setting. */
function AdminNote({ models }: { models?: AdminModels }) {
  if (!models) return null;
  return (
    <p className="mt-2 text-xs text-zinc-400">
      Admin: {models.active?.name ?? "main AI only"} now
      {models.default && `, default ${models.default.name}`}.
    </p>
  );
}

export function ModelPanel() {
  const { owner, repo } = useSite();
  const [state, setState] = useState<State>({ status: "loading" });
  const [saving, setSaving] = useState<Kind | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<Views>(workspacePath(owner, repo, "/ai-models"))
      .then((views) => !cancelled && setState({ status: "ready", views }))
      .catch((err) => !cancelled && setState({ status: "error", message: err instanceof Error ? err.message : "The settings couldn't be loaded." }));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  async function choose(kind: Kind, model: string) {
    if (state.status !== "ready" || model === state.views[kind].choice) return;
    setSaving(kind);
    try {
      const views = await api<Views>(workspacePath(owner, repo, "/ai-models"), { method: "PUT", body: { kind, choice: model } });
      setState({ status: "ready", views });
      const view = views[kind];
      const picked = labelOf(view.options, view.choice);
      toast.success(kind === "image" ? `Pictures for this site: ${picked ?? "saved"}.` : `This site's AI work: ${picked ?? "saved"}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Your choice couldn't be saved.");
    } finally {
      setSaving(null);
    }
  }

  const header = <ScreenHeader title="AI settings" description="Choose how the AI balances quality and credits for this site. The choices are shared by everyone who manages this site and apply from the next request." />;

  if (state.status !== "ready") {
    return (
      <div className="space-y-6">
        {header}
        {state.status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading settings…
          </p>
        ) : (
          <Notice tone="warning">{state.message}</Notice>
        )}
      </div>
    );
  }

  const { fast, image } = state.views;
  return (
    <div className="space-y-6">
      {header}
      {/* The two cards share rows (subgrid), so their titles, descriptions, dropdowns and details line up. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ModelCard
          title="Routine work"
          description="The main AI designs and writes the important parts of your site. To save credits, routine work (small page edits, search text, the header and footer, site details) can go to a quicker, lower-cost AI first, and the main AI does it again if that work doesn't pass the site's checks."
          control={
            <ModelSelect
              id="site-fast-model"
              label="Quality for routine work"
              value={fast.choice}
              options={fastOptions(fast)}
              disabled={saving !== null}
              saving={saving === "fast"}
              onChange={(model) => void choose("fast", model)}
            />
          }
          details={
            <>
              <Picked options={fastOptions(fast)} value={fast.choice} />
              {fast.unavailable && <Unavailable />}
              <p className="mt-3 text-xs text-zinc-500">
                {fast.active === "best" ? "The main AI is doing all of this site's work now." : `In use now: ${labelOf(fast.options, fast.active) ?? "a custom setting"}.`}
              </p>
              <AdminNote models={fast.models} />
            </>
          }
        />
        <ModelCard
          title="Pictures"
          description="Photos and illustrations the AI makes for your pages when you ask for one. Each picture costs credits; logos and icons the AI draws itself don't."
          control={
            image.available ? (
              <ModelSelect
                id="site-image-model"
                label="Quality for pictures"
                value={image.choice}
                options={imageOptions(image)}
                disabled={saving !== null}
                saving={saving === "image"}
                onChange={(model) => void choose("image", model)}
              />
            ) : (
              <Notice>Pictures can&apos;t be made on this server yet. The AI can still draw logos, icons and simple illustrations.</Notice>
            )
          }
          details={
            image.available && (
              <>
                <Picked options={imageOptions(image)} value={image.choice} />
                {image.unavailable && <Unavailable />}
                <p className="mt-3 text-xs text-zinc-500">{image.active && `In use now: ${labelOf(image.options, image.active) ?? "a custom setting"}.`}</p>
                <AdminNote models={image.models} />
              </>
            )
          }
        />
      </div>
    </div>
  );
}

/** One card: four rows (title, description, dropdown, details) that line up with the card beside it. */
function ModelCard({ title, description, control, details }: { title: string; description: string; control: ReactNode; details: ReactNode }) {
  return (
    <section className="row-span-4 grid grid-rows-subgrid gap-y-0 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-zinc-500">{description}</p>
      <div className="mt-4">{control}</div>
      <div>{details}</div>
    </section>
  );
}

function Unavailable() {
  return (
    <div className="mt-3">
      <Notice tone="warning">The option chosen for this site isn&apos;t available any more, so it&apos;s using the recommended one until you choose again.</Notice>
    </div>
  );
}

/** A dropdown of choices, saved as soon as one is picked. */
function ModelSelect({
  id,
  label,
  value,
  options,
  disabled,
  saving,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  disabled: boolean;
  saving: boolean;
  onChange: (model: string) => void;
}) {
  const picked = options.some((o) => o.id === value);
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        {/* A choice that's no longer offered shows as unselected until another is picked. */}
        <select id={id} value={picked ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          {!picked && <option value="" disabled>Choose an option</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {saving && <Spinner />}
      </div>
    </div>
  );
}

/** What the picked choice does and what it costs. */
function Picked({ options, value }: { options: Option[]; value: string }) {
  const picked = options.find((o) => o.id === value);
  if (!picked) return null;
  return (
    <div className="mt-2 space-y-0.5">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{picked.description}</p>
      {picked.note && <p className="text-xs text-zinc-500">{picked.note}</p>}
    </div>
  );
}
