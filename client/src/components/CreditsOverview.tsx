"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { CLAUDE_SETUP_HREF } from "@/lib/claude";
import { type Credits, creditsValue, formatCredits, useCredits, useCreditsFailed } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { BuyCredits } from "./BuyCredits";
import { Button, ErrorText, Notice, Segmented, Spinner } from "./site/ui";

type Usage = {
  id: string;
  kind: string;
  command: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches?: number;
  credits?: number;
  charged?: boolean;
  createdAt: string;
};

type Purchase = { id: string; credits: number; priceCents: number; currency: string; provider: string; status: string; createdAt: string };

const PAGE = 25;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const COMMAND_LABELS: Record<string, string> = {
  "page-edit": "Changing a page",
  "page-generate": "Writing a page",
  "page-convert": "Bringing in a web page",
  "chrome-design": "Designing the header and footer",
  "md-edit": "Editing a file",
  "seo-claude": "Writing search text",
  scaffold: "Creating pages",
  schedule: "Scheduled pages",
};

function usageLabel(u: Usage) {
  if (u.kind === "assistant") return "Ask Claude";
  if (u.kind === "site-update") return "Updating your site";
  return (u.command && COMMAND_LABELS[u.command]) ?? "Claude command";
}

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-fable-5-1": "Fable 5.1",
};

const tokens = (n: number) => formatCredits(n);

/** Balance, buying credits, and the history of Claude requests and purchases. */
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
            {formatCredits(credits.purchase.step)} credits are worth {creditsValue(credits.purchase.step, credits.creditsPerDollar)} of Claude use.
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
          ? `About ${creditsValue(credits.balance, credits.creditsPerDollar)} of Claude use left.`
          : "You've used all your credits. Buy more to keep using Claude."}
        {credits.active && " Claude is working now, so this updates every few seconds."}
      </p>
      <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-xs text-zinc-500">{s.label}</dt>
            <dd className="text-lg font-medium tabular-nums">{formatCredits(s.value)}</dd>
          </div>
        ))}
      </dl>
      {credits.source === "own" && (
        <div className="mt-4">
          <Notice>
            Claude uses your own Anthropic API key right now, so no credits are used. Remove the key in{" "}
            <Link href={CLAUDE_SETUP_HREF} className="underline">
              Settings
            </Link>{" "}
            to use your credits.
          </Notice>
        </div>
      )}
      {credits.source === "none" && (
        <div className="mt-4">
          <Notice tone="warning">Claude isn&apos;t available right now. Your credits are kept for when it&apos;s back.</Notice>
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
            { value: "usage", label: "Claude use" },
            { value: "purchases", label: "Purchases" },
          ]}
        />
      </div>
      {tab === "usage" ? <HistoryList<Usage> key="usage" type="usage" live={active} render={UsageRows} /> : <HistoryList<Purchase> key="purchases" type="purchases" render={PurchaseRows} />}
    </section>
  );
}

/** One kind of history, newest first, a page at a time. `live` reloads the first page every 5 s. */
function HistoryList<T extends { id: string; createdAt: string }>({
  type,
  live = false,
  render: Rows,
}: {
  type: Tab;
  live?: boolean;
  render: (props: { items: T[] }) => ReactNode;
}) {
  const [items, setItems] = useState<T[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const fetchPage = useCallback(
    (before?: string) => {
      const query = new URLSearchParams({ type, limit: String(PAGE), ...(before && { before }) });
      return api<{ items: T[]; more: boolean }>(`/api/credits/history?${query}`);
    },
    [type],
  );

  // The newest page: once, then every 5 s while Claude works so new requests appear as they're
  // charged. Older pages already shown are kept.
  useEffect(() => {
    let cancelled = false;
    let first = true;
    const loadNewest = () =>
      fetchPage()
        .then((page) => {
          if (cancelled) return;
          setItems((old) => {
            const oldest = page.items.at(-1)?.createdAt ?? "";
            return [...page.items, ...(old ?? []).filter((i) => i.createdAt < oldest)];
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
      setItems((old) => [...(old ?? []), ...page.items]);
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
      <p className="mt-4 text-sm text-zinc-500">{type === "usage" ? "Claude hasn't done anything for you yet." : "You haven't bought any credits yet."}</p>
    );
  }
  return (
    <div className="mt-4">
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

function UsageRows({ items }: { items: Usage[] }) {
  return (
    <table className="w-full min-w-[36rem] text-sm">
      <thead className="border-b border-zinc-200 dark:border-zinc-800">
        <tr>
          <th className={TH}>When</th>
          <th className={TH}>What</th>
          <th className={`${TH} text-right`}>Tokens in / out</th>
          <th className={`${TH} text-right`}>Credits</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {items.map((u) => {
          const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
          return (
            <tr key={u.id}>
              <td className={`${TD} whitespace-nowrap text-zinc-500`}>{dateFormat.format(new Date(u.createdAt))}</td>
              <td className={TD}>
                {usageLabel(u)}
                {u.model && <span className="block text-xs text-zinc-500">{MODEL_NAMES[u.model] ?? u.model}</span>}
              </td>
              <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                {tokens(input)} / {tokens(u.outputTokens)}
              </td>
              <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                {u.charged ? formatCredits(u.credits ?? 0) : <span className="text-xs text-zinc-500">{u.charged === false && u.credits !== undefined ? "Own key" : "–"}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PurchaseRows({ items }: { items: Purchase[] }) {
  return (
    <table className="w-full min-w-[28rem] text-sm">
      <thead className="border-b border-zinc-200 dark:border-zinc-800">
        <tr>
          <th className={TH}>When</th>
          <th className={`${TH} text-right`}>Credits</th>
          <th className={TH}>Payment</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {items.map((p) => (
          <tr key={p.id}>
            <td className={`${TD} whitespace-nowrap text-zinc-500`}>{dateFormat.format(new Date(p.createdAt))}</td>
            <td className={`${TD} text-right tabular-nums`}>+{formatCredits(p.credits)}</td>
            <td className={TD}>{p.provider === "demo" ? "Demo (nothing paid)" : p.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
