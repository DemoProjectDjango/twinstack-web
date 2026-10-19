"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { formatCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { type Pricing, PurchaseInsights } from "./PurchaseInsights";
import { Button, EmptyState, ErrorText, Notice, Spinner, inputClass } from "./site/ui";

/** A purchase's real money (server credits.js purchaseMoney), in cents. Null for demo purchases. */
type Money = {
  paidCents: number;
  creditsValueCents: number;
  refundedCents: number;
  /** The fixed share kept (less any refund), before Stripe's fee. */
  keptCents: number;
  stripeFeeCents: number;
  feeEstimated: boolean;
  profitCents: number;
} | null;

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
  card?: { brand: string; last4: string; country: string | null } | null;
  method?: string | null;
  paymentIntentId?: string;
  stripeSessionId?: string;
  receiptUrl?: string | null;
  money: Money;
};

type Page = { items: Purchase[]; more: boolean; purchases?: "stripe" | "demo" | "off"; pricing?: Pricing };

type Mode = "all" | "live" | "test";
type Filters = { q: string; status: string; mode: Mode; provider: string };

const PAGE = 50;
const STATUSES: Record<string, { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
  paid: { label: "Paid", tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" },
  failed: { label: "Failed", tone: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400" },
  expired: { label: "Not completed", tone: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  refunded: { label: "Refunded", tone: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  "part-refunded": { label: "Partly refunded", tone: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  disputed: { label: "Disputed", tone: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400" },
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const money = (cents: number | null | undefined, currency = "usd") =>
  typeof cents === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100) : "—";

const TH = "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-zinc-500";
const TD = "px-3 py-3 align-top";

function query(filters: Filters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.status) params.set("status", filters.status);
  if (filters.mode !== "all") params.set("mode", filters.mode);
  if (filters.provider) params.set("provider", filters.provider);
  return params.toString();
}

/**
 * The admin's view of every account's credit purchases (GET /api/admin/purchases): where the money
 * went (credits, Stripe's fee, refunds, the platform's share), then each purchase, which opens to
 * its payment details.
 */
export function AdminPurchases() {
  const [filters, setFilters] = useState<Filters>({ q: "", status: "", mode: "all", provider: "" });
  // The search box waits for a pause in typing.
  const [typed, setTyped] = useState("");
  const [items, setItems] = useState<Purchase[] | null>(null);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const list = useRef<HTMLElement>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
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
        if (page.pricing) setPricing(page.pricing);
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
    <div className="space-y-8">
      {purchases && purchases !== "stripe" && (
        <Notice tone="warning">
          Stripe isn&apos;t set up on this server (no <code>STRIPE_SECRET_KEY</code>), so nobody can pay for credits
          {purchases === "demo" ? ". Only demo purchases work here, and they charge nothing" : ""}.
        </Notice>
      )}

      <PurchaseInsights
        pricing={pricing}
        onStatusCounts={setStatusCounts}
        onBuyer={(email) => {
          setTyped(email);
          list.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      <section ref={list} className="scroll-mt-6 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold">All purchases</h2>
          <DownloadMenu filters={filters} />
        </div>

        <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <label className="text-sm">
            <span className="sr-only">Search</span>
            <input
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search by email, name or Stripe payment id"
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="sr-only">Kind</span>
            <select value={filters.provider} onChange={(e) => set("provider", e.target.value)} className={inputClass}>
              <option value="">Stripe and demo</option>
              <option value="stripe">Stripe only</option>
              <option value="demo">Demo only</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="sr-only">Live or test</span>
            <select value={filters.mode} onChange={(e) => set("mode", e.target.value as Mode)} className={inputClass}>
              <option value="all">Live and test</option>
              <option value="live">Live payments</option>
              <option value="test">Test payments</option>
            </select>
          </label>
        </div>
        <StatusChips counts={statusCounts} value={filters.status} onChange={(status) => set("status", status)} />
        </div>
        {filters.q && (
          <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            Showing purchases matching <span className="font-medium text-foreground">&ldquo;{filters.q}&rdquo;</span>
            <button type="button" onClick={() => setTyped("")} className="text-xs underline-offset-2 hover:underline">
              Clear
            </button>
          </p>
        )}

        <ErrorText error={error} />

        {items === null ? (
          !error && <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title={filtered ? "No purchases match" : "No purchases yet"}>
            {filtered ? "Try another search or filter." : "Purchases appear here as soon as someone starts paying for credits."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-4xl text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40">
                <tr>
                  <th className={TH}>Buyer</th>
                  <th className={`${TH} text-right`}>Paid</th>
                  <th className={`${TH} text-right`}>Credits given</th>
                  <th className={`${TH} text-right`}>Stripe fee</th>
                  <th className={`${TH} text-right`}>Profit</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>When</th>
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
      </section>
    </div>
  );
}

/** One button per status, each with how many purchases have it (all time); the chosen one filters the list. */
function StatusChips({ counts, value, onChange }: { counts: Record<string, number>; value: string; onChange: (status: string) => void }) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const chips = [{ status: "", label: "All", count: total, tone: "" }, ...Object.entries(STATUSES).map(([status, { label, tone }]) => ({ status, label, count: counts[status] ?? 0, tone }))].filter(
    (c) => c.status === "" || c.count > 0 || c.status === value,
  );
  return (
    <div role="radiogroup" aria-label="Status" className="flex flex-wrap gap-1.5">
      {chips.map((c) => {
        const on = value === c.status;
        return (
          <button
            key={c.status || "all"}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(on && c.status ? "" : c.status)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              on ? "border-foreground bg-foreground text-background" : "border-zinc-300 bg-background hover:border-zinc-400 dark:border-zinc-700"
            }`}
          >
            {c.label}
            <span className={`rounded-full px-1.5 tabular-nums ${on ? "bg-background/20" : c.tone || "bg-zinc-100 dark:bg-zinc-800"}`}>{c.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ downloads */

const DOWNLOADS = [
  { format: "pdf", label: "PDF", note: "A printable report: the profit summary, then every purchase" },
  { format: "xlsx", label: "Excel", note: "A summary sheet, and every purchase with totals that follow your filters" },
  { format: "csv", label: "CSV", note: "One plain table, for importing into other tools" },
] as const;

/** The purchases matching the filters as a file (GET /api/admin/purchases/export), dates in this browser's time zone. */
function DownloadMenu({ filters }: { filters: Filters }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Download
        <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-lg border border-zinc-200 bg-background shadow-lg dark:border-zinc-800">
          {DOWNLOADS.map((d) => (
            <a
              key={d.format}
              role="menuitem"
              href={`/api/admin/purchases/export?${query(filters, { format: d.format, tz })}`}
              download
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              <span className="block text-sm font-medium">{d.label}</span>
              <span className="block text-xs text-zinc-500">{d.note}</span>
            </a>
          ))}
          <p className="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">Uses the search and filters set below.</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ rows */

function PurchaseRow({ purchase: p }: { purchase: Purchase }) {
  const [open, setOpen] = useState(false);
  const email = p.buyer?.email ?? p.account.email;
  const name = p.buyer?.name ?? p.account.name;
  const status = STATUSES[p.status] ?? { label: p.status, tone: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" };
  const m = p.money;
  const settled = m && m.paidCents > 0;

  return (
    <Fragment>
      <tr className={`cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/60 ${open ? "bg-zinc-50 dark:bg-zinc-900/60" : ""}`} onClick={() => setOpen((o) => !o)}>
        <td className={TD}>
          <button
            type="button"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="flex min-w-0 items-center gap-3 text-left"
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {(name || email || "?").trim().charAt(0)}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{name || email || "Unknown"}</span>
              {name && email && <span className="block truncate text-xs text-zinc-500">{email}</span>}
            </span>
          </button>
        </td>
        <td className={`${TD} text-right font-medium tabular-nums`}>
          {p.provider === "demo" ? <span className="font-normal text-zinc-500">Demo</span> : money(settled ? m.paidCents : p.priceCents, p.currency)}
        </td>
        <td className={`${TD} text-right tabular-nums`}>
          {formatCredits(p.credits - (p.refundedCredits ?? 0))}
          {settled && <span className="block text-xs text-zinc-500">{money(m.creditsValueCents, p.currency)} of AI use</span>}
        </td>
        <td className={`${TD} text-right tabular-nums`}>
          {settled ? (
            <>
              {money(m.stripeFeeCents, p.currency)}
              {m.feeEstimated && <span className="block text-xs text-zinc-500">estimated</span>}
            </>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </td>
        <td className={`${TD} text-right font-medium tabular-nums`}>
          {settled ? (
            <span className={m.profitCents < 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}>{money(m.profitCents, p.currency)}</span>
          ) : (
            <span className="font-normal text-zinc-400">—</span>
          )}
        </td>
        <td className={TD}>
          <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
          {p.provider === "stripe" && !p.livemode && <span className="ml-1.5 text-xs text-amber-700 dark:text-amber-400">Test</span>}
        </td>
        <td className={`${TD} whitespace-nowrap text-zinc-500`}>{dateFormat.format(new Date(p.createdAt))}</td>
      </tr>
      {open && (
        <tr className="bg-zinc-50 dark:bg-zinc-900/60">
          <td colSpan={7} className="px-3 pb-4 pt-0">
            <PurchaseDetails purchase={p} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function PurchaseDetails({ purchase: p }: { purchase: Purchase }) {
  const m = p.money;
  const stripeUrl =
    p.provider === "stripe" && p.paymentIntentId
      ? `https://dashboard.stripe.com/${p.livemode ? "" : "test/"}payments/${encodeURIComponent(p.paymentIntentId)}`
      : null;
  const rows: [string, React.ReactNode][] = [
    ["Account now", p.account.deleted ? "Deleted" : [p.account.name, p.account.email].filter(Boolean).join(" · ") || "—"],
    ["Paid at", p.paidAt ? dateFormat.format(new Date(p.paidAt)) : "Not paid"],
    [
      "Payment method",
      p.card ? (
        <span className="capitalize">
          {p.card.brand} ···· {p.card.last4}
          {p.card.country && ` (${p.card.country})`}
        </span>
      ) : (
        (p.method?.replace(/_/g, " ") ?? "—")
      ),
    ],
    ["Credits bought", `${formatCredits(p.credits)}${p.refundedCredits ? `, ${formatCredits(p.refundedCredits)} taken back` : ""}`],
    ...(m && m.refundedCents ? ([["Refunded or disputed", money(m.refundedCents, p.currency)]] as [string, React.ReactNode][]) : []),
    ["Stripe payment", p.paymentIntentId ? <CopyText text={p.paymentIntentId} /> : "—"],
  ];

  return (
    <div className="reveal rounded-md border border-zinc-200 bg-background p-4 shadow-sm dark:border-zinc-800">
      {m && m.paidCents > 0 && (
        <div className="mb-4 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
          <span className="text-zinc-500">Buyer paid</span>
          <span className="text-right font-medium tabular-nums">{money(m.paidCents, p.currency)}</span>
          <span className="text-zinc-500">Credits given</span>
          <span className="text-right tabular-nums text-sky-700 dark:text-sky-400">− {money(m.creditsValueCents, p.currency)}</span>
          {m.refundedCents > 0 && (
            <>
              <span className="text-zinc-500">Refunded or disputed</span>
              <span className="text-right tabular-nums text-red-700 dark:text-red-400">− {money(m.refundedCents, p.currency)}</span>
            </>
          )}
          <span className="border-t border-zinc-200 pt-1 text-zinc-500 dark:border-zinc-800">Kept</span>
          <span className="border-t border-zinc-200 pt-1 text-right tabular-nums dark:border-zinc-800">{money(m.keptCents, p.currency)}</span>
          <span className="text-zinc-500">Stripe fee{m.feeEstimated ? " (estimated)" : ""}</span>
          <span className="text-right tabular-nums text-amber-700 dark:text-amber-400">− {money(m.stripeFeeCents, p.currency)}</span>
          <span className="border-t border-zinc-200 pt-1 font-medium dark:border-zinc-800">Profit</span>
          <span
            className={`border-t border-zinc-200 pt-1 text-right font-semibold tabular-nums dark:border-zinc-800 ${m.profitCents < 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}
          >
            {money(m.profitCents, p.currency)}
          </span>
        </div>
      )}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        {stripeUrl && (
          <a href={stripeUrl} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">
            Open in Stripe ↗
          </a>
        )}
        {p.receiptUrl && (
          <a href={p.receiptUrl} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">
            Receipt ↗
          </a>
        )}
      </div>
    </div>
  );
}

/** Text with a button that copies it. */
function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code className="truncate text-xs">{text}</code>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
