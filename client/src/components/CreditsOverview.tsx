"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { CLAUDE_SETUP_HREF } from "@/lib/claude";
import { GitHubIcon } from "./GitHubIcon";
import { type Credits, formatCredits, formatDollars, useCredits, useCreditsFailed } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { BuyCredits } from "./BuyCredits";
import { Button, ErrorText, Notice, Segmented, Spinner } from "./site/ui";

/**
 * One run (a job, an answer from the AI, a site update) as the server describes it: which site and
 * part of it, why, and its credits and tokens merged. The server never says which AI did the work.
 */
type Usage = {
  id: string;
  site: { name: string | null } | null;
  part: string;
  purpose: string;
  pictures: number;
  tokensIn: number;
  tokensOut: number;
  charged: boolean;
  ownKey: boolean;
  credits: number;
  createdAt: string;
};

/** The credits used, merged (`credits`) and split by purpose, largest first. */
type UsageSummary = { credits: number; purposes: { purpose: string; credits: number; tokensIn: number; tokensOut: number }[] };

type Purchase = {
  id: string;
  credits: number;
  priceCents: number;
  currency: string;
  provider: string;
  status: string;
  createdAt: string;
  receiptUrl?: string | null;
  refundedCredits?: number;
};

const PURCHASE_STATUS: Record<string, string> = {
  pending: "Waiting for payment",
  paid: "Paid",
  failed: "Didn't go through",
  expired: "Not completed",
  refunded: "Refunded",
  "part-refunded": "Partly refunded",
  disputed: "Disputed",
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const PAGE = 25;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const tokens = (n: number) => formatCredits(n);

/** Balance, buying credits, and the history of AI work and purchases. */
export function CreditsOverview() {
  const credits = useCredits();
  const failed = useCreditsFailed();

  if (failed) return <Notice tone="warning">Your credits couldn&apos;t be loaded. Refresh the page to try again.</Notice>;
  if (!credits) {
    return (
      <div className="mt-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <Balance credits={credits} />
        <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
          <h2 className="text-lg font-semibold">Buy credits</h2>
          <p className="mb-4 mt-1 text-sm text-zinc-500">
            Each {formatDollars(1)} buys {formatCredits(credits.purchase.creditsPerUsd)} credits.
          </p>
          <BuyCredits credits={credits} />
        </section>
      </div>
      <History active={credits.active} />
    </div>
  );
}

function Balance({ credits }: { credits: Credits }) {
  const stats = [
    { label: "Free to start", value: credits.granted },
    { label: "Bought", value: credits.purchased },
    { label: "Used", value: credits.used },
  ];
  return (
    <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-sm font-medium text-zinc-500">Balance</h2>
      <p className="mt-1 text-4xl font-semibold tabular-nums">{formatCredits(credits.balance)}</p>
      <p className="mt-1 text-sm text-zinc-500">
        {credits.balance > 0
          ? "Credits left. Each request to the AI uses some, depending on how much it reads and writes."
          : credits.freePending
            ? "Connect GitHub to get your free credits."
            : credits.freeHeld
              ? `Your ${formatCredits(credits.freeCredits)} free credits are on their way: so many people joined today that they're added within a day. Buy credits to start now.`
              : "You've used all your credits. Buy more to keep using the AI."}
        {credits.active && " The AI is working now, so this updates every few seconds."}
      </p>
      <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-xs text-zinc-500">{s.label}</dt>
            <dd className="text-lg font-medium tabular-nums">{formatCredits(s.value)}</dd>
          </div>
        ))}
      </dl>
      {credits.freePending && credits.source === "credits" && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-sky-500/10 px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-sky-900 dark:text-sky-200">
            Connect your GitHub account to get {formatCredits(credits.freeCredits)} free credits.
          </p>
          {/* Plain <a>: a full-page navigation to the Express OAuth route. */}
          <a
            href="/auth/github"
            className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
          >
            <GitHubIcon className="size-4" />
            Connect GitHub
          </a>
        </div>
      )}
      {credits.source === "own" && (
        <div className="mt-4">
          <Notice>
            The AI uses your own Anthropic API key right now, so no credits are used. Remove the key in{" "}
            <Link href={CLAUDE_SETUP_HREF} className="underline">
              Settings
            </Link>{" "}
            to use your credits.
          </Notice>
        </div>
      )}
      {credits.source === "none" && (
        <div className="mt-4">
          <Notice tone="warning">The AI isn&apos;t available right now. Your credits are kept for when it&apos;s back.</Notice>
        </div>
      )}
    </section>
  );
}

type Tab = "usage" | "purchases";

function History({ active }: { active: boolean }) {
  const [tab, setTab] = useState<Tab>("usage");
  return (
    <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">History</h2>
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: "usage", label: "Usage" },
            { value: "purchases", label: "Purchases" },
          ]}
        />
      </div>
      {tab === "usage" ? (
        <HistoryList<Usage, UsageSummary> key="usage" type="usage" live={active} render={UsageRows} renderSummary={UsageSplit} />
      ) : (
        <HistoryList<Purchase> key="purchases" type="purchases" render={PurchaseRows} />
      )}
    </section>
  );
}

/**
 * One kind of history, newest first, a page at a time. `live` reloads the first page every 5 s.
 * An item is identified by its id: a usage run's date moves on while it's still running.
 */
function HistoryList<T extends { id: string; createdAt: string }, S = never>({
  type,
  live = false,
  render: Rows,
  renderSummary: Summary,
}: {
  type: Tab;
  live?: boolean;
  render: (props: { items: T[] }) => ReactNode;
  renderSummary?: (props: { summary: S }) => ReactNode;
}) {
  const [items, setItems] = useState<T[] | null>(null);
  const [summary, setSummary] = useState<S | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const fetchPage = useCallback(
    (before?: string) => {
      const query = new URLSearchParams({ type, limit: String(PAGE), ...(before && { before }) });
      return api<{ items: T[]; more: boolean; summary?: S }>(`/api/credits/history?${query}`);
    },
    [type],
  );

  // The newest page: once, then every 5 s while Claude works so new requests appear as they're
  // charged. Older pages already shown are kept, less anything the newest page now has.
  useEffect(() => {
    let cancelled = false;
    let first = true;
    const loadNewest = () =>
      fetchPage()
        .then((page) => {
          if (cancelled) return;
          if (page.summary) setSummary(page.summary);
          setItems((old) => {
            const oldest = page.items.at(-1)?.createdAt ?? "";
            const shown = new Set(page.items.map((i) => i.id));
            return [...page.items, ...(old ?? []).filter((i) => i.createdAt < oldest && !shown.has(i.id))];
          });
          // Later reloads leave "Show older" as the pages loaded since left it.
          if (first) setMore(page.more);
          first = false;
        })
        .catch((err) => !cancelled && setError(err));
    void loadNewest();
    const timer = live ? setInterval(loadNewest, 5_000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [fetchPage, live]);

  async function showOlder() {
    const before = items?.at(-1)?.createdAt;
    if (!before) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(before);
      setItems((old) => {
        const shown = new Set((old ?? []).map((i) => i.id));
        return [...(old ?? []), ...page.items.filter((i) => !shown.has(i.id))];
      });
      setMore(page.more);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  if (!items) {
    return <div className="mt-4">{error ? <ErrorText error={error} /> : <Spinner />}</div>;
  }
  if (!items.length) {
    return (
      <p className="mt-4 text-sm text-zinc-500">{type === "usage" ? "Nothing has used your credits yet." : "You haven't bought any credits yet."}</p>
    );
  }
  return (
    <div className="mt-4">
      {Summary && summary && <Summary summary={summary} />}
      <div className="overflow-x-auto">
        <Rows items={items} />
      </div>
      <ErrorText error={error} />
      {more && (
        <Button className="mt-4" disabled={loading} onClick={showOlder}>
          {loading ? "Loading…" : "Show older"}
        </Button>
      )}
    </div>
  );
}

const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
const TD = "px-3 py-2 align-top";

/** The credits used, merged (one balance pays for everything) and split by what the work was for. */
function UsageSplit({ summary }: { summary: UsageSummary }) {
  const share = (credits: number) => (summary.credits > 0 ? `${Math.round((credits / summary.credits) * 100)}%` : "–");
  // The biggest few purposes; the rest are counted in the total.
  const top = summary.purposes.filter((p) => p.credits > 0).slice(0, 3);
  return (
    <dl className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <dt className="text-xs text-zinc-500">Credits used</dt>
        <dd className="text-lg font-medium tabular-nums">{formatCredits(summary.credits)}</dd>
        <dd className="text-xs text-zinc-500">All your sites, from one balance</dd>
      </div>
      {top.map((p) => (
        <div key={p.purpose} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <dt className="text-xs text-zinc-500">{p.purpose}</dt>
          <dd className="text-lg font-medium tabular-nums">
            {formatCredits(p.credits)} <span className="text-sm font-normal text-zinc-500">({share(p.credits)})</span>
          </dd>
          <dd className="text-xs text-zinc-500 tabular-nums">
            {tokens(p.tokensIn)} / {tokens(p.tokensOut)} tokens
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A run's credits, as one total: charged, on the account's own key, or not charged. */
function runCredits(u: Usage) {
  if (u.charged) return formatCredits(u.credits);
  return <span className="text-xs text-zinc-500">{u.ownKey ? "Own key" : "–"}</span>;
}

function UsageRows({ items }: { items: Usage[] }) {
  return (
    <table className="w-full min-w-[40rem] text-sm">
      <thead className="border-b border-zinc-200 dark:border-zinc-800">
        <tr>
          <th className={TH}>When</th>
          <th className={TH}>Site and part</th>
          <th className={TH}>What for</th>
          <th className={`${TH} text-right`}>Tokens in / out</th>
          <th className={`${TH} text-right`}>Credits</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {items.map((u) => (
          <tr key={u.id}>
            <td className={`${TD} whitespace-nowrap text-zinc-500`}>{dateFormat.format(new Date(u.createdAt))}</td>
            <td className={TD}>
              {u.part}
              {u.site && <span className="block text-xs text-zinc-500">{u.site.name ?? "A site you removed"}</span>}
            </td>
            <td className={TD}>
              {u.purpose}
              {u.pictures > 0 && (
                <span className="block text-xs text-zinc-500">
                  {u.pictures} {u.pictures === 1 ? "picture" : "pictures"} made
                </span>
              )}
            </td>
            <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
              {tokens(u.tokensIn)} / {tokens(u.tokensOut)}
            </td>
            {/* Merged: what the whole run took from the balance. */}
            <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{runCredits(u)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PurchaseRows({ items }: { items: Purchase[] }) {
  return (
    <table className="w-full min-w-lg text-sm">
      <thead className="border-b border-zinc-200 dark:border-zinc-800">
        <tr>
          <th className={TH}>When</th>
          <th className={`${TH} text-right`}>Credits</th>
          <th className={`${TH} text-right`}>Price</th>
          <th className={TH}>Payment</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {items.map((p) => (
          <tr key={p.id}>
            <td className={`${TD} whitespace-nowrap text-zinc-500`}>{dateFormat.format(new Date(p.createdAt))}</td>
            <td className={`${TD} text-right tabular-nums`}>
              +{formatCredits(p.credits)}
              {p.refundedCredits ? <span className="block text-xs text-zinc-500">−{formatCredits(p.refundedCredits)} taken back</span> : null}
            </td>
            <td className={`${TD} text-right tabular-nums`}>{p.provider === "demo" ? "—" : money(p.priceCents, p.currency)}</td>
            <td className={TD}>
              {p.provider === "demo" ? "Demo (nothing paid)" : (PURCHASE_STATUS[p.status] ?? p.status)}
              {p.receiptUrl && (
                <a href={p.receiptUrl} target="_blank" rel="noreferrer" className="ml-2 text-xs underline-offset-2 hover:underline">
                  Receipt
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
