"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/site-api";
import { Notice, Spinner } from "./site/ui";

// The admin's Site setup numbers (GET /api/admin/setup, server/src/site-setup.js's setupStats).

// The questions are the AI's own for each site, so they're counted by their words.
type QuestionStats = { title: string; asked: number; skipped: number; later: number };
type AnswerStats = { label: string; answered: number; typed: number; picked: Record<string, number>; examples: string[] };
type TypeStats = {
  id: string;
  label: string;
  version: number;
  sites: number;
  pickedByClaude: number;
  versions: Record<string, number>;
  firstWeek: { sites: number; messages: number | null; commands: number | null; discards: number | null; publishedInWeek: number };
  published: number;
  medianHoursToPublish: number | null;
  questions: QuestionStats[];
  answers: AnswerStats[];
  pages: { address: string; count: number }[];
};
/** How sites started: the AI's design, or a template (server/kits/). Older servers don't send it. */
type StartStats = {
  id: string;
  label: string;
  sites: number;
  /** All-time uses (templates only). */
  uses?: number;
  published: number;
  medianHoursToPublish: number | null;
  firstWeek: { sites: number; messages: number | null; commands: number | null; discards: number | null; publishedInWeek: number };
};
type KitUse = { siteId: number; kitId: string; kit: string; site: string | null; owner: string | null; usedAt: string };
type Stats = { days: number; total: number; types: TypeStats[]; starts?: StartStats[]; recentUses?: KitUse[] };

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; stats: Stats };

const PERIODS = [30, 90, 365];

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");
const decimal = (n: number | null) => (n === null ? "–" : n.toFixed(1));
function duration(hours: number | null) {
  if (hours === null) return "–";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

export function AdminSetupStats() {
  const [days, setDays] = useState(90);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    api<Stats>(`/api/admin/setup?days=${days}`)
      .then((stats) => live && setState({ status: "ready", stats }))
      .catch((err) => live && setState({ status: "error", message: err instanceof Error ? err.message : "Couldn't load the numbers." }));
    return () => {
      live = false;
    };
  }, [days]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500">Sites set up in the last</span>
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={days === p}
            onClick={() => {
              setState({ status: "loading" });
              setDays(p);
            }}
            className={`rounded-full border px-3 py-1 ${days === p ? "border-foreground bg-foreground text-background" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"}`}
          >
            {p} days
          </button>
        ))}
      </div>

      {state.status === "loading" && <Spinner />}
      {state.status === "error" && <Notice tone="warning">{state.message}</Notice>}
      {state.status === "ready" && (
        <>
          {state.stats.total === 0 && <Notice>No site has answered the setup questions in the last {state.stats.days} days.</Notice>}
          {state.stats.starts && state.stats.starts.length > 0 && <StartsCard starts={state.stats.starts} />}
          {state.stats.recentUses && <KitUsesCard uses={state.stats.recentUses} />}
          {state.stats.types.map((type) => (
            <TypeCard key={type.id} type={type} />
          ))}
        </>
      )}
    </div>
  );
}

/** The AI's design next to each template: do template sites get published, and need fewer changes? */
function StartsCard({ starts }: { starts: StartStats[] }) {
  return (
    <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">How sites started</h2>
      <p className="mt-1 text-sm text-zinc-500">The AI&apos;s design or a template, chosen in the setup&apos;s first step.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-xl text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1 pr-3 font-medium">Started from</th>
              <th className="py-1 pr-3 text-right font-medium">Sites</th>
              <th className="py-1 pr-3 text-right font-medium">Uses, all time</th>
              <th className="py-1 pr-3 text-right font-medium">Published</th>
              <th className="py-1 pr-3 text-right font-medium">Time to publish</th>
              <th className="py-1 pr-3 text-right font-medium">Published in week 1</th>
              <th className="py-1 pr-3 text-right font-medium">AI messages, week 1</th>
              <th className="py-1 pr-3 text-right font-medium">AI commands, week 1</th>
              <th className="py-1 text-right font-medium">Thrown away, week 1</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {starts.map((s) => (
              <tr key={s.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1.5 pr-3">{s.label}</td>
                <td className="py-1.5 pr-3 text-right">{s.sites}</td>
                <td className="py-1.5 pr-3 text-right">{s.uses ?? "–"}</td>
                <td className="py-1.5 pr-3 text-right">{percent(s.published, s.sites)}</td>
                <td className="py-1.5 pr-3 text-right">{duration(s.medianHoursToPublish)}</td>
                <td className="py-1.5 pr-3 text-right">{percent(s.firstWeek.publishedInWeek, s.firstWeek.sites)}</td>
                <td className="py-1.5 pr-3 text-right">{decimal(s.firstWeek.messages)}</td>
                <td className="py-1.5 pr-3 text-right">{decimal(s.firstWeek.commands)}</td>
                <td className="py-1.5 text-right">{decimal(s.firstWeek.discards)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Every site that started from a template, newest first (kitUses, kept when a site is deleted). */
function KitUsesCard({ uses }: { uses: KitUse[] }) {
  return (
    <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Template uses</h2>
      <p className="mt-1 text-sm text-zinc-500">The latest {uses.length === 50 ? "50 " : ""}sites started from a template, all time.</p>
      {uses.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No site has started from a template yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-xl text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Template</th>
                <th className="py-1 pr-3 font-medium">Site</th>
                <th className="py-1 pr-3 font-medium">Owner</th>
                <th className="py-1 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {uses.map((u) => (
                <tr key={u.siteId} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1.5 pr-3">{u.kit}</td>
                  <td className="py-1.5 pr-3">{u.site ?? "Deleted site"}</td>
                  <td className="py-1.5 pr-3">{u.owner ?? "–"}</td>
                  <td className="py-1.5 text-right tabular-nums">{new Date(u.usedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TypeCard({ type }: { type: TypeStats }) {
  const week = type.firstWeek;
  const figures = [
    { label: "Sites", value: String(type.sites), note: type.sites ? `${percent(type.pickedByClaude, type.sites)} recognised by Claude` : "" },
    { label: "Published", value: percent(type.published, type.sites), note: type.published ? `typically after ${duration(type.medianHoursToPublish)}` : "" },
    { label: "Published in week 1", value: percent(week.publishedInWeek, week.sites), note: `of ${week.sites} past their first week` },
    { label: "Ask Claude messages, week 1", value: decimal(week.messages), note: "per site, the build request included" },
    { label: "Claude commands, week 1", value: decimal(week.commands), note: "per site" },
    { label: "Changes thrown away, week 1", value: decimal(week.discards), note: "per site" },
  ];
  const versions = Object.entries(type.versions);

  return (
    <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-lg font-semibold">{type.label}</h2>
        <span className="text-xs text-zinc-500">
          {type.id} · skill version {type.version}
          {versions.length > 1 && ` · sites by version: ${versions.map(([v, n]) => `v${v} ${n}`).join(", ")}`}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {figures.map((f) => (
          <div key={f.label} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
            <dt className="text-xs text-zinc-500">{f.label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{f.value}</dd>
            {f.note && <dd className="mt-0.5 text-xs text-zinc-500">{f.note}</dd>}
          </div>
        ))}
      </dl>

      {type.sites > 0 && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="overflow-x-auto">
            <h3 className="text-sm font-semibold">Questions the AI asked most</h3>
            <table className="mt-2 w-full min-w-md text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Question</th>
                  <th className="py-2 pr-3 font-medium tabular-nums">Asked</th>
                  <th className="py-2 pr-3 font-medium tabular-nums">Skipped</th>
                  <th className="py-2 font-medium tabular-nums">Left for later</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {type.questions.map((q) => (
                  <tr key={q.title} className="align-top">
                    <td className="py-2 pr-3">{q.title}</td>
                    <td className="py-2 pr-3 tabular-nums">{q.asked}</td>
                    <td className="py-2 pr-3 tabular-nums">{q.asked ? percent(q.skipped, q.asked) : "–"}</td>
                    <td className="py-2 tabular-nums">{q.later}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid content-start gap-4 text-sm">
            <div>
              <h3 className="font-semibold">How choices were answered</h3>
              <ul className="mt-2 grid gap-1.5 text-zinc-500">
                {type.answers.map((a) => (
                  <li key={a.label}>
                    <span className="text-foreground">{a.label.replace(/ \((optional|pick any)\)$/, "")}:</span>{" "}
                    {Object.entries(a.picked)
                      .sort((x, y) => y[1] - x[1])
                      .map(([choice, n]) => `${choice} (${n})`)
                      .join(", ")}
                    {a.typed > 0 && ` · own words ${percent(a.typed, a.answered)}`}
                    {a.examples.length > 0 && <span className="block text-xs">Typed: {a.examples.map((e) => `“${e}”`).join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold">Pages planned most</h3>
              <p className="mt-1 text-zinc-500">{type.pages.map((p) => `${p.address} (${p.count})`).join(", ") || "–"}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
