"use client";

import { useEffect, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { Notice, Spinner } from "./site/ui";

type Provider = "deepseek" | "openai";

/** Dollars per million tokens; `long` applies once a request's input passes `long.above` tokens. */
type Price = { input: number; output: number; cacheRead: number; long?: { above: number; input: number; output: number; cacheRead: number } };

type FastModel = { id: string; provider: Provider; name: string; description: string; available: boolean; price: Price | null };

type View = {
  choice: string;
  source: "admin" | "env" | "default";
  active: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  providers: Record<Provider, boolean>;
  models: FastModel[];
  /** Claude's prices, for comparison. Older servers don't send them. */
  claude?: { id: string; name: string; price: Price | null }[];
  creditsPerDollar?: number;
};

type Option = Omit<FastModel, "provider" | "price"> & { provider?: Provider; price?: Price | null };

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: View };

const PROVIDERS: { id: Provider; name: string; env: string }[] = [
  { id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY" },
  { id: "openai", name: "ChatGPT (OpenAI)", env: "OPENAI_API_KEY" },
];

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** $0.10, $2, $0.075: cents always, more places only when the price has them. */
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: n < 1 || !Number.isInteger(n) ? 2 : 0, maximumFractionDigits: 3 })}`;
const thousands = (n: number) => `${Math.round(n / 1000)}K`;

/** The admin's choice of the cheaper model (GET/PUT /api/admin/models). Saved as soon as one is picked. */
export function FastModelSettings() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<View>("/api/admin/models")
      .then((view) => !cancelled && setState({ status: "ready", view }))
      .catch((err) => !cancelled && setState({ status: "error", message: err instanceof Error ? err.message : "The models couldn't be loaded." }));
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(model: string) {
    if (state.status !== "ready" || model === state.view.choice) return;
    const { view: current } = state;
    const find = (id: string | null) => current.models.find((m) => m.id === id) ?? null;
    const next = find(model);
    const before = find(current.active);
    const priced = (m: FastModel | null) => (m?.price ? `${usd(m.price.input)} in / ${usd(m.price.output)} out per 1M tokens` : null);
    const ok = await confirmModal(
      <div className="space-y-3">
        <p>
          {next ? (
            <>
              <strong>{next.name}</strong> will do the routine work for <strong>every account</strong>, starting with the next request.
            </>
          ) : (
            <>
              <strong>Claude</strong> will do all the work for <strong>every account</strong>, starting with the next request.
            </>
          )}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-zinc-100 p-3 text-sm tabular-nums dark:bg-zinc-900">
          <dt className="text-zinc-500">Now</dt>
          <dd>
            {before ? before.name : "Claude only"}
            {priced(before) && <span className="block text-xs text-zinc-500">{priced(before)}</span>}
          </dd>
          <dt className="text-zinc-500">New</dt>
          <dd>
            <span className="font-medium">{next ? next.name : "Claude only"}</span>
            {priced(next) && <span className="block text-xs text-zinc-500">{priced(next)}</span>}
          </dd>
        </dl>
        <p className="text-sm text-zinc-500">Credits are charged at the new model&apos;s prices. You can switch back at any time.</p>
      </div>,
      { title: next ? `Switch to ${next.name}?` : "Turn the fast model off?", confirmLabel: next ? `Use ${next.name}` : "Turn off" },
    );
    if (!ok) return;
    setSaving(true);
    try {
      const view = await api<View>("/api/admin/models", { method: "PUT", body: { model } });
      setState({ status: "ready", view });
      toast.success(view.active ? `${view.models.find((m) => m.id === view.active)?.name ?? view.active} now does routine work.` : "Claude now does all the work.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Your choice couldn't be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading models…
      </p>
    );
  }
  if (state.status === "error") return <Notice tone="warning">{state.message}</Notice>;

  const { view } = state;
  const off: Option = { id: "off", name: "Off", description: "Claude does everything. The best results, at Claude's prices.", available: true };
  const groups = [
    ...PROVIDERS.map((p) => ({ title: p.name, options: view.models.filter((m) => m.provider === p.id) as Option[] })),
    { title: "Claude only", options: [off] },
  ].filter((g) => g.options.length);

  return (
    <div className="space-y-6">
      {view.choice !== "off" && !view.active && (
        <Notice tone="warning">
          The chosen model can&apos;t run because its provider&apos;s key isn&apos;t set on the server, so Claude is doing all the work.
        </Notice>
      )}

      <fieldset disabled={saving} className="space-y-5">
        <legend className="sr-only">Fast model</legend>
        {groups.map((group) => (
          <div key={group.title}>
            <h2 className="mb-2 text-sm font-medium text-zinc-500">{group.title}</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.options.map((m) => (
                <ModelOption key={m.id} model={m} checked={m.id === view.choice} onChoose={() => void choose(m.id)} creditsPerDollar={view.creditsPerDollar} />
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      {view.claude && view.claude.length > 0 && <ClaudePrices models={view.claude} creditsPerDollar={view.creditsPerDollar} />}

      <p className="text-sm text-zinc-500">
        {view.source === "admin" && view.updatedAt
          ? `Chosen by ${view.updatedBy ?? "an admin"} on ${dateFormat.format(new Date(view.updatedAt))}.`
          : view.source === "env"
            ? "Nobody has chosen yet: this is FAST_PAGE_MODEL from the server's settings."
            : "Nobody has chosen yet: this is the server's default."}
      </p>

      <dl className="grid gap-3 border-t border-zinc-200 pt-4 text-sm sm:grid-cols-2 dark:border-zinc-800">
        {PROVIDERS.map((p) => (
          <div key={p.id}>
            <dt className="text-xs text-zinc-500">{p.name}</dt>
            <dd>{view.providers[p.id] ? "Key set" : `No key (${p.env})`}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One model to choose; a model whose provider has no key on the server can't be chosen. */
function ModelOption({ model, checked, onChoose, creditsPerDollar }: { model: Option; checked: boolean; onChoose: () => void; creditsPerDollar?: number }) {
  return (
    <label
      className={`flex items-start gap-3 rounded-md border border-zinc-200 p-3 has-checked:border-zinc-900 dark:border-zinc-800 dark:has-checked:border-zinc-100 ${
        model.available ? "cursor-pointer" : "cursor-not-allowed opacity-60"
      }`}
    >
      <input type="radio" name="fast-model" value={model.id} checked={checked} disabled={!model.available} onChange={onChoose} className="mt-1" />
      <span className="min-w-0">
        <span className="block text-sm font-bold">{model.name}</span>
        <span className="block text-sm text-zinc-500">{model.description}</span>
        {model.price && <PriceText price={model.price} creditsPerDollar={creditsPerDollar} />}
        {!model.available && model.provider && (
          <span className="mt-1 block text-xs text-zinc-500">Needs {PROVIDERS.find((p) => p.id === model.provider)?.env} on the server.</span>
        )}
      </span>
    </label>
  );
}

/** A model's price per million tokens: input and output stand out; cached, credits and the long-context price follow. */
function PriceText({ price, creditsPerDollar }: { price: Price; creditsPerDollar?: number }) {
  const credits = (n: number) => (creditsPerDollar ? Math.round(n * creditsPerDollar).toLocaleString() : null);
  return (
    <span className="mt-2 block tabular-nums">
      <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md bg-zinc-100 px-2.5 py-1.5 dark:bg-zinc-900">
        <span>
          <span className="text-base font-semibold">{usd(price.input)}</span> <span className="text-xs text-zinc-500">in</span>
        </span>
        <span>
          <span className="text-base font-semibold">{usd(price.output)}</span> <span className="text-xs text-zinc-500">out</span>
        </span>
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">per 1M tokens</span>
      </span>
      <span className="mt-1 block text-xs text-zinc-500">
        {usd(price.cacheRead)} cached
        {creditsPerDollar && ` · ${credits(price.input)} / ${credits(price.output)} credits`}
        {price.long && ` · over ${thousands(price.long.above)} input: ${usd(price.long.input)} / ${usd(price.long.output)}`}
      </span>
    </span>
  );
}

/** Claude's prices, so the fast model's can be compared with what it saves. */
function ClaudePrices({ models, creditsPerDollar }: { models: { id: string; name: string; price: Price | null }[]; creditsPerDollar?: number }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-zinc-500">Claude, for comparison (per 1M tokens)</h2>
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm tabular-nums">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Input</th>
              <th className="px-3 py-2 font-medium">Output</th>
              <th className="px-3 py-2 font-medium">Cached</th>
              {creditsPerDollar && <th className="px-3 py-2 font-medium">Credits in / out</th>}
            </tr>
          </thead>
          <tbody>
            {models
              .filter((m) => m.price)
              .map(({ id, name, price }) => (
                <tr key={id} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="px-3 py-2">{name}</td>
                  <td className="px-3 py-2 font-semibold">{usd(price!.input)}</td>
                  <td className="px-3 py-2 font-semibold">{usd(price!.output)}</td>
                  <td className="px-3 py-2">{usd(price!.cacheRead)}</td>
                  {creditsPerDollar && (
                    <td className="px-3 py-2">
                      {Math.round(price!.input * creditsPerDollar).toLocaleString()} / {Math.round(price!.output * creditsPerDollar).toLocaleString()}
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-zinc-500">Dollars per million tokens. Credits are charged at these prices.</p>
    </section>
  );
}
