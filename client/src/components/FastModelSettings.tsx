"use client";

import { useEffect, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { AdminModelSection, ChoiceCard, KeyBadge } from "./AdminModelSection";
import { CostExplorer, type Explore, type Measure, type ModelUsage, START, costOf, measureOf, useModelUsage } from "./ModelCostExplorer";
import { Notice, Spinner } from "./site/ui";

type Provider = "deepseek" | "openai";

type Price = import("./ModelCostExplorer").Price;

type FastModel = { id: string; provider: Provider; name: string; description: string; available: boolean; price: Price | null };
type ClaudeModel = { id: string; name: string; price: Price | null };

type View = {
  choice: string;
  source: "admin" | "env" | "default";
  active: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  providers: Record<Provider, boolean>;
  models: FastModel[];
  /** Claude's prices, for comparison. Older servers don't send them. */
  claude?: ClaudeModel[];
  creditsPerDollar?: number;
};

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: View };

const PROVIDERS: { id: Provider; name: string; env: string }[] = [
  { id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY" },
  { id: "openai", name: "ChatGPT (OpenAI)", env: "OPENAI_API_KEY" },
];

/** $0.10, $2, $0.075: cents always, more places only when the price has them. */
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: n < 1 || !Number.isInteger(n) ? 2 : 0, maximumFractionDigits: 3 })}`;
const thousands = (n: number) => `${Math.round(n / 1000)}K`;

// Routine work reads more than it writes: about 3 tokens in for each one out.
const blended = (p: Price) => (3 * p.input + p.output) / 4;

/** The Claude model savings are measured against: a Sonnet (what most accounts run), else the first priced. */
function reference(claude: ClaudeModel[] | undefined) {
  const priced = (claude ?? []).filter((m) => m.price);
  return priced.find((m) => /sonnet/i.test(m.id)) ?? priced[0] ?? null;
}

/** "20× cheaper", "60% cheaper", or null when it isn't cheaper. */
function savings(price: Price | null, against: ClaudeModel | null) {
  if (!price || !against?.price) return null;
  const ratio = blended(against.price) / blended(price);
  if (ratio <= 1.05) return null;
  return ratio >= 2 ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× cheaper` : `${Math.round((1 - 1 / ratio) * 100)}% cheaper`;
}

/** What a card shows for the explorer's measure: the cost on its model, against the dearest option. */
type Cost = { dollars: number; credits: number | null; share: number; cheapest: boolean };

// How far back each card's "Did N requests" looks.
const USAGE_DAYS = 30;

const money = (n: number) => (n >= 100 ? `${Math.round(n).toLocaleString()}` : n >= 0.01 ? `${n.toFixed(2)}` : n > 0 ? "under 1¢" : "$0");

/**
 * The admin's choice of the cheaper model (GET/PUT /api/admin/models), saved as soon as one is picked,
 * with a cost comparison: every card shows what a task would cost on its model.
 */
export function FastModelSettings() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const [explore, setExplore] = useState<Explore>(START);
  const usage = useModelUsage(USAGE_DAYS);

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
              <strong>{next.name}</strong> will do the routine work for <strong>every site on the default</strong>, starting with the next request.
            </>
          ) : (
            <>
              <strong>Claude</strong> will do all the work for <strong>every site on the default</strong>, starting with the next request.
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
        <p className="text-sm text-zinc-500">
          Sites that chose their own model on their AI model screen keep it. Credits are charged at the new model&apos;s prices. You can switch back at any time.
        </p>
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

  const description = (
    <>
      Does the routine work for every account: page edits and new pages once a site has a design, the header and footer, search text, file edits
      and site details. When its work fails a site&apos;s checks, Claude does it again.
    </>
  );

  if (state.status !== "ready") {
    return (
      <AdminModelSection title="Fast model" description={description} inUse={null} chosen="">
        {state.status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading models…
          </p>
        ) : (
          <Notice tone="warning">{state.message}</Notice>
        )}
      </AdminModelSection>
    );
  }

  const { view } = state;
  const active = view.models.find((m) => m.id === view.active) ?? null;
  const against = reference(view.claude);
  const broken = view.choice !== "off" && !view.active;

  // Every option's cost for the explorer's measure, Claude only (at the reference model) included.
  const measure: Measure = measureOf(explore);
  const priced = view.models.filter((m) => m.price);
  const dollarsOf = (price: Price | null | undefined) => (price ? costOf(price, measure.tokens) : null);
  const claudeDollars = dollarsOf(against?.price);
  const most = Math.max(claudeDollars ?? 0, ...priced.map((m) => dollarsOf(m.price) ?? 0));
  const cheapestId = priced.filter((m) => m.available).sort((a, b) => dollarsOf(a.price)! - dollarsOf(b.price)!)[0]?.id;
  const costOfModel = (m: { id: string; price: Price | null }): Cost | null => {
    const dollars = dollarsOf(m.price);
    if (dollars === null) return null;
    return { dollars, credits: view.creditsPerDollar ? Math.round(dollars * view.creditsPerDollar) : null, share: most ? dollars / most : 0, cheapest: m.id === cheapestId };
  };
  const usedBy = (id: string) => usage?.models.find((u) => u.model === id);

  return (
    <AdminModelSection
      title="Fast model"
      description={description}
      inUse={active ? active.name : "Claude only"}
      inUseTone={broken ? "warning" : "good"}
      note={usage && usage.overrides.fast > 0 ? `${usage.overrides.fast} ${usage.overrides.fast === 1 ? "site has" : "sites have"} chosen their own` : undefined}
      chosen={
        view.source === "admin"
          ? { by: view.updatedBy, at: view.updatedAt }
          : view.source === "env"
            ? "From FAST_PAGE_MODEL in the server's settings"
            : "The server's default"
      }
    >
      {broken && (
        <Notice tone="warning">The chosen model can&apos;t run because its provider&apos;s key isn&apos;t set on the server, so Claude is doing all the work.</Notice>
      )}

      <CostExplorer value={explore} onChange={setExplore} />

      <fieldset disabled={saving} className="space-y-6">
        <legend className="sr-only">Fast model</legend>
        {PROVIDERS.map((p) => {
          const models = view.models.filter((m) => m.provider === p.id);
          if (!models.length) return null;
          return (
            <div key={p.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{p.name}</h3>
                <KeyBadge set={view.providers[p.id]} env={p.env} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {models.map((m) => (
                  <ChoiceCard key={m.id} name="fast-model" value={m.id} checked={m.id === view.choice} disabled={!m.available} onChoose={() => void choose(m.id)}>
                    <ModelBody
                      model={m}
                      active={m.id === view.active}
                      saving={savings(m.price, against)}
                      against={against}
                      creditsPerDollar={view.creditsPerDollar}
                      cost={costOfModel(m)}
                      measure={measure}
                      used={usedBy(m.id)}
                      days={USAGE_DAYS}
                    />
                  </ChoiceCard>
                ))}
              </div>
            </div>
          );
        })}

        <div>
          <h3 className="mb-2 text-sm font-semibold">No fast model</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <ChoiceCard name="fast-model" value="off" checked={view.choice === "off"} onChoose={() => void choose("off")}>
              <span className="pr-7 text-base font-semibold">Claude only</span>
              <span className="mt-1 text-sm text-zinc-500">Claude does everything: the best results, at Claude&apos;s prices.</span>
              {against && claudeDollars !== null && (
                <CostBar
                  cost={{ dollars: claudeDollars, credits: view.creditsPerDollar ? Math.round(claudeDollars * view.creditsPerDollar) : null, share: most ? claudeDollars / most : 0, cheapest: false }}
                  measure={measure}
                  note={`at ${against.name.replace(/^Claude /, "")}'s prices`}
                  tone="zinc"
                />
              )}
              {view.choice === "off" && <span className="mt-3 text-xs font-medium text-emerald-700 dark:text-emerald-400">In use</span>}
            </ChoiceCard>
          </div>
        </div>
      </fieldset>

      {view.claude && view.claude.some((m) => m.price) && <ClaudePrices models={view.claude} creditsPerDollar={view.creditsPerDollar} />}
    </AdminModelSection>
  );
}

/** A fast model's card: its name, what it's like, its price, and what it saves on Claude. */
function ModelBody({
  model,
  active,
  saving,
  against,
  creditsPerDollar,
  cost,
  measure,
  used,
  days,
}: {
  model: FastModel;
  active: boolean;
  saving: string | null;
  against: ClaudeModel | null;
  creditsPerDollar?: number;
  cost: Cost | null;
  measure: Measure;
  used: ModelUsage | undefined;
  days: number;
}) {
  const price = model.price;
  const credits = (n: number) => (creditsPerDollar ? Math.round(n * creditsPerDollar).toLocaleString() : null);
  return (
    <>
      <span className="pr-7 text-base font-semibold">{model.name}</span>
      <span className="mt-1 text-sm text-zinc-500">{model.description}</span>
      {price && (
        <span className="mt-4 grid grid-cols-2 gap-2 tabular-nums">
          <span className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
            <span className="block text-[11px] uppercase tracking-wide text-zinc-500">Input</span>
            <span className="text-lg font-semibold">{usd(price.input)}</span>
          </span>
          <span className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
            <span className="block text-[11px] uppercase tracking-wide text-zinc-500">Output</span>
            <span className="text-lg font-semibold">{usd(price.output)}</span>
          </span>
        </span>
      )}
      {cost && <CostBar cost={cost} measure={measure} tone="sky" />}
      <span className="mt-auto pt-3">
        <span className="flex flex-wrap items-center gap-1.5">
          {cost?.cheapest && <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white">Cheapest for this</span>}
          {active && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">In use</span>}
          {saving && against && (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950/50 dark:text-sky-300" title={`Than ${against.name}, at about 3 tokens read for each one written`}>
              {saving} than {against.name.replace(/^Claude /, "")}
            </span>
          )}
        </span>
        {price && (
          <span className="mt-2 block text-xs leading-relaxed text-zinc-500 tabular-nums">
            Per 1M tokens · {usd(price.cacheRead)} cached
            {creditsPerDollar && ` · ${credits(price.input)} / ${credits(price.output)} credits`}
            {price.long && ` · over ${thousands(price.long.above)} input: ${usd(price.long.input)} / ${usd(price.long.output)}`}
          </span>
        )}
        <span className="mt-1 block text-xs text-zinc-500">
          {used ? `Did ${used.requests.toLocaleString()} ${used.requests === 1 ? "request" : "requests"} (${used.credits.toLocaleString()} credits) in the last ${days} days` : `Not used in the last ${days} days`}
        </span>
        {!model.available && <span className="mt-2 block text-xs font-medium text-amber-700 dark:text-amber-400">Can&apos;t be chosen until its key is set.</span>}
      </span>
    </>
  );
}

/** What the explorer's measure costs on a model: dollars or credits, and a bar against the dearest option. */
function CostBar({ cost, measure, note, tone }: { cost: Cost; measure: Measure; note?: string; tone: "sky" | "zinc" }) {
  const credits = cost.credits !== null ? `${cost.credits.toLocaleString()} credits` : null;
  // A task reads best in credits; weeks of work in dollars.
  const main = credits ? `≈ ${credits}` : money(cost.dollars);
  const second = credits ? money(cost.dollars) : null;
  return (
    <span className="mt-3 block rounded-md border border-dashed border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <span className="block text-[11px] text-zinc-500">
        {`To ${measure.label}`}
        {note && ` · ${note}`}
      </span>
      <span className="flex items-baseline justify-between gap-2 tabular-nums">
        <span className="text-base font-semibold">{main}</span>
        {second && <span className="text-xs text-zinc-500">{second}</span>}
      </span>
      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <span
          className={`block h-full rounded-full transition-all duration-500 ${cost.cheapest ? "bg-emerald-500" : tone === "sky" ? "bg-sky-500" : "bg-zinc-400"}`}
          style={{ width: `${Math.max(2, cost.share * 100)}%` }}
        />
      </span>
    </span>
  );
}

/** Claude's prices, so the fast model's can be compared with what it saves. */
function ClaudePrices({ models, creditsPerDollar }: { models: ClaudeModel[]; creditsPerDollar?: number }) {
  return (
    <details className="group rounded-lg border border-zinc-200 dark:border-zinc-800">
      <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-3 text-sm font-medium">
        Compare with Claude&apos;s prices
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 text-zinc-500 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </summary>
      <div className="overflow-x-auto border-t border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm tabular-nums">
          <thead className="bg-zinc-50/70 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/40">
            <tr>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 text-right font-medium">Input</th>
              <th className="px-4 py-2 text-right font-medium">Output</th>
              <th className="px-4 py-2 text-right font-medium">Cached</th>
              {creditsPerDollar && <th className="px-4 py-2 text-right font-medium">Credits in / out</th>}
            </tr>
          </thead>
          <tbody>
            {models
              .filter((m) => m.price)
              .map(({ id, name, price }) => (
                <tr key={id} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="px-4 py-2">{name}</td>
                  <td className="px-4 py-2 text-right font-semibold">{usd(price!.input)}</td>
                  <td className="px-4 py-2 text-right font-semibold">{usd(price!.output)}</td>
                  <td className="px-4 py-2 text-right">{usd(price!.cacheRead)}</td>
                  {creditsPerDollar && (
                    <td className="px-4 py-2 text-right">
                      {Math.round(price!.input * creditsPerDollar).toLocaleString()} / {Math.round(price!.output * creditsPerDollar).toLocaleString()}
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
        <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-900">Dollars per million tokens. Credits are charged at these prices.</p>
      </div>
    </details>
  );
}
