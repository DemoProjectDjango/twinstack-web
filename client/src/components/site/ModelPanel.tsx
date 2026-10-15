"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, workspacePath } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { useSite } from "./site-context";
import { Notice, ScreenHeader, Spinner, inputClass } from "./ui";

// The site's own AI models (GET/PUT …/ai-models): the cheaper model that does routine work
// (server/src/fast-model.js) and the image model pictures are made with (server/src/image-model.js).
// "default" follows the one chosen for everyone on /admin/models.

type Choice = { id: string; name: string };

type FastModel = { id: string; name: string; description: string; available: boolean; price: { output: number } | null };
type ImageModel = { id: string; name: string; description: string; pictureCredits: number };

type FastView = {
  choice: string;
  /** The site's chosen model can't run any more, so it's on the default. */
  unavailable: boolean;
  default: Choice | null;
  active: Choice | null;
  models: FastModel[];
  creditsPerDollar: number;
};

type ImageView = {
  choice: string;
  unavailable: boolean;
  /** Pictures can be made on this server at all (it has an OpenAI key). */
  available: boolean;
  default: Choice;
  active: Choice | null;
  models: ImageModel[];
};

type Views = { fast: FastView; image: ImageView };
type Kind = keyof Views;
type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; views: Views };

/** One entry of a dropdown, with what's shown under it once picked. */
type Option = { id: string; label: string; description: string; note: string | null };

// A thousand words are about 1,333 tokens of writing.
const TOKENS_PER_1000_WORDS = 1333;

/** "About 16 credits per 1,000 words it writes", from the model's output price. */
function wordsNote(model: FastModel, creditsPerDollar: number) {
  if (!model.price) return null;
  const credits = Math.max(1, Math.round(((model.price.output * TOKENS_PER_1000_WORDS) / 1e6) * creditsPerDollar));
  return `About ${credits.toLocaleString()} credits per 1,000 words it writes.`;
}

const pictureNote = (model: ImageModel) => `Up to about ${model.pictureCredits.toLocaleString()} credits for a medium-quality landscape picture.`;

function fastOptions(view: FastView): Option[] {
  const defaultModel = view.models.find((m) => m.id === view.default?.id);
  return [
    {
      id: "default",
      label: `Default (${view.default?.name ?? "Claude only"})`,
      description: "Twinstack's recommended choice. If it changes, this site follows it.",
      note: defaultModel ? wordsNote(defaultModel, view.creditsPerDollar) : null,
    },
    ...view.models.filter((m) => m.available).map((m) => ({ id: m.id, label: m.name, description: m.description, note: wordsNote(m, view.creditsPerDollar) })),
    { id: "off", label: "Claude only", description: "Claude does everything. The best results, at Claude's prices.", note: null },
  ];
}

function imageOptions(view: ImageView): Option[] {
  const defaultModel = view.models.find((m) => m.id === view.default.id);
  return [
    {
      id: "default",
      label: `Default (${view.default.name})`,
      description: "Twinstack's recommended choice. If it changes, this site follows it.",
      note: defaultModel ? pictureNote(defaultModel) : null,
    },
    ...view.models.map((m) => ({ id: m.id, label: m.name, description: m.description, note: pictureNote(m) })),
  ];
}

export function ModelPanel() {
  const { owner, repo } = useSite();
  const [state, setState] = useState<State>({ status: "loading" });
  const [saving, setSaving] = useState<Kind | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<Views>(workspacePath(owner, repo, "/ai-models"))
      .then((views) => !cancelled && setState({ status: "ready", views }))
      .catch((err) => !cancelled && setState({ status: "error", message: err instanceof Error ? err.message : "The models couldn't be loaded." }));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  async function choose(kind: Kind, model: string) {
    if (state.status !== "ready" || model === state.views[kind].choice) return;
    setSaving(kind);
    try {
      const views = await api<Views>(workspacePath(owner, repo, "/ai-models"), { method: "PUT", body: { kind, model } });
      setState({ status: "ready", views });
      const active = views[kind].active;
      toast.success(
        kind === "image"
          ? `Pictures for this site are now made with ${active?.name ?? "the default model"}.`
          : active
            ? `${active.name} now does this site's routine work.`
            : "Claude now does all of this site's work.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Your choice couldn't be saved.");
    } finally {
      setSaving(null);
    }
  }

  const header = <ScreenHeader title="AI models" description="Choose which AI models do this site's work. The choices are shared by everyone who manages this site and apply from the next request." />;

  if (state.status !== "ready") {
    return (
      <div className="space-y-6">
        {header}
        {state.status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading models…
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
          description="Claude designs and writes the important parts of your site. To save credits, routine work (small page edits, search text, the header and footer, site details) goes to a cheaper, faster model first, and Claude does it again if that work doesn't pass the site's checks."
          control={
            <ModelSelect
              id="site-fast-model"
              label="Model for routine work"
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
              <p className="mt-3 text-xs text-zinc-500">{fast.active ? `${fast.active.name} is doing this site's routine work now.` : "Claude is doing all of this site's work now."}</p>
            </>
          }
        />
        <ModelCard
          title="Pictures"
          description="Photos and illustrations Claude makes for your pages when you ask for one. Each picture costs credits; logos and icons Claude draws itself don't."
          control={
            image.available ? (
              <ModelSelect
                id="site-image-model"
                label="Model for pictures"
                value={image.choice}
                options={imageOptions(image)}
                disabled={saving !== null}
                saving={saving === "image"}
                onChange={(model) => void choose("image", model)}
              />
            ) : (
              <Notice>Pictures can&apos;t be made on this server yet. Claude can still draw logos, icons and simple illustrations.</Notice>
            )
          }
          details={
            image.available && (
              <>
                <Picked options={imageOptions(image)} value={image.choice} />
                {image.unavailable && <Unavailable />}
                <p className="mt-3 text-xs text-zinc-500">{image.active && `${image.active.name} makes this site's pictures now.`}</p>
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
      <Notice tone="warning">The model chosen for this site isn&apos;t available any more, so it&apos;s using the default until you choose again.</Notice>
    </div>
  );
}

/** A dropdown of models, saved as soon as one is picked. */
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
        {/* A model that's no longer offered shows as unselected until another is picked. */}
        <select id={id} value={picked ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          {!picked && <option value="" disabled>Choose a model</option>}
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

/** What the picked model is and what it costs. */
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
