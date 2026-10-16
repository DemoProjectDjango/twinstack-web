"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { CreditActivity } from "./CreditActivity";
import { Button, ErrorText, Notice, Spinner, inputClass } from "./site/ui";

type ProviderId = "claude" | "deepseek" | "openai";
type ErrorKind = "balance" | "rate_limit" | "auth" | "overloaded" | "other";

type Balance = {
  source: "live" | "entered" | null;
  amountUsd?: number;
  remainingUsd?: number;
  spentSinceUsd?: number;
  asOf?: string;
  setBy?: string;
  autoReload?: boolean;
  currency?: string;
  original?: number | null;
  available?: boolean;
  error?: string;
};

type CostDay = { day: string; providerUsd?: number; recordedUsd?: number; differenceUsd?: number; flagged?: boolean; error?: string | null };

type Provider = {
  provider: ProviderId;
  name: string;
  balance: Balance;
  spend: { last24hUsd: number; last7dUsd: number; perDayUsd: number; last24hCredits: number; last7dCredits: number };
  runwayDays: number | null;
  level: "ok" | "low" | "empty" | "unknown";
  errors: {
    last24h: Partial<Record<ErrorKind, number>>;
    last7d: Partial<Record<ErrorKind, number>>;
    latest: { kind: ErrorKind; status: number; message: string; at: string } | null;
  };
  costCheck: boolean;
  costs: CostDay[];
};

type RecentPurchase = {
  id: string;
  createdAt: string;
  status: string;
  provider: "stripe" | "demo";
  credits: number;
  currency: string;
  priceCents: number;
  amountPaidCents?: number;
  buyer?: { email: string | null; name: string | null };
  account: { email?: string | null; name?: string | null };
};

type Health = {
  providers: Provider[];
  recentPurchases: RecentPurchase[];
  outstanding: { credits: number; accounts: number; usd: number };
  alertDays: number;
  emailsTo: number;
  emailConfigured: boolean;
  checkedAt: string;
};

const LEVELS = {
  ok: { label: "OK", className: "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400" },
  low: { label: "Running low", className: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  empty: { label: "Out of balance", className: "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400" },
  unknown: { label: "Balance unknown", className: "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400" },
};

const ERROR_NAMES: Record<ErrorKind, string> = {
  balance: "out of balance",
  rate_limit: "rate limited",
  auth: "key refused",
  overloaded: "overloaded",
  other: "server errors",
};

// Where each provider's balance and auto-reload live.
const BILLING_URLS: Record<ProviderId, string> = {
  claude: "https://platform.claude.com/settings/billing",
  openai: "https://platform.openai.com/settings/organization/billing/overview",
  deepseek: "https://platform.deepseek.com/top_up",
};

const usd = (n: number | undefined | null) =>
  typeof n === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n) : "—";
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
// The balances, spend and purchases are fetched again this often while the page is open.
const REFRESH_MS = 30_000;
const PURCHASE_STATUS: Record<string, string> = {
  pending: "Waiting for payment",
  paid: "Paid",
  failed: "Didn't go through",
  expired: "Not completed",
  refunded: "Refunded",
  "part-refunded": "Partly refunded",
  disputed: "Disputed",
};
const TD = "px-3 py-1.5";

/** The admin's view of the app's provider keys (GET /api/admin/providers, provider-health.js). */
export function AdminProviders() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"refresh" | "costs" | null>(null);

  // Every REFRESH_MS, so purchases and use show up as they happen (DeepSeek's balance is cached on
  // the server for a few minutes).
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Health>("/api/admin/providers")
        .then((h) => !cancelled && setHealth(h))
        .catch((err) => !cancelled && setError(err));
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function run(kind: "refresh" | "costs") {
    setBusy(kind);
    setError(null);
    try {
      setHealth(
        kind === "costs"
          ? await api<Health>("/api/admin/providers/check", { method: "POST", body: {} })
          : await api<Health>("/api/admin/providers?fresh=1"),
      );
      if (kind === "costs") toast.success("Costs checked against the providers' reports.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!health) return error ? <ErrorText error={error} /> : <Spinner />;

  return (
    <div className="space-y-6">
      {health.providers.length === 0 && (
        <Notice tone="warning">No provider keys are set on this server, so nobody&apos;s requests run on the app&apos;s keys.</Notice>
      )}
      {(!health.emailConfigured || health.emailsTo === 0) && (
        <Notice tone="warning">
          {health.emailsTo === 0
            ? "No admin emails are set (ADMIN_EMAILS), so nobody is told when a provider runs low."
            : "Emails aren't set up (RESEND_API_KEY), so the low-balance alerts are only written to the server log."}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy !== null} onClick={() => void run("refresh")}>
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </Button>
        {health.providers.some((p) => p.costCheck) && (
          <Button disabled={busy !== null} onClick={() => void run("costs")}>
            {busy === "costs" ? "Checking…" : "Check costs now"}
          </Button>
        )}
        <p className="text-xs text-zinc-500">
          Checked {dateFormat.format(new Date(health.checkedAt))}. Admins are emailed below {health.alertDays} days of balance, and at once
          when a provider refuses a request for want of one.
        </p>
      </div>
      <ErrorText error={error} />

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Credits users still hold</h2>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{usd(health.outstanding.usd)}</p>
        <p className="text-xs text-zinc-500">
          {formatCredits(health.outstanding.credits)} credits across {health.outstanding.accounts}{" "}
          {health.outstanding.accounts === 1 ? "account" : "accounts"}: the most they could still spend on the app&apos;s keys before buying
          more.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {health.providers.map((p) => (
          <ProviderCard key={p.provider} provider={p} onSaved={setHealth} />
        ))}
      </div>

      <RecentPurchases purchases={health.recentPurchases ?? []} />

      <CreditActivity />
    </div>
  );
}

/** The latest credit purchases from every account, newest first. */
function RecentPurchases({ purchases }: { purchases: RecentPurchase[] }) {
  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
        <h2 className="text-sm font-medium">Latest credit purchases</h2>
        <Link href="/admin/purchases" className="text-xs underline-offset-2 hover:underline">
          All purchases →
        </Link>
      </header>
      {purchases.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-zinc-500">No one has bought credits yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-xl text-sm">
            <tbody className="divide-y divide-zinc-100 border-t border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
              {purchases.map((p) => {
                const who = p.buyer?.name || p.buyer?.email || p.account.name || p.account.email || "Unknown";
                return (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap px-4 py-2 text-zinc-500">{dateFormat.format(new Date(p.createdAt))}</td>
                    <td className="px-4 py-2">{who}</td>
                    <td className="px-4 py-2 text-right tabular-nums">+{formatCredits(p.credits)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{p.provider === "demo" ? "Demo" : usd((p.amountPaidCents ?? p.priceCents) / 100)}</td>
                    <td className={`px-4 py-2 ${p.status === "paid" ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500"}`}>
                      {PURCHASE_STATUS[p.status] ?? p.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ProviderCard({ provider: p, onSaved }: { provider: Provider; onSaved: (h: Health) => void }) {
  const level = LEVELS[p.level];
  const b = p.balance;
  const errorKinds = (Object.keys(ERROR_NAMES) as ErrorKind[]).filter((k) => p.errors.last7d[k]);

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{p.name}</h2>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${level.className}`}>{level.label}</span>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs text-zinc-500">Balance left</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{typeof b.remainingUsd === "number" ? usd(Math.max(0, b.remainingUsd)) : "Not known"}</p>
          <p className="text-xs text-zinc-500">
            {p.runwayDays === null
              ? p.spend.perDayUsd > 0
                ? "Enter the balance to see how long it lasts."
                : "No spend in the last week."
              : `About ${p.runwayDays < 1 ? "less than a day" : `${Math.floor(p.runwayDays)} ${Math.floor(p.runwayDays) === 1 ? "day" : "days"}`} at ${usd(p.spend.perDayUsd)} a day.`}
          </p>
        </div>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Last 24 hours</dt>
            <dd className="tabular-nums">
              {usd(p.spend.last24hUsd)} <span className="text-xs text-zinc-500">({formatCredits(p.spend.last24hCredits ?? 0)} credits)</span>
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Last 7 days</dt>
            <dd className="tabular-nums">
              {usd(p.spend.last7dUsd)} <span className="text-xs text-zinc-500">({formatCredits(p.spend.last7dCredits ?? 0)} credits)</span>
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-zinc-500">Counted per day</dt>
            <dd className="tabular-nums">{usd(p.spend.perDayUsd)}</dd>
          </div>
        </dl>
      </div>

      <BalanceSource provider={p} onSaved={onSaved} />

      <div>
        <p className="text-xs font-medium text-zinc-500">Refusals in the last 7 days</p>
        {errorKinds.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">None.</p>
        ) : (
          <>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {errorKinds.map((k) => (
                <li key={k} className={k === "balance" || k === "auth" ? "text-red-700 dark:text-red-400" : ""}>
                  {p.errors.last7d[k]} {ERROR_NAMES[k]}
                  {p.errors.last24h[k] ? <span className="text-zinc-500"> ({p.errors.last24h[k]} today)</span> : null}
                </li>
              ))}
            </ul>
            {p.errors.latest && (
              <p className="mt-1 text-xs text-zinc-500">
                Latest, {dateFormat.format(new Date(p.errors.latest.at))} ({p.errors.latest.status}): {p.errors.latest.message || ERROR_NAMES[p.errors.latest.kind]}
              </p>
            )}
          </>
        )}
      </div>

      <CostChecks provider={p} />

      {p.provider === "deepseek" && (
        <p className="text-xs text-zinc-500">Spend is counted at DeepSeek&apos;s peak-hour prices, so it can read higher than DeepSeek charges.</p>
      )}
    </section>
  );
}

function BalanceSource({ provider: p, onSaved }: { provider: Provider; onSaved: (h: Health) => void }) {
  const b = p.balance;
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const entered = p.provider !== "deepseek";

  async function save(body: { amountUsd?: number; autoReload?: boolean }) {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api<Health>(`/api/admin/providers/${p.provider}/balance`, { method: "PUT", body }));
      setAmount("");
      if (body.amountUsd !== undefined) toast.success(`${p.name}'s balance saved.`);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const typed = amount.trim() === "" ? null : Number(amount);
  const valid = typed !== null && Number.isFinite(typed) && typed >= 0;

  return (
    <div className="space-y-2 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
      {!entered ? (
        b.error ? (
          <p className="text-red-700 dark:text-red-400">DeepSeek&apos;s balance couldn&apos;t be read: {b.error}</p>
        ) : (
          <p className="text-zinc-600 dark:text-zinc-400">
            Read from DeepSeek {b.asOf ? dateFormat.format(new Date(b.asOf)) : ""}
            {b.currency === "CNY" && typeof b.original === "number" && ` (¥${b.original.toFixed(2)}, converted at CNY_PER_USD)`}.
          </p>
        )
      ) : b.source === "entered" ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          {usd(b.amountUsd)} entered {b.asOf ? dateFormat.format(new Date(b.asOf)) : ""}
          {b.setBy ? ` by ${b.setBy}` : ""}; {usd(b.spentSinceUsd)} recorded since.
        </p>
      ) : (
        <p className="text-zinc-600 dark:text-zinc-400">{p.name.split(" ")[0]} doesn&apos;t report its balance. Enter it from the billing page after each top-up.</p>
      )}

      {entered && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 basis-40">
            <span className="text-xs text-zinc-500">Balance now, in dollars</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="120.50"
              className={`${inputClass} mt-1`}
            />
          </label>
          <Button variant="primary" disabled={saving || !valid} onClick={() => void save({ amountUsd: typed! })}>
            {saving ? "Saving…" : "Save balance"}
          </Button>
        </div>
      )}
      {entered && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(b.autoReload)} disabled={saving} onChange={(e) => void save({ autoReload: e.target.checked })} />
          <span>Auto-reload is on in {p.name.split(" ")[0]}&apos;s billing settings</span>
        </label>
      )}
      <a href={BILLING_URLS[p.provider]} target="_blank" rel="noreferrer" className="inline-block text-xs underline-offset-2 hover:underline">
        Open {p.name.split(" ")[0]}&apos;s billing page
      </a>
      <ErrorText error={error} />
    </div>
  );
}

function CostChecks({ provider: p }: { provider: Provider }) {
  if (!p.costCheck) {
    return p.provider === "deepseek" ? null : (
      <p className="text-xs text-zinc-500">
        Add {p.provider === "claude" ? "ANTHROPIC_ADMIN_KEY" : "OPENAI_ADMIN_KEY"} to the server to check each day&apos;s recorded spend against{" "}
        {p.name.split(" ")[0]}&apos;s own cost report.
      </p>
    );
  }
  const days = p.costs.filter((c) => !c.error);
  const failed = p.costs.find((c) => c.error);
  return (
    <div>
      <p className="text-xs font-medium text-zinc-500">Daily cost check against {p.name.split(" ")[0]}&apos;s report</p>
      {failed && <p className="mt-1 text-xs text-red-700 dark:text-red-400">Last check failed: {failed.error}</p>}
      {days.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-500">No days checked yet. The check runs once a day after 02:00 UTC.</p>
      ) : (
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Day (UTC)</th>
                <th className={`${TH} text-right`}>{p.name.split(" ")[0]}</th>
                <th className={`${TH} text-right`}>Recorded</th>
                <th className={`${TH} text-right`}>Difference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {days.map((c) => (
                <tr key={c.day} className={c.flagged ? "text-red-700 dark:text-red-400" : ""}>
                  <td className={TD}>{c.day}</td>
                  <td className={`${TD} text-right tabular-nums`}>{usd(c.providerUsd)}</td>
                  <td className={`${TD} text-right tabular-nums`}>{usd(c.recordedUsd)}</td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {typeof c.differenceUsd === "number" && c.differenceUsd > 0 ? "+" : ""}
                    {usd(c.differenceUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {days.some((c) => c.flagged) && (
            <p className="mt-1 text-xs text-zinc-500">
              Red days differ by more than 5% (or 50¢). A negative difference means users were charged less than it cost: check PRICES in
              server/src/credits.js, and whether anything else uses this key.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
