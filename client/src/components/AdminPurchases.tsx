"use client";

import { useCallback, useEffect, useState } from "react";
import { formatCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { Badge, Button, EmptyState, ErrorText, Notice, Segmented, Spinner, inputClass } from "./site/ui";

type Purchase = {
  id: string;
  createdAt: string;
  paidAt?: string;
  status: string;
  provider: "stripe" | "demo";
  livemode?: boolean;
  buyer?: { email: string | null; name: string | null };
  account: { id: string; email?: string | null; name?: string | null; deleted?: boolean };
  credits: number;
  refundedCredits?: number;
  currency: string;
  priceCents: number;
  amountPaidCents?: number;
  feeCents?: number | null;
  refundedCents?: number;
  disputedCents?: number;
  card?: { brand: string; last4: string; country: string | null } | null;
  method?: string | null;
  paymentIntentId?: string;
  receiptUrl?: string | null;
};

type Sums = {
  purchases: number;
  paidCents: number;
  feeCents: number;
  refundedCents: number;
  disputedCents: number;
  credits: number;
  creditsTakenBack: number;
};
type Totals = {
  currency: string;
  allTime: { live: Sums; test: Sums };
  last30Days: { live: Sums; test: Sums };
  pending: number;
};
type Page = { items: Purchase[]; more: boolean; totals?: Totals; purchases?: "stripe" | "demo" | "off" };

type Mode = "all" | "live" | "test";
type Filters = { q: string; status: string; mode: Mode; provider: string };

const PAGE = 50;
const STATUSES: Record<string, string> = {
  pending: "Waiting for payment",
  paid: "Paid",
  failed: "Didn't go through",
  expired: "Not completed",
  refunded: "Refunded",
  "part-refunded": "Partly refunded",
  disputed: "Disputed",
};
const STATUS_TONE: Record<string, string> = {
  paid: "text-emerald-700 dark:text-emerald-400",
  refunded: "text-amber-700 dark:text-amber-400",
  "part-refunded": "text-amber-700 dark:text-amber-400",
  disputed: "text-red-700 dark:text-red-400",
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const money = (cents: number | null | undefined, currency = "usd") =>
  typeof cents === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100) : "—";

const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
const TD = "px-3 py-2 align-top";

function query(filters: Filters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.status) params.set("status", filters.status);
  if (filters.mode !== "all") params.set("mode", filters.mode);
  if (filters.provider) params.set("provider", filters.provider);
  return params.toString();
}

/** The admin's list of every account's credit purchases (GET /api/admin/purchases), with totals. */
export function AdminPurchases() {
  const [filters, setFilters] = useState<Filters>({ q: "", status: "", mode: "all", provider: "" });
  // The search box waits for a pause in typing.
  const [typed, setTyped] = useState("");
  const [items, setItems] = useState<Purchase[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [purchases, setPurchases] = useState<Page["purchases"]>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.q === typed ? f : { ...f, q: typed })), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const fetchPage = useCallback((before?: string) => api<Page>(`/api/admin/purchases?${query(filters, { limit: String(PAGE), ...(before && { before }) })}`), [filters]);

  useEffect(() => {
    let cancelled = false;
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setError(null);
        setItems(page.items);
        setMore(page.more);
        if (page.totals) setTotals(page.totals);
        if (page.purchases) setPurchases(page.purchases);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function showOlder() {
    const before = items?.at(-1)?.createdAt;
    if (!before) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(before);
      setItems((old) => [...(old ?? []), ...page.items.filter((p) => !old?.some((o) => o.id === p.id))]);
      setMore(page.more);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const filtered = Boolean(filters.q || filters.status || filters.provider || filters.mode !== "all");

  return (
    <div className="space-y-6">
      {purchases && purchases !== "stripe" && (
        <Notice tone="warning">
          Stripe isn&apos;t set up on this server (no <code>STRIPE_SECRET_KEY</code>), so nobody can pay for credits
          {purchases === "demo" ? " — only demo purchases, which charge nothing" : ""}.
        </Notice>
      )}

      {totals && <TotalsPanel totals={totals} />}

      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-60 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Search</span>
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Email, name or Stripe payment id"
            className={`${inputClass} mt-1`}
          />
        </label>
        <label className="text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Status</span>
          <select value={filters.status} onChange={(e) => set("status", e.target.value)} className={`${inputClass} mt-1`}>
            <option value="">Any status</option>
            {Object.entries(STATUSES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Kind</span>
          <select value={filters.provider} onChange={(e) => set("provider", e.target.value)} className={`${inputClass} mt-1`}>
            <option value="">Stripe and demo</option>
            <option value="stripe">Stripe only</option>
            <option value="demo">Demo only</option>
          </select>
        </label>
        <Segmented<Mode>
          label="Live or test payments"
          value={filters.mode}
          onChange={(mode) => set("mode", mode)}
          options={[
            { value: "all", label: "All" },
            { value: "live", label: "Live" },
            { value: "test", label: "Test" },
          ]}
        />
        <a
          href={`/api/admin/purchases.csv?${query(filters)}`}
          download
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Download CSV
        </a>
      </div>

      <ErrorText error={error} />

      {items === null ? (
        !error && <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={filtered ? "No purchases match" : "No purchases yet"}>
          {filtered ? "Try another search or filter." : "Purchases appear here as soon as someone starts paying for credits."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-3xl text-sm">
            <thead className="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className={TH}>When</th>
                <th className={TH}>Buyer</th>
                <th className={`${TH} text-right`}>Paid</th>
                <th className={`${TH} text-right`}>Credits</th>
                <th className={TH}>Status</th>
                <th className={TH}>Payment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {items.map((p) => (
                <PurchaseRow key={p.id} purchase={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {more && (
        <Button disabled={loading} onClick={() => void showOlder()}>
          {loading ? "Loading…" : "Show older"}
        </Button>
      )}
    </div>
  );
}

function PurchaseRow({ purchase: p }: { purchase: Purchase }) {
  const email = p.buyer?.email ?? p.account.email;
  const name = p.buyer?.name ?? p.account.name;
  const changed = !p.account.deleted && p.buyer?.email && p.account.email && p.account.email !== p.buyer.email;
  const stripeUrl =
    p.provider === "stripe" && p.paymentIntentId
      ? `https://dashboard.stripe.com/${p.livemode ? "" : "test/"}payments/${encodeURIComponent(p.paymentIntentId)}`
      : null;

  return (
    <tr>
      <td className={`${TD} whitespace-nowrap text-zinc-500`}>{dateFormat.format(new Date(p.createdAt))}</td>
      <td className={`${TD} min-w-0`}>
        <span className="block font-medium">{name || email || "Unknown"}</span>
        {name && email && <span className="block text-xs text-zinc-500">{email}</span>}
        {p.account.deleted && <span className="block text-xs text-red-600 dark:text-red-400">Account deleted</span>}
        {changed && <span className="block text-xs text-zinc-500">Now {p.account.email}</span>}
      </td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
        {p.provider === "demo" ? (
          <span className="text-zinc-500">Demo</span>
        ) : (
          <>
            {money(p.amountPaidCents ?? p.priceCents, p.currency)}
            {typeof p.feeCents === "number" && <span className="block text-xs text-zinc-500">fee {money(p.feeCents, p.currency)}</span>}
            {p.refundedCents ? <span className="block text-xs text-amber-700 dark:text-amber-400">−{money(p.refundedCents, p.currency)} refunded</span> : null}
            {p.disputedCents ? <span className="block text-xs text-red-700 dark:text-red-400">{money(p.disputedCents, p.currency)} disputed</span> : null}
          </>
        )}
      </td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
        {formatCredits(p.credits)}
        {p.refundedCredits ? <span className="block text-xs text-zinc-500">−{formatCredits(p.refundedCredits)} taken back</span> : null}
      </td>
      <td className={TD}>
        <span className={STATUS_TONE[p.status] ?? ""}>{STATUSES[p.status] ?? p.status}</span>
        {p.provider === "stripe" && !p.livemode && (
          <span className="ml-2">
            <Badge>Test</Badge>
          </span>
        )}
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        {p.card ? (
          <span className="block capitalize">
            {p.card.brand} ···· {p.card.last4}
            {p.card.country && <span className="text-zinc-500"> · {p.card.country}</span>}
          </span>
        ) : p.method ? (
          <span className="block">{p.method.replace(/_/g, " ")}</span>
        ) : null}
        <span className="flex gap-3 text-xs">
          {stripeUrl && (
            <a href={stripeUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              Open in Stripe
            </a>
          )}
          {p.receiptUrl && (
            <a href={p.receiptUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              Receipt
            </a>
          )}
        </span>
      </td>
    </tr>
  );
}

/** Live money first (test only when there is some): paid, fees, refunds and what's left. */
function TotalsPanel({ totals }: { totals: Totals }) {
  const modes = (["live", "test"] as const).filter((m) => m === "live" || totals.allTime.test.purchases > 0);
  return (
    <div className="space-y-4">
      {modes.map((mode) => (
        <section key={mode} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium">{mode === "live" ? "Live payments" : "Test payments (no real money)"}</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <SumsCard title="Last 30 days" sums={totals.last30Days[mode]} currency={totals.currency} />
            <SumsCard title="All time" sums={totals.allTime[mode]} currency={totals.currency} />
          </div>
        </section>
      ))}
      {totals.pending > 0 && (
        <p className="text-xs text-zinc-500">
          {totals.pending} {totals.pending === 1 ? "payment is" : "payments are"} waiting: started but not finished on Stripe&apos;s page.
        </p>
      )}
    </div>
  );
}

function SumsCard({ title, sums, currency }: { title: string; sums: Sums; currency: string }) {
  const net = sums.paidCents - sums.feeCents - sums.refundedCents - sums.disputedCents;
  const rows = [
    { label: "Paid", value: money(sums.paidCents, currency) },
    { label: "Stripe fees", value: money(-sums.feeCents, currency) },
    { label: "Refunded", value: money(-sums.refundedCents, currency) },
    ...(sums.disputedCents ? [{ label: "Disputed", value: money(-sums.disputedCents, currency) }] : []),
  ];
  return (
    <div>
      <p className="text-xs text-zinc-500">{title}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{money(net, currency)}</p>
      <p className="text-xs text-zinc-500">
        kept from {sums.purchases} {sums.purchases === 1 ? "purchase" : "purchases"} · {formatCredits(sums.credits - sums.creditsTakenBack)} credits sold
      </p>
      <dl className="mt-3 space-y-1 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-2">
            <dt className="text-zinc-500">{r.label}</dt>
            <dd className="tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
