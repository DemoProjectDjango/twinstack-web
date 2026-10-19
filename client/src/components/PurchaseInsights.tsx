"use client";

import { useEffect, useState } from "react";
import { formatCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { ErrorText, Segmented, Spinner } from "./site/ui";

// The admin Purchases page's summary (GET /api/admin/purchases/insights): profit for a period with
// the change on the period before, a chart of what was paid and kept each day, where the money went,
// and the buyers who paid the most.

type Sums = {
  purchases: number;
  paidCents: number;
  feeCents: number;
  feeEstimatedCents: number;
  refundedCents: number;
  disputedCents: number;
  credits: number;
  creditsTakenBack: number;
  creditsValueCents: number;
  keptCents: number;
  profitCents: number;
  margin: number;
};
type Point = { date: string; paidCents: number; profitCents: number; purchases: number };
type Buyer = { userId: string; email: string | null; name: string | null; purchases: number; paidCents: number; profitCents: number };
type Insights = {
  days: number;
  step: number;
  totals: Sums;
  previous: Sums;
  series: Point[];
  topBuyers: Buyer[];
  buyerCount: number;
  statusCounts: Record<string, number>;
};
export type Pricing = { platformShare: number; creditsPerPaidUsd: number; creditsPerUsd: number };

type Days = "7" | "30" | "90" | "365";
const PERIOD_WORDS: Record<Days, string> = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "12 months" };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const compactMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: cents >= 100_000 ? "compact" : "standard", maximumFractionDigits: cents >= 100_000 ? 1 : 0 }).format(cents / 100);
const percent = (n: number) => `${Math.round(n * 100)}%`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "19 Oct" from "2026-10-19". */
const dayWords = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

export function PurchaseInsights({
  pricing,
  onBuyer,
  onStatusCounts,
}: {
  pricing: Pricing | null;
  /** A top buyer was clicked: show their purchases. */
  onBuyer: (email: string) => void;
  onStatusCounts: (counts: Record<string, number>) => void;
}) {
  const [days, setDays] = useState<Days>("30");
  const [mode, setMode] = useState<"live" | "test">("live");
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api<Insights>(`/api/admin/purchases/insights?${new URLSearchParams({ days, mode, tz })}`)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
        onStatusCounts(next.statusCounts);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, mode, onStatusCounts]);

  const share = pricing ? percent(pricing.platformShare) : "20%";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Profit from credit purchases</h2>
          <p className="text-sm text-zinc-500">
            {share} of every purchase is kept; Stripe&apos;s fee is paid from it and the rest is profit.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {loading && data && <Spinner />}
          <Segmented<"live" | "test">
            label="Live or test payments"
            value={mode}
            onChange={(m) => {
              setLoading(true);
              setMode(m);
            }}
            options={[
              { value: "live", label: "Live" },
              { value: "test", label: "Test" },
            ]}
          />
          <Segmented<Days>
            label="Period"
            value={days}
            onChange={(d) => {
              setLoading(true);
              setDays(d);
            }}
            options={(Object.keys(PERIOD_WORDS) as Days[]).map((d) => ({ value: d, label: d === "365" ? "12 months" : `${d} days` }))}
          />
        </div>
      </div>

      <ErrorText error={error} />
      {!data ? (
        !error && (
          <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800">
            <Spinner />
          </div>
        )
      ) : (
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {mode === "test" && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Test payments: no real money.</p>
          )}
          <Kpis data={data} period={PERIOD_WORDS[days]} share={share} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Chart data={data} />
            <TopBuyers data={data} onBuyer={onBuyer} />
          </div>
          <MoneyBar sums={data.totals} />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ figures */

/** The change on the period before: "+24%", "New" when there was nothing before. */
function Change({ now, before, invert = false, neutral = false }: { now: number; before: number; invert?: boolean; neutral?: boolean }) {
  if (!now && !before) return <span className="text-zinc-400">No change</span>;
  if (!before) return <span className="font-medium text-emerald-700 dark:text-emerald-400">New</span>;
  const change = (now - before) / Math.abs(before);
  const up = change >= 0;
  const good = invert ? !up : up;
  const tone = neutral || Math.abs(change) < 0.005 ? "text-zinc-500" : good ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400";
  return (
    <span className={`inline-flex items-center gap-0.5 font-medium tabular-nums ${tone}`}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className={`size-3 ${up ? "" : "rotate-180"}`} fill="currentColor">
        <path d="M6 2 10 8H2z" />
      </svg>
      {Math.abs(change) >= 10 ? `${Math.round(change)}×` : `${Math.round(Math.abs(change) * 100)}%`}
    </span>
  );
}

function Kpis({ data, period, share }: { data: Insights; period: string; share: string }) {
  const { totals: t, previous: p } = data;
  const bad = t.profitCents < 0;
  const cards = [
    { label: "Users paid", value: money(t.paidCents), note: `${t.purchases} ${t.purchases === 1 ? "purchase" : "purchases"} from ${data.buyerCount} ${data.buyerCount === 1 ? "buyer" : "buyers"}`, now: t.paidCents, before: p.paidCents },
    { label: "Credits given", value: money(t.creditsValueCents), note: `${formatCredits(t.credits - t.creditsTakenBack)} credits`, now: t.creditsValueCents, before: p.creditsValueCents, neutral: true },
    {
      label: "Stripe fees",
      value: money(t.feeCents),
      note: t.keptCents > 0 ? `${percent(t.feeCents / t.keptCents)} of the ${money(t.keptCents)} kept` : "Paid from the share kept",
      now: t.feeCents,
      before: p.feeCents,
      neutral: true,
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div
        className={`relative overflow-hidden rounded-xl border p-5 sm:col-span-2 lg:col-span-1 ${
          bad ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40" : "border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 dark:border-emerald-900 dark:from-emerald-950/50 dark:to-teal-950/30"
        }`}
      >
        <p className={`text-sm font-medium ${bad ? "text-red-800 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"}`}>Profit</p>
        <p className={`mt-1 text-4xl font-semibold tracking-tight tabular-nums ${bad ? "text-red-700 dark:text-red-400" : "text-emerald-800 dark:text-emerald-300"}`}>
          {money(t.profitCents)}
        </p>
        <p className="mt-1 text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
          {t.paidCents > 0 ? `${(t.margin * 100).toFixed(1)}% margin` : "No purchases"} · <Change now={t.profitCents} before={p.profitCents} />
        </p>
        <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          {money(t.keptCents)} kept ({share}) − {money(t.feeCents)} Stripe fees
          {t.feeEstimatedCents > 0 && ` (${money(t.feeEstimatedCents)} estimated)`}
        </p>
      </div>
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <p className="text-sm text-zinc-500">{c.label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{c.value}</p>
          <p className="mt-1 text-xs text-zinc-500">{c.note}</p>
          <p className="mt-3 text-xs text-zinc-500">
            <Change now={c.now} before={c.before} neutral={c.neutral} /> on the previous {period}
          </p>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ chart */

/** A bar per day (per week over 12 months): its height what users paid, the green part the profit. */
function Chart({ data }: { data: Insights }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = data.series;
  const max = Math.max(1, ...series.map((p) => p.paidCents));
  const shown = hover !== null ? series[hover] : null;
  const label = (p: Point) => (data.step > 1 ? `Week of ${dayWords(p.date)}` : dayWords(p.date));
  const empty = series.every((p) => !p.purchases);

  return (
    <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{data.step > 1 ? "Each week" : "Each day"}</p>
        <div className="flex gap-3 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm bg-sky-400 dark:bg-sky-600" />
            Paid
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm bg-emerald-500" />
            Profit
          </span>
        </div>
      </div>

      {/* What the pointer (or keyboard) is on, else the period's total. */}
      <div className="mt-2 h-10 text-sm" aria-live="polite">
        {shown ? (
          <>
            <p className="font-medium">{label(shown)}</p>
            <p className="tabular-nums text-zinc-500">
              {money(shown.paidCents)} paid · <span className="text-emerald-700 dark:text-emerald-400">{money(shown.profitCents)} profit</span> · {shown.purchases}{" "}
              {shown.purchases === 1 ? "purchase" : "purchases"}
            </p>
          </>
        ) : (
          <p className="text-zinc-500">{empty ? "No purchases in this period." : "Point at a bar to see that day."}</p>
        )}
      </div>

      <div className="relative mt-2 h-44">
        {/* Gridlines: the top value and half of it. */}
        {[1, 0.5].map((f) => (
          <div key={f} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-zinc-200 dark:border-zinc-800" style={{ bottom: `${f * 100}%` }}>
            <span className="absolute -top-2.5 right-0 bg-background pl-1 text-[10px] tabular-nums text-zinc-400">{compactMoney(max * f)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-px pr-10 sm:gap-0.5" onMouseLeave={() => setHover(null)}>
          {series.map((p, i) => {
            const paid = (p.paidCents / max) * 100;
            const profit = p.paidCents ? Math.max(0, Math.min(1, p.profitCents / p.paidCents)) * paid : 0;
            return (
              <button
                key={p.date}
                type="button"
                aria-label={`${label(p)}: ${money(p.paidCents)} paid, ${money(p.profitCents)} profit`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="group relative flex h-full flex-1 items-end justify-center rounded-t outline-none focus-visible:bg-zinc-100 dark:focus-visible:bg-zinc-900"
              >
                <span
                  className={`relative w-full max-w-6 overflow-hidden rounded-t transition-all duration-300 ${
                    hover === i ? "bg-sky-500 dark:bg-sky-500" : "bg-sky-300 group-hover:bg-sky-400 dark:bg-sky-800"
                  }`}
                  style={{ height: `${p.paidCents ? Math.max(paid, 1.5) : 0}%` }}
                >
                  <span className="absolute inset-x-0 bottom-0 bg-emerald-500 transition-all duration-300" style={{ height: paid ? `${(profit / paid) * 100}%` : 0 }} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {series.length > 0 && (
        <div className="mt-1.5 flex justify-between pr-10 text-[11px] text-zinc-400">
          <span>{dayWords(series[0].date)}</span>
          {series.length > 2 && <span>{dayWords(series[Math.floor(series.length / 2)].date)}</span>}
          <span>{dayWords(series.at(-1)!.date)}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ buyers */

function TopBuyers({ data, onBuyer }: { data: Insights; onBuyer: (email: string) => void }) {
  const top = data.topBuyers;
  const max = Math.max(1, ...top.map((b) => b.paidCents));
  return (
    <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <p className="text-sm font-medium">Top buyers</p>
      {top.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No one bought credits in this period.</p>
      ) : (
        <ol className="mt-3 space-y-1">
          {top.map((b, i) => (
            <li key={b.userId}>
              <button
                type="button"
                onClick={() => b.email && onBuyer(b.email)}
                title="Show their purchases"
                className="group w-full rounded-md px-2 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <span className="flex items-center gap-2.5">
                  <span className="w-3 text-xs tabular-nums text-zinc-400">{i + 1}</span>
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-emerald-100 text-xs font-semibold uppercase text-zinc-700 dark:from-sky-900 dark:to-emerald-900 dark:text-zinc-200"
                  >
                    {(b.name || b.email || "?").trim().charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium group-hover:underline">{b.name || b.email || "Unknown"}</span>
                    <span className="block text-xs text-zinc-500">
                      {b.purchases} {b.purchases === 1 ? "purchase" : "purchases"} · <span className="text-emerald-700 dark:text-emerald-400">{money(b.profitCents)} profit</span>
                    </span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums">{money(b.paidCents)}</span>
                </span>
                <span className="mt-1.5 ml-5 block h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <span className="block h-full rounded-full bg-sky-400 transition-all duration-500" style={{ width: `${(b.paidCents / max) * 100}%` }} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {data.buyerCount > top.length && <p className="mt-2 px-2 text-xs text-zinc-500">and {data.buyerCount - top.length} more</p>}
    </div>
  );
}

/* ------------------------------------------------------------ split */

/** Where every dollar paid went: credits, refunds, Stripe's fees and profit. */
function MoneyBar({ sums }: { sums: Sums }) {
  const refunds = sums.refundedCents + sums.disputedCents;
  const parts = [
    { label: "Credits given", cents: sums.creditsValueCents, color: "bg-sky-400" },
    { label: "Refunds and disputes", cents: refunds, color: "bg-red-500" },
    { label: "Stripe fees", cents: sums.feeCents, color: "bg-amber-400" },
    { label: "Profit", cents: Math.max(0, sums.profitCents), color: "bg-emerald-500" },
  ];
  const whole = parts.reduce((sum, p) => sum + p.cents, 0);
  if (!whole) return null;
  return (
    <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <p className="text-sm font-medium">Where the money went</p>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" role="img" aria-label="Where the money users paid went">
        {parts.map((p) =>
          p.cents > 0 ? <div key={p.label} className={`${p.color} transition-all duration-500`} style={{ width: `${(p.cents / whole) * 100}%` }} title={`${p.label}: ${money(p.cents)}`} /> : null,
        )}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {parts.map((p) => (
          <li key={p.label}>
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              <span className={`inline-block size-2 rounded-full ${p.color}`} />
              {p.label}
            </span>
            <span className="font-medium tabular-nums">{money(p.cents)}</span> <span className="text-xs tabular-nums text-zinc-500">{percent(p.cents / whole)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
