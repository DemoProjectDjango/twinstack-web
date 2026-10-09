"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { CLAUDE_SETUP_HREF } from "@/lib/claude";
import { type Credits, creditsValue, formatCredits, useCredits, useCreditsFailed } from "@/lib/credits";
import { api } from "@/lib/site-api";
import { BuyCredits } from "./BuyCredits";
import { Button, ErrorText, Notice, Segmented, Spinner } from "./site/ui";

type Provider = "claude" | "deepseek";

type Tokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/** One model's part of a run. */
type ModelUse = Tokens & { model: string; provider: Provider; requests: number; credits: number };

/** One run (a Claude command, an Ask Claude answer, a site update): its credits merged, split by model. */
type Usage = {
  id: string;
  kind: string;
  command: string | null;
  charged: boolean;
  ownKey: boolean;
  credits: number;
  models: ModelUse[];
  createdAt: string;
};

/** The credits used, merged (`credits`) and split by provider. */
type UsageSummary = { credits: number; providers: Record<Provider, Tokens & { requests: number; credits: number }> };

const PROVIDER_NAMES: Record<Provider, string> = { claude: "Claude", deepseek: "DeepSeek" };

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
  // Work-log summaries.
  "claude-haiku-4-5": "Haiku 4.5",
  // Routine page work on a site that already has a design (the server's TWINSTACK_FAST_MODEL).
  "deepseek-flash": "DeepSeek Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
};

/** A model's display name; replies name dated snapshots (claude-haiku-4-5-20251001), shown as their alias. */
const modelName = (model: string) => MODEL_NAMES[model] ?? MODEL_NAMES[model.replace(/-\d{8}$/, "")] ?? model;

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

const inputOf = (t: Tokens) => t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/** The credits used, merged (one balance pays for both) and split between Claude and DeepSeek. */
function UsageSplit({ summary }: { summary: UsageSummary }) {
  const share = (credits: number) => (summary.credits > 0 ? `${Math.round((credits / summary.credits) * 100)}%` : "–");
  return (
    <dl className="mb-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <dt className="text-xs text-zinc-500">Credits used</dt>
        <dd className="text-lg font-medium tabular-nums">{formatCredits(summary.credits)}</dd>
        <dd className="text-xs text-zinc-500">Claude and DeepSeek, from one balance</dd>
      </div>
      {(Object.keys(PROVIDER_NAMES) as Provider[]).map((p) => {
        const use = summary.providers[p];
        return (
          <div key={p} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-500">{PROVIDER_NAMES[p]}</dt>
            <dd className="text-lg font-medium tabular-nums">
              {formatCredits(use.credits)} <span className="text-sm font-normal text-zinc-500">({share(use.credits)})</span>
            </dd>
            <dd className="text-xs text-zinc-500 tabular-nums">
              {formatCredits(use.requests)} {use.requests === 1 ? "request" : "requests"} · {tokens(inputOf(use))} / {tokens(use.outputTokens)} tokens
            </dd>
          </div>
        );
      })}
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
          const split = u.models.length > 1;
          return (
            <tr key={u.id}>
              <td className={`${TD} whitespace-nowrap text-zinc-500`}>{dateFormat.format(new Date(u.createdAt))}</td>
              <td className={TD}>
                {usageLabel(u)}
                {/* The split: each model's part of this run, with its own credits when there's more than one. */}
                {u.models.map((m) => (
                  <span key={m.model} className="block text-xs text-zinc-500">
                    {modelName(m.model)}
                    {m.requests > 1 && ` · ${m.requests} requests`}
                    {split && u.charged && ` · ${formatCredits(m.credits)} credits`}
                  </span>
                ))}
              </td>
              <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                {u.models.map((m) => (
                  <span key={m.model} className={`block ${split ? "text-xs text-zinc-500" : ""}`}>
                    {tokens(inputOf(m))} / {tokens(m.outputTokens)}
                  </span>
                ))}
              </td>
              {/* Merged: what the whole run took from the balance. */}
              <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{runCredits(u)}</td>
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
