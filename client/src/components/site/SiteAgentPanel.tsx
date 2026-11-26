"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BUY_CREDITS_HREF } from "@/lib/claude";
import { confirmModal } from "@/lib/confirm";
import { readAsBase64 } from "@/lib/setup";
import { api, workspacePath } from "@/lib/site-api";
import type { AgentCost, AgentGoal, AgentHistory, AgentIcon, AgentOutcome, AgentPace, AgentSession, AgentSettings, AgentTone, AgentView } from "@/lib/site-agent";
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
  "link-hover": "Lingered over a link",
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

  /** Turns the agent on, saving first whatever the owner already set below (goals, tone…), so nothing is lost. */
  async function turnOn() {
    setWorking("enable");
    setError(null);
    try {
      if (dirty && draft) await api<AgentView>(workspacePath(owner, repo, "/agent/settings"), { method: "PUT", body: draft });
      const next = await api<AgentView>(workspacePath(owner, repo, "/agent/enable"), { method: "POST", body: {} });
      setView(next);
      setDraft(next.settings);
      await refresh();
      toast.success("The site agent is on. Publish your site to put it live.");
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
            <Button variant="primary" disabled={locked} onClick={() => void turnOn()}>
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
          <LookForm view={view} draft={draft} setDraft={setDraft} owner={owner} repo={repo} />
          <KnowledgeForm view={view} draft={draft} setDraft={setDraft} working={working === "reread"} onReread={() => void act("reread", "/reread", "POST", {}, "Read your site again.")} />
          <PaceForm view={view} draft={draft} setDraft={setDraft} />
          <RememberForm view={view} draft={draft} setDraft={setDraft} />
          <SpendingForm view={view} value={draft.dailyCredits} onChange={(dailyCredits) => setDraft({ ...draft, dailyCredits })} />
          <div
            className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${
              dirty ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40" : "border-zinc-200 dark:border-zinc-800"
            }`}
          >
            <Button variant="primary" disabled={!dirty || locked} onClick={() => void act("save", "/settings", "PUT", draft, view.enabled ? "Saved. Goals, tone and how quickly it speaks up work straight away; publish your site to show the new name, greeting and look." : "Saved.")}>
              {working === "save" ? "Saving…" : "Save changes"}
            </Button>
            {dirty && (
              <Button variant="ghost" disabled={locked} onClick={() => setDraft(view.settings)}>
                Undo changes
              </Button>
            )}
            <span className={`text-sm ${dirty ? "font-medium text-amber-900 dark:text-amber-200" : "text-zinc-500"}`}>
              {dirty ? (view.enabled ? "You have unsaved changes: press Save changes." : "Your choices are kept when you turn the agent on.") : "Everything is saved."}
            </span>
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

// The same drawings as the template's assets/js/agent.js.
const ICON_PATHS: Record<Exclude<AgentIcon, "logo" | "image">, ReactNode> = {
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />,
  sparkle: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
      <path d="M12 17h.01" />
    </>
  ),
  wave: (
    <>
      <path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M10 10.5v-6a1.5 1.5 0 0 1 3 0v6" />
      <path d="M13 10.5v-5a1.5 1.5 0 0 1 3 0V13" />
      <path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a7 7 0 0 1-5.6-2.8L3.6 15a1.6 1.6 0 0 1 2.4-2.1L7 14" />
    </>
  ),
  heart: <path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z" />,
};
const ICON_NAMES: Record<AgentIcon, string> = { chat: "Chat", sparkle: "Sparkle", question: "Question", wave: "Wave", heart: "Heart", logo: "Your logo", image: "Your picture" };
const SWATCHES = ["#18181b", "#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0d9488", "#db2777"];

function AgentIconSvg({ icon, className, picture }: { icon: AgentIcon; className?: string; picture?: string | null }) {
  if (icon === "image")
    return picture ? (
      // eslint-disable-next-line @next/next/no-img-element -- a data: URL preview
      <img src={picture} alt="" className={`rounded-full object-cover ${className ?? ""}`} />
    ) : (
      <span className={`grid place-items-center rounded-full bg-white text-[9px] font-bold text-zinc-900 ${className ?? ""}`} aria-hidden="true">
        +
      </span>
    );
  if (icon === "logo")
    return (
      <span className={`grid place-items-center rounded-full bg-white text-[9px] font-bold text-zinc-900 ${className ?? ""}`} aria-hidden="true">
        logo
      </span>
    );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {ICON_PATHS[icon]}
    </svg>
  );
}

/** Black or white text on the button colour, as agent.js picks it. */
function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

function LookForm({ view, draft, setDraft, owner, repo }: { view: AgentView; draft: AgentSettings; setDraft: (d: AgentSettings) => void; owner: string; repo: string }) {
  const [picture, setPicture] = useState<string | null>(view.iconPreview);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  async function upload(file: File) {
    setUploadError(null);
    if (file.size > 2 * 1024 * 1024) {
      setUploadError(new Error(`${file.name} is over 2 MB. A button picture rarely needs more than 200 KB.`));
      return;
    }
    setUploading(true);
    try {
      const result = await api<{ path: string; preview: string | null }>(workspacePath(owner, repo, "/brand/image"), {
        method: "POST",
        body: { name: `agent-${file.name}`, data: await readAsBase64(file) },
      });
      setPicture(result.preview);
      setDraft({ ...draft, icon: "image", iconImage: result.path });
    } catch (err) {
      setUploadError(err);
    } finally {
      setUploading(false);
    }
  }
  const colour = draft.color || "#18181b";
  const ink = inkFor(colour);
  const left = draft.position === "left";
  return (
    <Section title="How it looks" description="The chat button and its bubbles on your site. Publish your site to show a new look to visitors.">
      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,18rem)]">
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-medium">Colour</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setDraft({ ...draft, color: "" })}
                className={`rounded-full border px-3 py-1 text-sm ${draft.color === "" ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100" : "border-zinc-300 dark:border-zinc-700"}`}
              >
                Your site&apos;s colour
              </button>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  onClick={() => setDraft({ ...draft, color: c })}
                  className={`size-7 rounded-full border border-black/10 ${draft.color === c ? "ring-2 ring-offset-2 ring-zinc-900 dark:ring-zinc-100 dark:ring-offset-zinc-950" : ""}`}
                  style={{ background: c }}
                />
              ))}
              <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <input type="color" className="h-7 w-9 cursor-pointer rounded border border-zinc-300 bg-transparent dark:border-zinc-700" value={colour} onChange={(e) => setDraft({ ...draft, color: e.target.value.toLowerCase() })} />
                Any colour
              </label>
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Icon</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Icon">
              {view.icons.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  role="radio"
                  aria-checked={draft.icon === icon}
                  onClick={() => setDraft({ ...draft, icon })}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${draft.icon === icon ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"}`}
                >
                  <span className="grid size-7 place-items-center overflow-hidden rounded-full" style={{ background: colour, color: ink }}>
                    <AgentIconSvg icon={icon} picture={picture} className={icon === "image" && picture ? "size-7" : "size-4"} />
                  </span>
                  {ICON_NAMES[icon]}
                </button>
              ))}
            </div>
            {draft.icon === "logo" && <p className="mt-2 text-xs text-zinc-500">Uses the square logo from Look &amp; logo. Without one, visitors see the chat icon.</p>}
            {draft.icon === "image" && (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                <label className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                  {uploading ? "Uploading…" : draft.iconImage ? "Choose another picture" : "Upload a picture"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    className="sr-only"
                    disabled={uploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void upload(file);
                    }}
                  />
                </label>
                <span className="text-xs text-zinc-500">A square picture works best: your logo, a mascot or a friendly face. It fills the round button. PNG, JPEG, WebP or SVG, up to 2 MB.</span>
                {uploadError ? <ErrorText error={uploadError} /> : null}
              </div>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Text on the button" hint="Optional, like “Ask us” or “Need help?”. Leave empty for the icon alone.">
              <input className={inputClass} maxLength={24} value={draft.label} placeholder="Icon only" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </Field>
            <div>
              <p className="mb-2 text-sm font-medium">Corner</p>
              <Segmented
                label="Corner"
                value={draft.position}
                onChange={(position) => setDraft({ ...draft, position })}
                options={[
                  { value: "left", label: "Bottom left" },
                  { value: "right", label: "Bottom right" },
                ]}
              />
            </div>
          </div>
        </div>
        <div aria-label="Preview" className="relative h-72 overflow-hidden rounded-xl border border-zinc-200 bg-gradient-to-b from-zinc-50 to-zinc-100 dark:border-zinc-800 dark:from-zinc-900 dark:to-zinc-950">
          <div className="space-y-2 p-4" aria-hidden="true">
            <div className="h-3 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-3 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-3 w-3/5 rounded bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className={`absolute bottom-3 flex flex-col gap-2 ${left ? "left-3 items-start" : "right-3 items-end"}`}>
            {draft.greet && (
              <div className="w-56 rounded-2xl border border-black/5 bg-white p-3 text-sm text-zinc-900 shadow-lg dark:bg-zinc-900 dark:text-zinc-100">
                <p className="mb-2">{draft.greeting || "Hi! Can I help you find something?"}</p>
                <span className="inline-block rounded-full px-3 py-1 text-xs font-semibold" style={{ background: colour, color: ink }}>
                  Ask a question
                </span>
              </div>
            )}
            <span
              className={`flex h-12 items-center justify-center gap-2 shadow-lg ${draft.label.trim() ? "rounded-full px-4 text-sm font-semibold" : "w-12 rounded-full"}`}
              style={{ background: colour, color: ink }}
            >
              <AgentIconSvg icon={draft.icon} picture={picture} className={draft.icon === "image" && picture && !draft.label.trim() ? "size-12" : draft.icon === "logo" || draft.icon === "image" ? "size-7" : "size-5"} />
              {draft.label.trim() && <span>{draft.label.trim()}</span>}
            </span>
          </div>
        </div>
      </div>
    </Section>
  );
}

function KnowledgeForm({
  view,
  draft,
  setDraft,
  working,
  onReread,
}: {
  view: AgentView;
  draft: AgentSettings;
  setDraft: (d: AgentSettings) => void;
  working: boolean;
  onReread: () => void;
}) {
  const known = view.knowledge;
  const chars = known.pages.reduce((sum, p) => sum + p.chars, 0);
  const source =
    known.source === "full"
      ? "Read from your published site: every page in full."
      : known.source === "start"
        ? draft.reads === "full"
          ? "Read from your published site: the start of each page. To read every page in full, the site needs the latest site update and a publish."
          : "Read from your published site: the start of each page."
        : known.source === "saved"
          ? "Your published site couldn't be read yet, so it uses your pages as they were when you last saved here. Publish your site, then read it again."
          : "It reads your site once it's turned on.";
  return (
    <Section
      title="What it knows about your site"
      description="The agent answers and suggests only from your own pages. It reads every page of your published site (no other websites), and reads it again by itself every 15 minutes, so what you publish is what it knows."
    >
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How much of each page it reads">
        {(
          [
            { id: "full", label: "Every page in full", about: "Best answers: it finds a price or detail anywhere on a page. Each answer reads a little more (see the costs below)." },
            { id: "start", label: "The start of each page", about: "Cheaper answers, but it may miss details further down a page." },
          ] as const
        ).map((o) => (
          <label
            key={o.id}
            className={`cursor-pointer rounded-lg border p-3 text-sm ${draft.reads === o.id ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"}`}
          >
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name="agent-reads" checked={draft.reads === o.id} onChange={() => setDraft({ ...draft, reads: o.id })} />
              {o.label}
            </span>
            <span className="mt-1 block text-zinc-500">{o.about}</span>
          </label>
        ))}
      </div>
      {view.enabled && (
        <div className="mt-4 space-y-2 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            {source} It knows {number.format(known.pages.length)} {known.pages.length === 1 ? "page" : "pages"} ({number.format(chars)} characters).
          </p>
          {known.pages.length > 0 && (
            <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <summary className="cursor-pointer font-medium">See the pages it knows</summary>
              <ul className="mt-2 space-y-1">
                {known.pages.map((p) => (
                  <li key={p.url} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {p.title} <span className="text-zinc-500">{p.url}</span>
                    </span>
                    <span className="tabular-nums text-zinc-500">{number.format(p.chars)} characters</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Button variant="secondary" disabled={working} onClick={onReread}>
            {working ? "Reading…" : "Read my site again now"}
          </Button>
        </div>
      )}
    </Section>
  );
}

const PACE_NAMES: Record<AgentPace, { label: string; about: string }> = {
  gentle: { label: "Gentle", about: "Speaks up only when a visitor clearly lingers." },
  balanced: { label: "Balanced", about: "Recommended for most sites." },
  eager: { label: "Eager", about: "Quick to help. Best for shops and sign-ups." },
};
const secs = (ms: number) => `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;

function PaceForm({ view, draft, setDraft }: { view: AgentView; draft: AgentSettings; setDraft: (d: AgentSettings) => void }) {
  return (
    <Section
      title="How quickly it speaks up"
      description="When a visitor rests the pointer on something, the agent suggests where to go. Its words are written while the visitor is still resting, so a suggestion appears about half a second after the rest counts. Phones have no pointer: there it speaks up when a visitor browses several pages, reads a page for a while or is about to leave. Changes work straight away, without publishing."
    >
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="How quickly it speaks up">
        {(Object.keys(PACE_NAMES) as AgentPace[]).map((id) => {
          const p = view.paces[id];
          const on = draft.pace === id;
          return (
            <label
              key={id}
              className={`cursor-pointer rounded-lg border p-3 text-sm ${on ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"}`}
            >
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="agent-pace" value={id} checked={on} onChange={() => setDraft({ ...draft, pace: id })} />
                {PACE_NAMES[id].label}
              </span>
              <span className="mt-1 block text-zinc-500">{PACE_NAMES[id].about}</span>
              <ul className="mt-2 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                <li>Resting on a goal: {secs(p.goalRest)}</li>
                <li>Resting on another page&apos;s link: {secs(p.linkRest)}</li>
                <li>At least {secs(p.gap)} between suggestions</li>
                <li>Up to {p.perVisit} suggestions a visit</li>
              </ul>
            </label>
          );
        })}
      </div>
      <label className="mt-4 flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={draft.greet} onChange={(e) => setDraft({ ...draft, greet: e.target.checked })} />
        <span>
          <span className="font-medium">Say hello a few seconds into each visit</span>
          <span className="block text-zinc-500">Shows your greeting in a small bubble with &quot;Ask a question&quot;, once a visit. Free: it doesn&apos;t use the AI.</span>
        </span>
      </label>
    </Section>
  );
}

function RememberForm({ view, draft, setDraft }: { view: AgentView; draft: AgentSettings; setDraft: (d: AgentSettings) => void }) {
  const days = view.rememberDays;
  return (
    <Section
      title="Returning visitors"
      description={`Off: every visit starts fresh, and nothing about a visitor stays in their browser after they close the tab. On: the agent remembers each visitor on their own device for ${days} days and picks up where they left off next time: what interested them, what it already offered (it won't offer again what they turned down) and their chat. Visitors aren't asked in the chat. They can choose "Forget me on this device" in the chat at any time, and it's deleted ${days} days after their last visit. Publish your site after changing this.`}
    >
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={draft.remember} onChange={(e) => setDraft({ ...draft, remember: e.target.checked })} />
        <span>
          <span className="font-medium">Remember returning visitors for {days} days</span>
          <span className="block text-zinc-500">Never for visitors whose browser asks sites not to track them.</span>
        </span>
      </label>
      {draft.remember && (
        <div className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={draft.rememberAfterBanner} onChange={(e) => setDraft({ ...draft, rememberAfterBanner: e.target.checked })} />
            <span>
              <span className="font-medium">Only after my site&apos;s cookie banner says yes</span>
              <span className="block text-zinc-500">
                In the UK and the EU, remembering a visitor this way needs their consent, usually through a cookie banner. Turn this on if your visitors are there: the agent then waits for your banner. Your banner&apos;s settings (or the Custom code screen) should run{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">window.TwinstackAgent.remember(true)</code> when a visitor accepts, and{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">remember(false)</code> when they decline.
              </span>
            </span>
          </label>
        </div>
      )}
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
      <CostTable view={view} limit={value} />
    </Section>
  );
}

function CostTable({ view, limit }: { view: AgentView; limit: number }) {
  const rows: { label: string; cost: AgentCost }[] = [
    { label: "One suggestion", cost: view.costs.suggestion },
    { label: "One answer to a question", cost: view.costs.answer },
  ];
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1 pr-3 font-medium">What it does</th>
            <th className="py-1 pr-3 font-medium">Credits each</th>
            <th className="py-1 pr-3 font-medium">Text the AI reads and writes</th>
            <th className="py-1 font-medium">Your daily limit covers</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, cost }) => (
            <tr key={label} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="py-2 pr-3">{label}</td>
              <td className="py-2 pr-3 tabular-nums">
                {cost.credits === null ? "–" : `about ${fmt(cost.credits)}`}
                <span className="block text-xs text-zinc-500">{cost.measured ? `average of ${number.format(cost.requests)} in 30 days` : "estimate"}</span>
              </td>
              <td className="py-2 pr-3 tabular-nums">about {number.format(cost.tokens)} tokens</td>
              <td className="py-2 tabular-nums">
                {cost.credits && Number.isFinite(limit) ? `about ${number.format(Math.floor(limit / Math.max(cost.credits, 0.1)))} a day` : "–"}
              </td>
            </tr>
          ))}
          <tr className="border-t border-zinc-200 dark:border-zinc-800">
            <td className="py-2 pr-3">Greeting, timing rules, the fixed &quot;only this website&quot; reply</td>
            <td className="py-2 pr-3">Free</td>
            <td className="py-2 pr-3">None</td>
            <td className="py-2">Unlimited</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-zinc-500">
        A suggestion may be written a moment before a visitor&apos;s rest counts so it appears without a wait. If they move away first it isn&apos;t shown, but it&apos;s still charged (at most a few a visit).
      </p>
    </div>
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
          {view.settings.remember && <Stat label="Returning visits" value={number.format(totals.returning)} />}
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
            {q.offTopic && <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Kept to your website</span>}
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
        {session.visit && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-300">Returning · visit {session.visit}</span>}
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
