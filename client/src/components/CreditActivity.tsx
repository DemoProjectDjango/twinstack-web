"use client";

import { useEffect, useState } from "react";
import { formatCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { ErrorText, Segmented, Spinner, inputClass } from "./site/ui";

type ProviderId = "claude" | "deepseek" | "openai";
type Use = Record<ProviderId, { credits: number; requests: number }>;

type Activity = {
  from: string;
  to: string;
  zone: string;
  today: string;
  totals: {
    purchases: { count: number; credits: number; paidCents: number; refundedCents: number; creditsTakenBack: number; demoCount: number; demoCredits: number };
    free: { accounts: number; credits: number };
    usage: Use;
    usedCredits: number;
  };
  days: { day: string; boughtCredits: number; paidCents: number; purchases: number; freeCredits: number; newAccounts: number; used: Use }[];
  users: {
    userId: string;
    email: string | null;
    name: string | null;
    deleted: boolean;
    balance: number | null;
    boughtCredits: number;
    paidCents: number;
    purchases: number;
    used: Use;
    usedCredits: number;
  }[];
  userCount: number;
  costUsd: Record<ProviderId, number>;
  totalCostUsd: number;
  revenueUsd: number;
  creditsPerUsd: number;
};

type Range = "today" | "7" | "30" | "month" | "custom";

export const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", deepseek: "DeepSeek", openai: "OpenAI" };
const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[];
// While the range includes today, it's fetched again this often so new use and purchases show.
const LIVE_MS = 30_000;

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
const TD = "px-3 py-1.5 tabular-nums";

/** "2026-10-16" in the browser's time zone. */
function localDay(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rangeDates(range: Exclude<Range, "custom">): { from: string; to: string } {
  const now = new Date();
  const to = localDay(now);
  if (range === "today") return { from: to, to };
  if (range === "month") return { from: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  return { from: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(range) + 1)), to };
}

/**
 * The AI providers page's "Credits by date": what users bought and used between two dates
 * (GET /api/admin/providers/activity), per provider, per day and per account.
 */
export function CreditActivity() {
  const [range, setRange] = useState<Range>("7");
  const [custom, setCustom] = useState(() => rangeDates("30"));
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const { from, to } = range === "custom" ? custom : rangeDates(range);

  useEffect(() => {
    if (!from || !to) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const load = (first: boolean) => {
      if (first) setLoading(true);
      api<Activity>(`/api/admin/providers/activity?${new URLSearchParams({ from, to, tz })}`)
        .then((next) => {
          if (cancelled) return;
          setData(next);
          setError(null);
          if (next.to >= next.today) timer = setTimeout(() => load(false), LIVE_MS);
        })
        .catch((err) => !cancelled && setError(err))
        .finally(() => !cancelled && first && setLoading(false));
    };
    load(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [from, to]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Credits by date</h2>
          <p className="text-sm text-zinc-500">What users bought and used, and what their use cost at each provider.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Segmented<Range>
            label="Date range"
            value={range}
            onChange={setRange}
            options={[
              { value: "today", label: "Today" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "month", label: "This month" },
              { value: "custom", label: "Custom" },
            ]}
          />
          {range === "custom" && (
            <>
              <label className="text-xs text-zinc-500">
                From
                <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={`${inputClass} mt-1`} />
              </label>
              <label className="text-xs text-zinc-500">
                To
                <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={`${inputClass} mt-1`} />
              </label>
            </>
          )}
          {loading && <Spinner />}
        </div>
      </div>

      <ErrorText error={error} />
      {data && <ActivityBody data={data} />}
    </section>
  );
}

function ActivityBody({ data }: { data: Activity }) {
  const { totals } = data;
  const p = totals.purchases;
  const net = data.revenueUsd - data.totalCostUsd;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat title="Credits bought" value={formatCredits(p.credits)}>
          {p.count} {p.count === 1 ? "purchase" : "purchases"}, {usd(p.paidCents / 100)} paid
          {p.refundedCents ? `, ${usd(p.refundedCents / 100)} refunded` : ""}
          {p.demoCount ? ` · plus ${formatCredits(p.demoCredits)} in demo purchases` : ""}
        </Stat>
        <Stat title="Free credits given" value={formatCredits(totals.free.credits)}>
          {totals.free.accounts} new {totals.free.accounts === 1 ? "account" : "accounts"}
        </Stat>
        <Stat title="Credits used" value={formatCredits(totals.usedCredits)}>
          {usd(data.totalCostUsd)} at the providers
        </Stat>
        <Stat title="Paid minus provider cost" value={usd(net)} tone={net < 0 ? "bad" : "good"}>
          {usd(data.revenueUsd)} paid − {usd(data.totalCostUsd)} cost. Credits bought now are often used later.
        </Stat>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {PROVIDERS.map((id) => {
          const use = totals.usage[id];
          const share = totals.usedCredits ? use.credits / totals.usedCredits : 0;
          return (
            <div key={id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{PROVIDER_LABELS[id]}</p>
                <p className="text-xs text-zinc-500">{Math.round(share * 100)}% of use</p>
              </div>
              <p className="mt-1 text-xl font-semibold tabular-nums">{formatCredits(use.credits)} credits</p>
              <p className="text-xs text-zinc-500">
                {usd(data.costUsd[id])} cost · {formatCredits(use.requests)} {use.requests === 1 ? "request" : "requests"}
              </p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-foreground" style={{ width: `${share * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <details className="rounded-lg border border-zinc-200 dark:border-zinc-800" open={data.days.length <= 31}>
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">By day ({data.days.length})</summary>
        {data.days.length === 0 ? (
          <p className="px-3 pb-3 text-sm text-zinc-500">Nothing bought or used in these dates.</p>
        ) : (
          <div className="overflow-x-auto border-t border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-2xl text-sm">
              <thead>
                <tr>
                  <th className={TH}>Day</th>
                  <th className={`${TH} text-right`}>Bought</th>
                  <th className={`${TH} text-right`}>Paid</th>
                  <th className={`${TH} text-right`}>Free</th>
                  {PROVIDERS.map((id) => (
                    <th key={id} className={`${TH} text-right`}>
                      {PROVIDER_LABELS[id]}
                    </th>
                  ))}
                  <th className={`${TH} text-right`}>Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {data.days.map((d) => {
                  const used = PROVIDERS.reduce((sum, id) => sum + d.used[id].credits, 0);
                  return (
                    <tr key={d.day}>
                      <td className={`${TD} whitespace-nowrap`}>{d.day}</td>
                      <td className={`${TD} text-right`}>{d.boughtCredits ? formatCredits(d.boughtCredits) : "—"}</td>
                      <td className={`${TD} text-right`}>{d.paidCents ? usd(d.paidCents / 100) : "—"}</td>
                      <td className={`${TD} text-right`}>{d.freeCredits ? formatCredits(d.freeCredits) : "—"}</td>
                      {PROVIDERS.map((id) => (
                        <td key={id} className={`${TD} text-right`}>
                          {d.used[id].credits ? formatCredits(d.used[id].credits) : "—"}
                        </td>
                      ))}
                      <td className={`${TD} text-right`}>{used ? usd(used / data.creditsPerUsd) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <details className="rounded-lg border border-zinc-200 dark:border-zinc-800" open>
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
          By user ({data.userCount}
          {data.userCount > data.users.length ? `, top ${data.users.length} shown` : ""})
        </summary>
        {data.users.length === 0 ? (
          <p className="px-3 pb-3 text-sm text-zinc-500">No one bought or used credits in these dates.</p>
        ) : (
          <div className="overflow-x-auto border-t border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-3xl text-sm">
              <thead>
                <tr>
                  <th className={TH}>User</th>
                  <th className={`${TH} text-right`}>Bought</th>
                  <th className={`${TH} text-right`}>Paid</th>
                  {PROVIDERS.map((id) => (
                    <th key={id} className={`${TH} text-right`}>
                      {PROVIDER_LABELS[id]}
                    </th>
                  ))}
                  <th className={`${TH} text-right`}>Used</th>
                  <th className={`${TH} text-right`}>Cost</th>
                  <th className={`${TH} text-right`}>Balance now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {data.users.map((u) => (
                  <tr key={u.userId}>
                    <td className="px-3 py-1.5">
                      <span className="block font-medium">{u.name || u.email || (u.deleted ? "Deleted account" : "Unknown")}</span>
                      {u.name && u.email && <span className="block text-xs text-zinc-500">{u.email}</span>}
                    </td>
                    <td className={`${TD} text-right`}>{u.boughtCredits ? formatCredits(u.boughtCredits) : "—"}</td>
                    <td className={`${TD} text-right`}>{u.paidCents ? usd(u.paidCents / 100) : "—"}</td>
                    {PROVIDERS.map((id) => (
                      <td key={id} className={`${TD} text-right`}>
                        {u.used[id].credits ? formatCredits(u.used[id].credits) : "—"}
                      </td>
                    ))}
                    <td className={`${TD} text-right font-medium`}>{formatCredits(u.usedCredits)}</td>
                    <td className={`${TD} text-right`}>{usd(u.usedCredits / data.creditsPerUsd)}</td>
                    <td className={`${TD} text-right ${u.balance !== null && u.balance <= 0 ? "text-red-700 dark:text-red-400" : ""}`}>
                      {u.balance === null ? "—" : formatCredits(u.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      <p className="text-xs text-zinc-500">
        Days are in {data.zone}. Bought credits count on the day they were paid. Cost is what the use cost at the providers, at the app&apos;s
        prices.
      </p>
    </div>
  );
}

function Stat({ title, value, tone, children }: { title: string; value: string; tone?: "good" | "bad"; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs text-zinc-500">{title}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "bad" ? "text-red-700 dark:text-red-400" : tone === "good" ? "text-emerald-700 dark:text-emerald-400" : ""}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-zinc-500">{children}</p>
    </div>
  );
}
