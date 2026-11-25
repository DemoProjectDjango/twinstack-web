"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BUY_CREDITS_HREF } from "@/lib/claude";
import { confirmModal } from "@/lib/confirm";
import { api, workspacePath } from "@/lib/site-api";
import type { AgentGoal, AgentHistory, AgentOutcome, AgentSession, AgentSettings, AgentTone, AgentView } from "@/lib/site-agent";
import { toast } from "@/lib/toast";
import { useSite } from "./site-context";
import { Button, EmptyState, ErrorText, Field, Notice, ScreenHeader, Section, Segmented, Spinner, inputClass } from "./ui";

// The site agent, for the site's creator only (server/src/site-agent.js): a chat helper in the
// corner of the published site. The owner turns it on (it goes into site.config.json and out with
// the next publish), names it, picks its greeting and tone, lists the pages it should steer
// visitors to (goals), caps what it may spend a day, and sees what it suggested to each anonymous
// visitor and whether they took it up.

const TONES: { value: AgentTone; label: string }[] = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "playful", label: "Playful" },
  { value: "calm", label: "Calm" },
];

type Range = "1" | "7" | "30" | "90";
const RANGES: { value: Range; label: string }[] = [
  { value: "1", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

const OUTCOMES: Record<AgentOutcome, { label: string; tone: string }> = {
  accepted: { label: "Accepted", tone: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  dismissed: { label: "Dismissed", tone: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
  ignored: { label: "Ignored", tone: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" },
  pending: { label: "Waiting", tone: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
};

const TRIGGERS: Record<string, string> = {
  "goal-hover": "Lingered over a goal",
  "repeat-clicks": "Clicked around",
  leaving: "About to leave",
  browsing: "Browsing without a goal",
  reading: "Reading for a while",
};

const MAX_GOALS = 6;
const number = new Intl.NumberFormat();
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return relative.format(-hours, "hour");
  return relative.format(-Math.round(hours / 24), "day");
}

/** Dollars for an amount of credits (1 credit = $0.0001), as owners read prices. */
const dollars = (credits: number) => `$${(credits / 10_000).toFixed(credits < 1000 ? 3 : 2)}`;

/** The start of the owner's day `days - 1` days ago, and now: the history's period. */
function period(range: Range) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (Number(range) - 1));
  return { from: start.toISOString(), to: new Date().toISOString() };
}

const same = (a: AgentSettings, b: AgentSettings) => JSON.stringify(a) === JSON.stringify(b);

export function SiteAgentPanel() {
  const { owner, repo, status, refresh, showSection, busy } = useSite();
  const [view, setView] = useState<AgentView | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [historyTick, setHistoryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<AgentView>(workspacePath(owner, repo, "/agent"))
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setDraft(next.settings);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  async function act(name: string, path: string, method: "POST" | "PUT", body: unknown, done: string) {
    setWorking(name);
    setError(null);
    try {
      const next = await api<AgentView>(workspacePath(owner, repo, `/agent${path}`), { method, body });
      setView(next);
      setDraft(next.settings);
      // Turning it on or off, or a new name or greeting while on, changes site.config.json.
      await refresh();
      toast.success(done);
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  async function turnOff() {
    const ok = await confirmModal(
      "Turn the site agent off? It stops suggesting and answering straight away, and is taken off your site the next time you publish. Its history is kept until you delete it.",
      { confirmLabel: "Turn off" },
    );
    if (ok) await act("disable", "/disable", "POST", {}, "The site agent is off.");
  }

  const unpublished = status.changes.some((c) => c.path === "site.config.json");
  const dirty = Boolean(view && draft && !same(view.settings, draft));
  const locked = busy || working !== null;

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Site agent"
        description="A helper in the corner of your published site. It notices what visitors seem to look for, suggests where to go, and answers their questions from your pages. Only you can see this screen."
      />
      <ErrorText error={error} />
      {!view && !error && (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner /> Loading your site agent…
        </p>
      )}

      {view && !view.supported && !view.enabled && (
        <Notice tone="warning">
          Your site needs the latest site update before it can have a site agent.{" "}
          <button type="button" className="font-medium underline" onClick={() => showSection("home")}>
            Go to Edit site to update it
          </button>
        </Notice>
      )}

      {view && view.supported && !view.enabled && (
        <EmptyState
          title="Add a site agent"
          action={
            <Button variant="primary" disabled={locked} onClick={() => void act("enable", "/enable", "POST", {}, "The site agent is on. Publish your site to put it live.")}>
              {working === "enable" ? "Turning on…" : "Turn on the site agent"}
            </Button>
          }
        >
          A chat button appears in the corner of your site. When a visitor seems to be looking for something, like lingering over Donate, it offers to take
          them there, and it answers questions from your pages. Each suggestion and answer uses a little of your AI credits, within a daily limit you set.
        </EmptyState>
      )}

      {view?.enabled && <StatusCard view={view} unpublished={unpublished} locked={locked} working={working} onUpdate={() => void act("enable", "/enable", "POST", {}, "Site agent updated. Publish your site to use it.")} onPublish={() => showSection("publish")} onTurnOff={() => void turnOff()} />}

      {view && draft && (view.enabled || view.supported) && (
        <>
          <SettingsForm draft={draft} setDraft={setDraft} />
          <GoalsForm view={view} goals={draft.goals} onChange={(goals) => setDraft({ ...draft, goals })} />
          <SpendingForm view={view} value={draft.dailyCredits} onChange={(dailyCredits) => setDraft({ ...draft, dailyCredits })} />
          <div className="sticky bottom-2 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-background/95 px-4 py-3 shadow-sm backdrop-blur dark:border-zinc-800">
            <Button variant="primary" disabled={!dirty || locked} onClick={() => void act("save", "/settings", "PUT", draft, view.enabled ? "Saved. Goals and tone work straight away; publish to update the name and greeting." : "Saved.")}>
              {working === "save" ? "Saving…" : "Save changes"}
            </Button>
            {dirty && (
              <Button variant="ghost" disabled={locked} onClick={() => setDraft(view.settings)}>
                Undo changes
              </Button>
            )}
            <span className="text-sm text-zinc-500">{dirty ? "You have unsaved changes." : "Everything is saved."}</span>
          </div>
        </>
      )}

      {view && (view.enabled || view.lastActivityAt) && <HistorySection owner={owner} repo={repo} view={view} tick={historyTick} onDeleted={() => setHistoryTick((t) => t + 1)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ status */

function StatusCard({
  view,
  unpublished,
  locked,
  working,
  onUpdate,
  onPublish,
  onTurnOff,
}: {
  view: AgentView;
  unpublished: boolean;
  locked: boolean;
  working: string | null;
  onUpdate: () => void;
  onPublish: () => void;
  onTurnOff: () => void;
}) {
  const state = !view.configured ? "update" : unpublished ? "unpublished" : "live";
  const pill = {
    live: { label: "Live", tone: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
    unpublished: { label: "Not published yet", tone: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" },
    update: { label: "Needs updating", tone: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" },
  }[state];
  const cap = view.settings.dailyCredits;
  const used = view.usage.creditsLast24h;
  return (
    <Section title="Status" description="Whether visitors see the agent, and what it has spent.">
      <div className="space-y-3 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${pill.tone}`}>{pill.label}</span>
          {state === "live" && (
            <span className="text-zinc-600 dark:text-zinc-400">
              {view.lastActivityAt ? `Last visitor activity ${ago(view.lastActivityAt)}.` : "Waiting for the first visitor."}
              {view.siteUrl && (
                <>
                  {" "}
                  <a href={view.siteUrl} target="_blank" rel="noreferrer" className="font-medium underline">
                    Open your site
                  </a>
                </>
              )}
            </span>
          )}
          {state === "unpublished" && (
            <span className="text-zinc-600 dark:text-zinc-400">
              Publish your site to put the agent live.{" "}
              <button type="button" className="font-medium underline" onClick={onPublish}>
                Go to Publish
              </button>
            </span>
          )}
          {state === "update" && (
            <span className="text-zinc-600 dark:text-zinc-400">
              Your site&apos;s settings don&apos;t have the agent as it is now.{" "}
              <button type="button" className="font-medium underline" disabled={locked} onClick={onUpdate}>
                {working === "enable" ? "Updating…" : "Update the agent"}
              </button>
            </span>
          )}
        </p>
        {view.localEndpoint && (
          <Notice tone="warning">
            This Twinstack server isn&apos;t set up to receive visitors&apos; messages from the internet yet (PUBLIC_API_URL), so the agent on your published
            site can&apos;t reach it. Let the person who runs Twinstack know.
          </Notice>
        )}
        {!view.canAnswer && (
          <Notice tone="warning">
            {view.usage.balance <= 0 ? (
              <>
                You&apos;re out of AI credits, so the agent stays quiet: it makes no suggestions and tells visitors it can&apos;t answer right now.{" "}
                <Link href={BUY_CREDITS_HREF} className="font-medium underline">
                  Add credits
                </Link>
              </>
            ) : (
              "The AI isn't available right now, so the agent stays quiet until it is."
            )}
          </Notice>
        )}
        {used >= cap && (
          <Notice tone="warning">The agent reached its daily limit, so it stays quiet until some of the last 24 hours&apos; spending drops off. You can raise the limit below.</Notice>
        )}
        <p className="text-zinc-600 dark:text-zinc-400">
          Used in the last 24 hours: <strong className="tabular-nums">{number.format(used)}</strong> of {number.format(cap)} credits ({dollars(used)} of {dollars(cap)}).
        </p>
        <div className="pt-1">
          <Button disabled={locked} onClick={onTurnOff}>
            {working === "disable" ? "Turning off…" : "Turn off the site agent"}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ settings */

function SettingsForm({ draft, setDraft }: { draft: AgentSettings; setDraft: (next: AgentSettings) => void }) {
  return (
    <Section title="How it talks" description="Visitors see the name and greeting once you publish. The tone shapes every suggestion and answer straight away.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input className={inputClass} value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Site helper" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Greeting" hint="The first thing visitors read when they open the chat.">
            <textarea className={inputClass} rows={2} maxLength={200} value={draft.greeting} onChange={(e) => setDraft({ ...draft, greeting: e.target.value })} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Tone</span>
          <Segmented label="Tone" value={draft.tone} options={TONES} onChange={(tone) => setDraft({ ...draft, tone })} />
        </div>
      </div>
    </Section>
  );
}

function GoalsForm({ view, goals, onChange }: { view: AgentView; goals: AgentGoal[]; onChange: (goals: AgentGoal[]) => void }) {
  const titleOf = useMemo(() => new Map(view.pages.map((p) => [p.url, p.title])), [view.pages]);
  const unused = view.pages.filter((p) => !goals.some((g) => g.path === p.url));
  const update = (i: number, change: Partial<AgentGoal>) => onChange(goals.map((g, j) => (j === i ? { ...g, ...change } : g)));
  const add = (path = "") => onChange([...goals, { label: path ? (titleOf.get(path) ?? "") : "", path, note: "" }]);
  // Pages that look like something to steer visitors to, offered with one click.
  const likely = unused.filter((p) => /donat|give|support|contact|book|appointment|shop|buy|order|pricing|price|quote|join|member|volunteer|sign.?up|register|enrol|demo|trial/i.test(`${p.title} ${p.url}`)).slice(0, 5);

  return (
    <Section title="Where it should steer visitors" description="Your goals, most important first. When a visitor seems interested in one, the agent offers to take them there. It only ever links to pages on your site.">
      <div className="space-y-3">
        {goals.length === 0 && <p className="text-sm text-zinc-500">No goals yet. Without them the agent still answers questions and points visitors to helpful pages.</p>}
        {goals.map((goal, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-zinc-200 p-3 sm:grid-cols-[1fr_1fr_auto] dark:border-zinc-800">
            <Field label={`Goal ${i + 1}`}>
              <input className={inputClass} value={goal.label} maxLength={40} placeholder="Donate" onChange={(e) => update(i, { label: e.target.value })} />
            </Field>
            <Field label="Page">
              <select className={inputClass} value={goal.path} onChange={(e) => update(i, { path: e.target.value, label: goal.label || (titleOf.get(e.target.value) ?? "") })}>
                <option value="">Choose a page…</option>
                {goal.path && !titleOf.has(goal.path) && <option value={goal.path}>{goal.path} (not on your site any more)</option>}
                {view.pages.map((p) => (
                  <option key={p.url} value={p.url} disabled={p.url !== goal.path && goals.some((g) => g.path === p.url)}>
                    {p.title} ({p.url})
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end gap-1">
              <Button variant="ghost" aria-label={`Move goal ${i + 1} up`} disabled={i === 0} onClick={() => onChange(goals.map((g, j) => (j === i - 1 ? goals[i] : j === i ? goals[i - 1] : g)))}>
                ↑
              </Button>
              <Button variant="ghost" aria-label={`Remove goal ${i + 1}`} onClick={() => onChange(goals.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
            <div className="sm:col-span-3">
              <Field label="Note for the agent (optional)">
                <input className={inputClass} value={goal.note} maxLength={160} placeholder="e.g. Monthly giving helps us most" onChange={(e) => update(i, { note: e.target.value })} />
              </Field>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={goals.length >= MAX_GOALS || unused.length === 0} onClick={() => add()}>
            Add a goal
          </Button>
          {goals.length < MAX_GOALS &&
            likely.map((p) => (
              <button
                key={p.url}
                type="button"
                onClick={() => add(p.url)}
                className="rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                + {p.title}
              </button>
            ))}
        </div>
      </div>
    </Section>
  );
}

function SpendingForm({ view, value, onChange }: { view: AgentView; value: number; onChange: (value: number) => void }) {
  const { min, max } = view.limits.dailyCredits;
  return (
    <Section
      title="Daily spending limit"
      description={`Suggestions and answers are paid from your AI credits. The agent never spends more than this in any 24 hours, makes at most ${view.limits.suggestionsPerSession} suggestions per visit and answers at most ${view.limits.questionsPerSession} questions per visit.`}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Credits per day" hint={`Between ${number.format(min)} and ${number.format(max)}. ${number.format(value || 0)} credits is about ${dollars(value || 0)}.`}>
          <input
            type="number"
            inputMode="numeric"
            className={`${inputClass} w-40`}
            min={min}
            max={max}
            step={100}
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? NaN : Math.round(Number(e.target.value)))}
          />
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ history */

function HistorySection({ owner, repo, view, tick, onDeleted }: { owner: string; repo: string; view: AgentView; tick: number; onDeleted: () => void }) {
  const [range, setRange] = useState<Range>("30");
  const [history, setHistory] = useState<AgentHistory | null>(null);
  const [more, setMore] = useState<AgentSession[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [span, setSpan] = useState(() => period("30"));

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams(span);
    api<AgentHistory>(workspacePath(owner, repo, `/agent/history?${q}`))
      .then((h) => {
        if (cancelled) return;
        setHistory(h);
        setMore([]);
        setNext(h.next);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, span, tick]);

  function choose(nextRange: Range) {
    setRange(nextRange);
    setLoading(true);
    setSpan(period(nextRange));
  }

  async function loadMore() {
    if (!next) return;
    setLoading(true);
    try {
      const h = await api<AgentHistory>(workspacePath(owner, repo, `/agent/history?${new URLSearchParams({ ...span, before: next })}`));
      setMore((m) => [...m, ...h.sessions]);
      setNext(h.next);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  async function deleteHistory() {
    const ok = await confirmModal("Delete the site agent's whole history (every visit, suggestion and question)? This can't be undone.", {
      confirmLabel: "Delete history",
      danger: true,
      title: "Delete history",
    });
    if (!ok) return;
    try {
      await api(workspacePath(owner, repo, "/agent/data"), { method: "DELETE", body: {} });
      toast.success("History deleted.");
      onDeleted();
    } catch (err) {
      setError(err);
    }
  }

  const totals = history?.totals;
  const sessions = [...(history?.sessions ?? []), ...more];
  const pageTitle = (path: string) => view.pages.find((p) => p.url === path || p.url.replace(/\.html$/, "") === path.replace(/\.html$/, ""))?.title ?? path;

  return (
    <section className="space-y-4" aria-labelledby="agent-history">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="agent-history" className="font-semibold">
            History
          </h3>
          <p className="text-sm text-zinc-500">What the agent suggested to each visitor and what they did. Visitors are anonymous; visits are kept {view.retentionDays} days.</p>
        </div>
        <span className="flex items-center gap-2">
          {loading && <Spinner />}
          <Segmented label="Period" value={range} options={RANGES} onChange={choose} />
        </span>
      </div>
      <ErrorText error={error} />

      {totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Visits with the agent" value={number.format(totals.sessions)} />
          <Stat label="Suggestions shown" value={number.format(totals.shown)} />
          <Stat label="Accepted" value={totals.acceptance === null ? "–" : `${Math.round(totals.acceptance * 100)}%`} note={`${number.format(totals.accepted)} clicked`} />
          <Stat label="Dismissed / ignored" value={`${number.format(totals.dismissed)} / ${number.format(totals.ignored)}`} />
          <Stat label="Questions asked" value={number.format(totals.questions)} />
          <Stat label="Credits used" value={number.format(totals.credits)} note={dollars(totals.credits)} />
        </div>
      )}

      {history && sessions.length === 0 && (
        <EmptyState title="Nothing in this period yet">Suggestions and questions show here as visitors use your published site.</EmptyState>
      )}

      <ol className="space-y-3">
        {sessions.map((s) => (
          <SessionCard key={`${s.id}-${s.startedAt}`} session={s} pageTitle={pageTitle} />
        ))}
      </ol>
      {next && (
        <Button disabled={loading} onClick={() => void loadMore()}>
          {loading ? "Loading…" : "Show older visits"}
        </Button>
      )}
      {history && (sessions.length > 0 || view.lastActivityAt) && (
        <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <Button variant="danger" onClick={() => void deleteHistory()}>
            Delete history
          </Button>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-zinc-500">{note}</p>}
    </div>
  );
}

function SessionCard({ session, pageTitle }: { session: AgentSession; pageTitle: (path: string) => string }) {
  const items: { at: string; node: ReactNode }[] = [
    ...session.suggestions.map((s) => ({
      at: s.at,
      node: (
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="tabular-nums">{clock(s.at)}</span>
            <span>on {pageTitle(s.path)}</span>
            <span aria-hidden="true">·</span>
            <span>{TRIGGERS[s.trigger] ?? "Suggestion"}</span>
          </p>
          <p className="text-sm">“{s.text}”</p>
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">
              → {s.label} ({pageTitle(s.target)})
            </span>
            <span className={`rounded-full px-2 py-0.5 font-semibold ${OUTCOMES[s.outcome].tone}`}>{OUTCOMES[s.outcome].label}</span>
            {s.reached && <span className="rounded-full bg-green-50 px-2 py-0.5 text-green-800 dark:bg-green-950 dark:text-green-300">Reached the page</span>}
          </p>
        </div>
      ),
    })),
    ...session.questions.map((q) => ({
      at: q.at,
      node: (
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="tabular-nums">{clock(q.at)}</span>
            <span>on {pageTitle(q.path)}</span>
            <span aria-hidden="true">·</span>
            <span>Question</span>
          </p>
          <p className="text-sm font-medium">{q.question}</p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {q.answer ?? <span className="italic">Not answered (limit reached or the AI was unavailable).</span>}
            {q.target && <span className="text-zinc-500"> → {pageTitle(q.target)}</span>}
          </p>
        </div>
      ),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <li className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">Visitor {session.id}</span>
        <span className="text-zinc-500">
          {session.device} · {session.pages.length} {session.pages.length === 1 ? "page" : "pages"} · {time(session.startedAt)}
        </span>
      </p>
      <ul className="space-y-3 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
        {items.map((item, i) => (
          <li key={i}>{item.node}</li>
        ))}
      </ul>
    </li>
  );
}
