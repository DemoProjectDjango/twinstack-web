"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { confirmModal } from "@/lib/confirm";
import { toast } from "@/lib/toast";
import {
  api,
  workspacePath,
  type AnalyticsFilterField,
  type AnalyticsFilters,
  type AnalyticsLive,
  type AnalyticsReport,
  type AnalyticsSettings,
  type AnalyticsView,
  type WorkspaceStatus,
} from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
import { useSite } from "./site-context";
import { Button, Details, EmptyState, ErrorText, Notice, ScreenHeader, Section, Segmented, Spinner, inputClass } from "./ui";

// The site's visits, for its creator only (server/src/analytics.js). Counting starts when the
// owner turns it on (the counter goes into site.config.json) and publishes. The numbers come with
// suggestions that lead straight to the editor's own tools: make a missing page people look for,
// open a page nobody visits, or ask Claude about the busiest one. Clicking a row (a page, a source,
// a device…) narrows the whole screen to those visitors. A live line at the top polls every 30
// seconds and reloads the numbers when a new visit comes in.

/** A period the server knows (PRESETS in server/src/analytics.js); "custom" has `from` and `to`. */
type Preset = "today" | "yesterday" | "7" | "30" | "90" | "365" | "month" | "lastmonth" | "custom";
type Span = { range: Preset; from?: string; to?: string };
const PRESETS: { value: Exclude<Preset, "custom">; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
  { value: "month", label: "This month" },
  { value: "lastmonth", label: "Last month" },
];
const SPAN_KEY = "twinstack:analytics-span";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIVE_POLL_MS = 30_000;
/** Below this many visitors, shares and suggestions are mostly noise. */
const MIN_VISITORS = 10;

function readSpan(): Span {
  try {
    const value = JSON.parse(localStorage.getItem(SPAN_KEY) ?? "null");
    if (PRESETS.some((p) => p.value === value?.range)) return { range: value.range };
    if (value?.range === "custom" && DATE.test(value.from) && DATE.test(value.to)) return { range: "custom", from: value.from, to: value.to };
  } catch {
    // Nothing saved, or storage blocked.
  }
  return { range: "30" };
}

/** Today's date where the owner is ("2026-10-16"), the latest a custom range may end. */
const localToday = () => new Date().toLocaleDateString("en-CA");

/** The owner's own time zone: "today" and each day start at their midnight. */
const ownZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const number = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const formatCount = (n: number) => (n >= 10_000 ? compact.format(n) : number.format(n));
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const dayLabel = (date: string, withYear = false) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(withYear && { year: "numeric" }), timeZone: "UTC" });
const hourLabel = (hour: number) => new Date(Date.UTC(2000, 0, 1, hour)).toLocaleTimeString(undefined, { hour: "numeric", timeZone: "UTC" });

type Period = AnalyticsReport["period"];

/** "1–15 Oct" or "16 Oct": the days a period covers. */
function spanLabel(first: string, last: string) {
  if (first === last) return dayLabel(first);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${dayLabel(first, !sameYear)} – ${dayLabel(last, !sameYear)}`;
}

/** "today", "in the last 7 days", "last month", "between 1 Sep and 10 Sep". */
function inPeriod(period: Period) {
  switch (period.preset) {
    case "today":
      return "today";
    case "yesterday":
      return "yesterday";
    case "month":
      return "this month";
    case "lastmonth":
      return "last month";
    case "365":
      return "in the last 12 months";
    case "custom":
      return period.first === period.last ? `on ${dayLabel(period.first)}` : `from ${dayLabel(period.first)} to ${dayLabel(period.last)}`;
    default:
      return `in the last ${period.days} days`;
  }
}

/** What the totals are compared with. */
function beforePeriod(period: Period) {
  if (period.preset === "today") return "yesterday by this time";
  if (period.days === 1) return "the day before";
  return period.preset === "365" ? "the 12 months before" : `the ${period.days} days before`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso: string) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds > -60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
}

/** "Europe/London" → "London, Europe". */
function zoneLabel(zone: string) {
  if (zone === "Unknown") return "Unknown";
  const parts = zone.split("/");
  const place = parts.at(-1)!.replace(/_/g, " ");
  return parts.length > 1 ? `${place}, ${parts[0].replace(/_/g, " ")}` : place;
}

const CHANNELS: Record<string, string> = {
  direct: "Typed the address or a bookmark",
  search: "Search",
  social: "Social",
  ai: "AI assistant",
  campaign: "Campaign link",
  other: "Link on another site",
};

const CLICK_KINDS: Record<string, string> = { phone: "Phone number", email: "Email address", whatsapp: "WhatsApp", link: "Link to" };

/** Each filter's name in the "Add filter" menu. */
const FILTER_TITLES: Record<AnalyticsFilterField, string> = {
  page: "Page they opened",
  source: "Where they came from",
  device: "Device",
  browser: "Browser",
  os: "System",
  zone: "Place",
};

const FILTER_LABELS: Record<AnalyticsFilterField, string> = {
  page: "Opened",
  source: "Came from",
  device: "Device",
  browser: "Browser",
  os: "System",
  zone: "Place",
};

function query(span: Span, zone: string, filters: AnalyticsFilters) {
  const params = new URLSearchParams({ range: span.range, tz: zone });
  if (span.range === "custom") params.set("from", span.from ?? "");
  if (span.range === "custom") params.set("to", span.to ?? "");
  for (const [field, value] of Object.entries(filters)) if (value) params.set(field, value);
  return params.toString();
}

export function AnalyticsPanel() {
  const { owner, repo, overview, status, refresh, showSection, editFile, busy, claude } = useSite();
  const { send, turn } = useAssistant();
  const [span, setSpan] = useState<Span>(readSpan);
  const [filters, setFilters] = useState<AnalyticsFilters>({});
  const [zone] = useState(ownZone);
  const [view, setView] = useState<AnalyticsView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [live, setLive] = useState<AnalyticsLive | null>(null);
  // Bumped when the live line sees a newer visit, so the numbers reload.
  const [visitTick, setVisitTick] = useState(0);
  const search = query(span, zone, filters);
  // The query the shown numbers are for: while it differs from `search`, new ones are loading.
  const [loadedSearch, setLoadedSearch] = useState<string | null>(null);
  const loading = loadedSearch !== search;
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<AnalyticsView>(workspacePath(owner, repo, `/analytics?${search}`))
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoadedSearch(search));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, search, visitTick]);

  const enabled = view?.settings.enabled === true;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let lastSeen: string | null | undefined;
    const poll = () => {
      if (document.hidden) return;
      api<AnalyticsLive>(workspacePath(owner, repo, "/analytics/live"))
        .then((next) => {
          if (cancelled) return;
          setLive(next);
          const at = next.last?.at ?? null;
          // A visit since the last look: reload the numbers (not on the first look).
          if (lastSeen !== undefined && at !== lastSeen) setVisitTick((t) => t + 1);
          lastSeen = at;
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, LIVE_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [owner, repo, enabled]);

  function chooseSpan(next: Span) {
    setSpan(next);
    try {
      localStorage.setItem(SPAN_KEY, JSON.stringify(next));
    } catch {
      // Private mode: remembered for this visit only.
    }
  }

  /** Narrows to visitors with this value, or takes the filter off when it's already on. */
  function pick(field: AnalyticsFilterField, value: string) {
    setFilters((current) => {
      const next = { ...current };
      if (next[field] === value) delete next[field];
      else next[field] = value;
      return next;
    });
  }

  async function act(name: string, path: string, method: "POST" | "DELETE", done: string) {
    setWorking(name);
    setError(null);
    try {
      const result = await api<{ settings?: AnalyticsSettings; deleted?: number }>(workspacePath(owner, repo, `/analytics${path}`), { method, body: {} });
      if (result.settings) setView((v) => ({ settings: result.settings!, report: result.settings!.hasData ? (v?.report ?? null) : null }));
      if (result.deleted !== undefined) {
        setView((v) => (v ? { settings: { ...v.settings, hasData: false }, report: null } : v));
        setLive(null);
      }
      // Turning counting on or off changes site.config.json, which then waits to be published.
      if (path === "/enable" || path === "/disable") await refresh();
      toast.success(done);
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  async function turnOff() {
    const ok = await confirmModal(
      "Stop counting visits? Visits stop counting straight away. The counter is taken out of your site the next time you publish. Visits already counted are kept until you delete them.",
      { confirmLabel: "Stop counting" },
    );
    if (ok) await act("disable", "/disable", "POST", "Visit counting is off.");
  }

  async function deleteData() {
    const ok = await confirmModal("Delete every visit counted so far? This can't be undone.", { confirmLabel: "Delete visits", danger: true, title: "Delete visit data" });
    if (ok) await act("delete", "/data", "DELETE", "Visit data deleted.");
  }

  const settings = view?.settings ?? null;
  const report = view?.report ?? null;
  const pages = useMemo(() => overview?.collections.flatMap((c) => c.pages) ?? [], [overview]);
  const pageByPath = useMemo(() => new Map(pages.filter((p) => p.url).map((p) => [normalizedPath(p.url!), p])), [pages]);
  const unpublished = status.changes.some((c) => c.path === "site.config.json");
  const ignoreUrl = settings?.siteUrl ? `${settings.siteUrl}${settings.siteUrl.includes("?") ? "&" : "?"}${settings.ignoreParam}` : null;
  const showReport = Boolean(settings?.hasData);

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Visitors"
        description="How many people visit your published site, where they come from and what they look at. Only you can see this."
      >
        {showReport && (
          <span className="flex flex-wrap items-center gap-2">
            {loading && <Spinner />}
            <RangePicker span={span} period={report?.period ?? null} onChange={chooseSpan} />
            <DownloadMenu href={workspacePath(owner, repo, `/analytics/export?${search}`)} filtered={Object.keys(filters).length > 0} />
          </span>
        )}
      </ScreenHeader>

      <ErrorText error={error} />
      {!view && loading && (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner /> Loading your visits…
        </p>
      )}

      {settings && !settings.supported && !settings.enabled && (
        <Notice tone="warning">
          Your site needs the latest site update before it can count visits.{" "}
          <button type="button" className="font-medium underline" onClick={() => showSection("home")}>
            Go to Home to update it
          </button>
        </Notice>
      )}

      {settings && settings.supported && !settings.enabled && (
        <EmptyState
          title="Count your site's visits"
          action={
            <Button variant="primary" disabled={busy || working !== null} onClick={() => void act("enable", "/enable", "POST", "Visit counting is on. Publish your site to start counting.")}>
              {working === "enable" ? "Turning on…" : "Turn on visit counting"}
            </Button>
          }
        >
          See how many people visit, which pages they read, where they come from and which pages they look for but can&apos;t find. No cookies and no
          cookie banner: visitors aren&apos;t tracked from day to day, and nothing about them is stored. Visits are kept for {settings.retentionDays} days.
        </EmptyState>
      )}

      {settings?.enabled && settings.localEndpoint && (
        <Notice tone="warning">
          This Twinstack server isn&apos;t set up to receive visits from the internet yet (PUBLIC_API_URL), so your published site can&apos;t report its
          visits. Let the person who runs Twinstack know.
        </Notice>
      )}

      {settings?.enabled && (!settings.configured || settings.endpointChanged) && (
        <Notice tone="warning">
          {settings.configured
            ? "Your site sends its visits to an old address of this server, so they aren't counted."
            : "Your site's settings no longer have the visit counter."}{" "}
          <button
            type="button"
            className="font-medium underline"
            disabled={busy || working !== null}
            onClick={() => void act("enable", "/enable", "POST", "Visit counter updated. Publish your site to use it.")}
          >
            {working === "enable" ? "Updating…" : "Update the counter"}
          </button>
        </Notice>
      )}

      {settings?.enabled && settings.configured && !settings.endpointChanged && unpublished && (
        <Notice tone="warning">
          Publish your site to start counting visits.{" "}
          <button type="button" className="font-medium underline" onClick={() => showSection("publish")}>
            Go to Publish
          </button>
        </Notice>
      )}

      {settings?.enabled && settings.configured && !settings.endpointChanged && !unpublished && !settings.hasData && (
        <EmptyState title="Waiting for the first visit">
          Visits show here a few seconds after they happen. Open your site in another browser or on your phone to see the first one. Your own visits count
          too, unless you stop them below.
        </EmptyState>
      )}

      {settings?.enabled && live?.last && <LiveLine live={live} titleOf={(path) => pageTitle(path, pageByPath)} />}

      {showReport && (
        <FilterBar
          filters={filters}
          report={report}
          titleOf={(path) => pageTitle(path, pageByPath)}
          onPick={pick}
          onRemove={(field) => pick(field, filters[field]!)}
          onClear={() => setFilters({})}
        />
      )}

      {report && (
        <Report
          report={report}
          filters={filters}
          pages={pages}
          pageByPath={pageByPath}
          claudeReady={claude.ready && turn?.status !== "running"}
          locked={busy || working !== null}
          onPick={pick}
          onEdit={(file) => void editFile(file)}
          onAsk={(text) => void send(text)}
        />
      )}

      {settings?.enabled && (
        <Section title="Settings" description="Who counts, and what's kept.">
          <div className="space-y-3 text-sm">
            {ignoreUrl && (
              <p>
                <a href={ignoreUrl} target="_blank" rel="noreferrer" className="font-medium underline">
                  Don&apos;t count my visits
                </a>{" "}
                <span className="text-zinc-500">
                  Opens your site once in this browser and stops counting its visits. Do it on each browser and device you use.
                </span>
              </p>
            )}
            <p className="text-zinc-500">
              Visits are kept for {settings.retentionDays} days, then deleted. Visitors who ask browsers not to track them aren&apos;t counted.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button disabled={busy || working !== null} onClick={() => void turnOff()}>
                {working === "disable" ? "Turning off…" : "Stop counting visits"}
              </Button>
              {settings.hasData && (
                <Button variant="danger" disabled={working !== null} onClick={() => void deleteData()}>
                  {working === "delete" ? "Deleting…" : "Delete visit data"}
                </Button>
              )}
            </div>
          </div>
        </Section>
      )}

      {settings && !settings.enabled && settings.hasData && (
        <Section title="Visits counted before" description="Counting is off, but the visits counted earlier are still kept.">
          <Button variant="danger" disabled={working !== null} onClick={() => void deleteData()}>
            {working === "delete" ? "Deleting…" : "Delete visit data"}
          </Button>
        </Section>
      )}
    </div>
  );
}

/* --------------------------------------------------------- live and filters */

function LiveLine({ live, titleOf }: { live: AnalyticsLive; titleOf: (path: string) => string }) {
  const active = live.visitors > 0;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      <span aria-hidden="true" className="relative flex size-2.5">
        {active && <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-500 opacity-60" />}
        <span className={`relative inline-flex size-2.5 rounded-full ${active ? "bg-green-500" : "bg-zinc-300 dark:bg-zinc-700"}`} />
      </span>
      <span className="font-medium">
        {active ? `${number.format(live.visitors)} ${live.visitors === 1 ? "visitor" : "visitors"} in the last ${live.minutes} minutes` : `Nobody in the last ${live.minutes} minutes`}
      </span>
      {live.last && (
        <span className="text-zinc-500">
          · Last visit {ago(live.last.at)}, {live.last.notFound ? "to a missing page, " : ""}
          {titleOf(live.last.path)}
        </span>
      )}
    </p>
  );
}

/** A button that opens a small panel below it; Escape or a click outside closes it. */
function Dropdown({
  label,
  title,
  align = "right",
  className = "",
  children,
}: {
  label: ReactNode;
  title?: string;
  align?: "left" | "right";
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        title={title}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900 ${className}`}
      >
        {label}
        <span aria-hidden="true" className="text-xs text-zinc-500">
          ▾
        </span>
      </button>
      {open && (
        <div
          className={`absolute top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-200 bg-background p-1 shadow-lg dark:border-zinc-800 ${align === "right" ? "right-0" : "left-0"}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const menuItem = "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900";

/** The period: a preset, or any days up to 12 months back. Shows the dates it covers. */
function RangePicker({ span, period, onChange }: { span: Span; period: Period | null; onChange: (next: Span) => void }) {
  const [today] = useState(localToday);
  const earliest = useMemo(() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 365);
    return d.toISOString().slice(0, 10);
  }, [today]);
  const [from, setFrom] = useState(span.from ?? period?.first ?? today);
  const [to, setTo] = useState(span.to ?? period?.last ?? today);
  const name = span.range === "custom" ? "Custom range" : (PRESETS.find((p) => p.value === span.range)?.label ?? "Last 30 days");
  const valid = DATE.test(from) && DATE.test(to) && from <= to && to <= today && from >= earliest;

  return (
    <Dropdown
      title="Choose the period"
      label={
        <span className="flex items-baseline gap-2">
          <span>{name}</span>
          {period && <span className="font-normal text-zinc-500 tabular-nums">{spanLabel(period.first, period.last)}</span>}
        </span>
      }
    >
      {(close) => (
        <div>
          <ul>
            {PRESETS.map((preset) => (
              <li key={preset.value}>
                <button
                  type="button"
                  className={menuItem}
                  onClick={() => {
                    onChange({ range: preset.value });
                    close();
                  }}
                >
                  <span>{preset.label}</span>
                  {span.range === preset.value && <span aria-label="(chosen)">✓</span>}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-1 border-t border-zinc-200 p-3 dark:border-zinc-800"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              onChange({ range: "custom", from, to });
              close();
            }}
          >
            <p className="text-xs font-medium text-zinc-500">Custom range{span.range === "custom" ? " ✓" : ""}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-500">
                From
                <input type="date" value={from} min={earliest} max={today} onChange={(e) => setFrom(e.target.value)} className={`mt-1 ${inputClass}`} />
              </label>
              <label className="text-xs text-zinc-500">
                To
                <input type="date" value={to} min={earliest} max={today} onChange={(e) => setTo(e.target.value)} className={`mt-1 ${inputClass}`} />
              </label>
            </div>
            {!valid && <p className="mt-2 text-xs text-red-600 dark:text-red-400">Pick days in the last 12 months, the first on or before the last.</p>}
            <Button type="submit" variant="primary" className="mt-3 w-full" disabled={!valid}>
              Show these days
            </Button>
          </form>
        </div>
      )}
    </Dropdown>
  );
}

const DOWNLOADS = [
  { format: "xlsx", label: "Excel", type: ".xlsx", text: "A summary sheet, a sheet for each table, and every visit. Opens in Excel, Numbers or Google Sheets." },
  { format: "pdf", label: "PDF", type: ".pdf", text: "A printable report with the totals, the chart and every table." },
  { format: "csv", label: "CSV", type: ".csv", text: "One file: the summary, each table in turn, then every visit." },
  { format: "json", label: "JSON", type: ".json", text: "Everything, every visit included, for other tools." },
] as const;

/** The file name the server gave (Content-Disposition), else a plain one. */
function downloadName(res: Response, format: string) {
  const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
  return match?.[1] ?? `visits-report.${format === "csv" ? "csv" : format}`;
}

/**
 * "Download full report": the whole report for the period and filters on screen, in the file type
 * the owner picks. It's fetched first, so the menu can say it's being prepared and show an error
 * as a message instead of saving it as a file.
 */
function DownloadMenu({ href, filtered }: { href: string; filtered: boolean }) {
  const [preparing, setPreparing] = useState<string | null>(null);

  async function download(format: string, label: string, close: () => void) {
    setPreparing(format);
    try {
      const res = await fetch(`${href}&format=${format}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `The ${label} report couldn't be made (${res.status}).`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(res, format);
      document.body.append(link);
      link.click();
      link.remove();
      // Give the browser a moment to start saving before the address goes.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      close();
      toast.success(`${label} report downloaded.`);
    } catch (err) {
      toast.error(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "The download failed. Check your connection and try again.");
    } finally {
      setPreparing(null);
    }
  }

  return (
    <Dropdown label={preparing ? <span className="flex items-center gap-2"><Spinner /> Preparing…</span> : "Download"} title="Download the full report">
      {(close) => (
        <div>
          <p className="px-3 pb-1 pt-2 text-xs text-zinc-500">Full report for this period{filtered ? ", with your filters" : ""}, as:</p>
          <ul>
            {DOWNLOADS.map((item) => (
              <li key={item.format}>
                <button
                  type="button"
                  disabled={preparing !== null}
                  onClick={() => void download(item.format, item.label, close)}
                  className={`${menuItem} flex-col items-start gap-0.5 disabled:cursor-wait disabled:opacity-60`}
                >
                  <span className="flex w-full items-center justify-between gap-2 font-medium">
                    <span>
                      {item.label} <span className="font-normal text-zinc-500">{item.type}</span>
                    </span>
                    {preparing === item.format && (
                      <span className="flex items-center gap-1.5 text-xs font-normal text-zinc-500">
                        <Spinner /> Preparing…
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-zinc-500">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dropdown>
  );
}

/** The values a filter can take in this period, most common first. */
function filterOptions(report: AnalyticsReport | null, field: AnalyticsFilterField, titleOf: (path: string) => string) {
  if (!report) return [];
  switch (field) {
    case "page":
      return report.pages.map((p) => ({ value: p.path, label: titleOf(p.path), count: p.visitors }));
    case "source":
      return report.sources.map((s) => ({ value: s.name, label: s.name, count: s.count }));
    case "device":
      return report.devices.map((d) => ({ value: d.name, label: d.name, count: d.count }));
    case "browser":
      return report.browsers.map((d) => ({ value: d.name, label: d.name, count: d.count }));
    case "os":
      return report.systems.map((d) => ({ value: d.name, label: d.name, count: d.count }));
    case "zone":
      return report.zones.map((d) => ({ value: d.name, label: zoneLabel(d.name), count: d.count }));
  }
}

/** The filters on, each removable, and "Add filter": always there, so filtering is easy to find. */
function FilterBar({
  filters,
  report,
  titleOf,
  onPick,
  onRemove,
  onClear,
}: {
  filters: AnalyticsFilters;
  report: AnalyticsReport | null;
  titleOf: (path: string) => string;
  onPick: (field: AnalyticsFilterField, value: string) => void;
  onRemove: (field: AnalyticsFilterField) => void;
  onClear: () => void;
}) {
  const [field, setField] = useState<AnalyticsFilterField | null>(null);
  const entries = Object.entries(filters).filter(([, v]) => v) as [AnalyticsFilterField, string][];
  const fields = (Object.keys(FILTER_LABELS) as AnalyticsFilterField[]).filter((f) => !filters[f]);
  const options = field ? filterOptions(report, field, titleOf) : [];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      <span className="text-zinc-500">{entries.length ? "Showing visitors who match:" : "Showing everyone."}</span>
      {entries.map(([name, value]) => (
        <span key={name} className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 py-0.5 pl-3 pr-1 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
          <span className="text-xs opacity-70">{FILTER_LABELS[name]}</span>
          <span className="font-medium">{name === "page" ? titleOf(value) : name === "zone" ? zoneLabel(value) : value}</span>
          <button
            type="button"
            onClick={() => onRemove(name)}
            className="grid size-5 place-items-center rounded-full hover:bg-sky-100 dark:hover:bg-sky-900"
            aria-label={`Remove the ${FILTER_LABELS[name].toLowerCase()} filter`}
          >
            ×
          </button>
        </span>
      ))}
      {fields.length > 0 && (
        <Dropdown label={<span>+ Add filter</span>} align="left" className="px-2.5 py-1">
          {(close) =>
            field === null ? (
              <ul>
                {fields.map((f) => (
                  <li key={f}>
                    <button type="button" className={menuItem} onClick={() => setField(f)}>
                      <span>{FILTER_TITLES[f]}</span>
                      <span aria-hidden="true" className="text-zinc-400">
                        ›
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div>
                <button type="button" className={`${menuItem} text-zinc-500`} onClick={() => setField(null)}>
                  <span>‹ {FILTER_TITLES[field]}</span>
                </button>
                <ul className="max-h-72 overflow-auto border-t border-zinc-200 pt-1 dark:border-zinc-800">
                  {options.map((option) => (
                    <li key={option.value}>
                      <button
                        type="button"
                        className={menuItem}
                        onClick={() => {
                          onPick(field, option.value);
                          setField(null);
                          close();
                        }}
                      >
                        <span className="min-w-0 truncate">{option.label}</span>
                        <span className="shrink-0 text-xs text-zinc-500 tabular-nums">{number.format(option.count)}</span>
                      </button>
                    </li>
                  ))}
                  {options.length === 0 && <li className="px-3 py-2 text-zinc-500">Nothing in this period.</li>}
                </ul>
              </div>
            )
          }
        </Dropdown>
      )}
      {entries.length > 0 && (
        <button type="button" onClick={onClear} className="ml-auto text-zinc-500 underline hover:text-foreground">
          Show everyone
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ report */

type SitePageLite = { file: string; title: string; url?: string | null; draft: boolean };

/** A page's address the way the counter records it: /x/index.html is /x/. */
const normalizedPath = (url: string) => url.replace(/\/index\.html$/, "/");

/** What to call an address: "Homepage", the page's title, or the address itself. */
function pageTitle(path: string, pageByPath: Map<string, SitePageLite>) {
  if (path === "/") return "Homepage";
  return pageByPath.get(path)?.title ?? path;
}

function Report({
  report,
  filters,
  pages,
  pageByPath,
  claudeReady,
  locked,
  onPick,
  onEdit,
  onAsk,
}: {
  report: AnalyticsReport;
  filters: AnalyticsFilters;
  pages: SitePageLite[];
  pageByPath: Map<string, SitePageLite>;
  claudeReady: boolean;
  locked: boolean;
  onPick: (field: AnalyticsFilterField, value: string) => void;
  onEdit: (file: string) => void;
  onAsk: (text: string) => void;
}) {
  const { totals, previous } = report;
  const [pagesTab, setPagesTab] = useState<"viewed" | "entries">("viewed");
  const compare = previous.visitors > 0;
  const fewVisitors = totals.visitors < MIN_VISITORS;
  const filtered = Object.keys(filters).length > 0;
  const label = (path: string) => <PageLabel path={path} title={path === "/" ? "Homepage" : (pageByPath.get(path)?.title ?? null)} />;

  // Cards with nothing in them this period become one line at the end, instead of a card each.
  const empty: string[] = [];
  if (!report.clicks.length) empty.push("contact clicks");
  if (!report.notFound.length) empty.push("missing pages");
  if (!report.campaigns.length) empty.push("campaign links");

  return (
    <div className="space-y-6">
      <div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Visitors" value={formatCount(totals.visitors)} change={compare ? change(totals.visitors, previous.visitors) : null} />
          <StatTile label="Page views" value={formatCount(totals.pageviews)} change={compare ? change(totals.pageviews, previous.pageviews) : null} />
          <StatTile
            label="Pages per visitor"
            value={(totals.visitors ? totals.pageviews / totals.visitors : 0).toFixed(1)}
            change={compare && !fewVisitors ? change(totals.pageviews / totals.visitors, previous.pageviews / previous.visitors) : null}
          />
          <StatTile
            label="Left after one page"
            value={fewVisitors ? "–" : `${percent(totals.singlePage, totals.visitors)}%`}
            note={fewVisitors ? `Shown from ${MIN_VISITORS} visitors` : undefined}
            change={
              compare && !fewVisitors && previous.visitors >= MIN_VISITORS
                ? { points: percent(totals.singlePage, totals.visitors) - percent(previous.singlePage, previous.visitors), lowerIsBetter: true }
                : null
            }
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {compare ? `Compared with ${beforePeriod(report.period)}.` : `Nothing to compare with: there were no visits ${beforePeriod(report.period).replace(/^the /, "in the ")}.`}
        </p>
      </div>

      <Section
        title={report.unit === "hour" ? "Visitors by hour" : report.unit === "week" ? "Visitors per week" : "Visitors per day"}
        description={`A visitor is one person on one day, so someone who comes back tomorrow counts again. Times are in your time zone (${zoneLabel(report.zone)}).`}
      >
        <VisitsChart report={report} />
      </Section>

      {!filtered && !fewVisitors && (
        <Suggestions report={report} pages={pages} pageByPath={pageByPath} claudeReady={claudeReady} locked={locked} onEdit={onEdit} onAsk={onAsk} />
      )}
      {!filtered && fewVisitors && <Suggestions report={report} pages={[]} pageByPath={pageByPath} claudeReady={claudeReady} locked={locked} onEdit={onEdit} onAsk={onAsk} missingOnly />}

      <p className="text-xs text-zinc-500">Click a row, or use Add filter above, to see only those visitors. Click it again to show everyone.</p>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Section title="Pages" description={pagesTab === "viewed" ? "The pages people look at most." : "The first page each visitor opens."}>
          <Segmented
            label="Pages"
            value={pagesTab}
            options={[
              { value: "viewed", label: "Most viewed" },
              { value: "entries", label: "Where visitors arrive" },
            ]}
            onChange={setPagesTab}
          />
          <div className="mt-3">
            {pagesTab === "viewed" ? (
              <BarList
                rows={report.pages.slice(0, 12).map((p) => ({ key: p.path, label: label(p.path), value: p.pageviews }))}
                valueLabel="Views"
                empty={`No page views ${inPeriod(report.period)}.`}
                active={filters.page}
                onPick={(path) => onPick("page", path)}
              />
            ) : (
              <BarList
                rows={report.entries.map((p) => ({ key: p.path, label: label(p.path), value: p.count }))}
                valueLabel="Visitors"
                empty={`No visitors ${inPeriod(report.period)}.`}
                active={filters.page}
                onPick={(path) => onPick("page", path)}
              />
            )}
          </div>
        </Section>
        <Section title="Where visitors come from" description="The site or link that sent each visitor.">
          <BarList
            rows={report.sources.map((s) => ({
              key: s.name,
              label: (
                <span>
                  {s.name} <span className="text-zinc-500">· {CHANNELS[s.channel] ?? s.channel}</span>
                </span>
              ),
              value: s.count,
            }))}
            valueLabel="Visitors"
            empty={`No visitors ${inPeriod(report.period)}.`}
            active={filters.source}
            onPick={(name) => onPick("source", name)}
          />
        </Section>
        <Section title="Devices" description="Phones are under 768 pixels wide, tablets under 1024.">
          <BarList
            rows={report.devices.map((d) => ({ key: d.name, label: d.name, value: d.count }))}
            valueLabel="Visitors"
            empty={`No visitors ${inPeriod(report.period)}.`}
            active={filters.device}
            onPick={(name) => onPick("device", name)}
          />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <BarList rows={report.browsers.map((d) => ({ key: d.name, label: d.name, value: d.count }))} valueLabel="Browser" empty="" active={filters.browser} onPick={(name) => onPick("browser", name)} />
            <BarList rows={report.systems.map((d) => ({ key: d.name, label: d.name, value: d.count }))} valueLabel="System" empty="" active={filters.os} onPick={(name) => onPick("os", name)} />
          </div>
        </Section>
        <Section title="Where visitors are" description="From each visitor's time zone, the only location the counter knows.">
          <BarList
            rows={report.zones.slice(0, 10).map((z) => ({ key: z.name, label: zoneLabel(z.name), value: z.count }))}
            valueLabel="Visitors"
            empty={`No visitors ${inPeriod(report.period)}.`}
            active={filters.zone}
            onPick={(name) => onPick("zone", name)}
          />
        </Section>
        {report.clicks.length > 0 && (
          <Section title="Contact clicks" description="Clicks on your phone number, email address, WhatsApp and links to other sites.">
            <BarList
              rows={report.clicks.map((c) => ({
                key: `${c.kind}:${c.target ?? ""}`,
                label: c.kind === "link" ? `${CLICK_KINDS.link} ${c.target ?? "another site"}` : CLICK_KINDS[c.kind],
                value: c.count,
              }))}
              valueLabel="Clicks"
              empty=""
            />
          </Section>
        )}
        {report.notFound.length > 0 && (
          <Section title="Missing pages people tried" description="Addresses visitors opened that your site doesn't have. They saw the “page not found” page.">
            <BarList
              rows={report.notFound.map((n) => ({
                key: n.path,
                label: (
                  <span>
                    <code className="font-mono">{n.path}</code>
                    {n.referrers.length > 0 && <span className="text-zinc-500"> · from {n.referrers.join(", ")}</span>}
                  </span>
                ),
                value: n.hits,
              }))}
              valueLabel="Visits"
              empty=""
            />
          </Section>
        )}
        {report.campaigns.length > 0 && (
          <Section title="Campaigns" description="Visits from links with utm_source, utm_medium or utm_campaign tags.">
            <BarList
              rows={report.campaigns.map((c) => ({
                key: `${c.source}|${c.medium}|${c.campaign}`,
                label: [c.campaign, c.source, c.medium].filter(Boolean).join(" · ") || "Untitled",
                value: c.count,
              }))}
              valueLabel="Visitors"
              empty=""
            />
          </Section>
        )}
      </div>

      {empty.length > 0 && (
        <p className="text-sm text-zinc-500">
          Nothing yet {inPeriod(report.period)} for {empty.length > 1 ? `${empty.slice(0, -1).join(", ")} or ${empty.at(-1)}` : empty[0]}.
        </p>
      )}
    </div>
  );
}

function PageLabel({ path, title }: { path: string; title: string | null }) {
  return title ? (
    <span>
      {title} <span className="font-mono text-xs text-zinc-500">{path}</span>
    </span>
  ) : (
    <code className="font-mono">{path}</code>
  );
}

/* ------------------------------------------------------------- suggestions */

type Suggestion = { id: string; text: ReactNode; actions: ReactNode };

function Suggestions({
  report,
  pages,
  pageByPath,
  claudeReady,
  locked,
  onEdit,
  onAsk,
  missingOnly = false,
}: {
  report: AnalyticsReport;
  pages: SitePageLite[];
  pageByPath: Map<string, SitePageLite>;
  claudeReady: boolean;
  locked: boolean;
  onEdit: (file: string) => void;
  onAsk: (text: string) => void;
  /** Only missing pages people keep trying: the rest needs more visitors to mean anything. */
  missingOnly?: boolean;
}) {
  const { owner, repo, setStatus, refresh } = useSite();
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const period = inPeriod(report.period);

  async function createAt(path: string) {
    setCreating(path);
    setError(null);
    try {
      // .html stays a file; anything else becomes a folder page, as the site's own links resolve.
      const made = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, "/pages/at"), { method: "POST", body: { url: path } });
      setStatus(made.status);
      await refresh();
      toast.success(
        <span>
          Page added at {path}, with placeholder text for now.{" "}
          <button type="button" className="font-medium underline" onClick={() => onEdit(made.file)}>
            Write it
          </button>
        </span>,
      );
    } catch (err) {
      setError(err);
    } finally {
      setCreating(null);
    }
  }

  const items: Suggestion[] = [];

  // Missing pages people keep trying: worth making, unless the site has one there now.
  for (const miss of report.notFound.filter((n) => n.hits >= 2 && !pageByPath.has(n.path)).slice(0, 3)) {
    items.push({
      id: `404:${miss.path}`,
      text: (
        <>
          <strong>{formatCount(miss.hits)} visits</strong> went to <code className="font-mono">{miss.path}</code>, which your site doesn&apos;t have.
          {miss.referrers.length > 0 && ` Some came from ${miss.referrers.join(", ")}.`} Make the page, or point the link that sends people there somewhere else.
        </>
      ),
      actions: (
        <>
          <Button className="px-2.5 py-1 text-xs" disabled={locked || creating !== null} onClick={() => void createAt(miss.path)}>
            {creating === miss.path ? "Adding…" : "Create this page"}
          </Button>
          {claudeReady && (
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={locked}
              onClick={() =>
                onAsk(
                  `Visitors keep opening ${miss.path} on my site, which doesn't exist (${miss.hits} visits ${period}${miss.referrers.length ? `, some from ${miss.referrers.join(", ")}` : ""}). Create it with create_page at exactly that address and write it from what the rest of my site says, in the site's look.`,
                )
              }
            >
              <span aria-hidden="true">✦</span> Create and write with the AI
            </Button>
          )}
        </>
      ),
    });
  }

  // The busiest page that most people leave from: worth a closer look.
  const busiest = report.pages[0];
  const busiestPage = busiest && pageByPath.get(busiest.path);
  if (!missingOnly && busiest && busiestPage && report.totals.visitors >= 20 && percent(report.totals.singlePage, report.totals.visitors) >= 60) {
    const name = busiest.path === "/" ? "Your homepage" : busiestPage.title;
    items.push({
      id: `busy:${busiest.path}`,
      text: (
        <>
          <strong>{name}</strong> is your most viewed page, and {percent(report.totals.singlePage, report.totals.visitors)}% of visitors leave after one page.
          A clearer next step on it (a button to contact you, or links to related pages) can keep more of them.
        </>
      ),
      actions: (
        <>
          <Button className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => onEdit(busiestPage.file)}>
            Edit page
          </Button>
          {claudeReady && (
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={locked}
              onClick={() =>
                onAsk(
                  `${name} (${busiestPage.file}) is my most viewed page, but ${percent(report.totals.singlePage, report.totals.visitors)}% of visitors leave after one page. Read it and read_analytics, then suggest and make changes that give visitors a clear next step.`,
                )
              }
            >
              <span aria-hidden="true">✦</span> Ask the AI to improve it
            </Button>
          )}
        </>
      ),
    });
  }

  // Most visitors on phones: the phone layout matters most.
  const visitorsOnDevices = report.devices.reduce((sum, d) => sum + d.count, 0);
  const phones = report.devices.find((d) => d.name === "Phone")?.count ?? 0;
  if (!missingOnly && visitorsOnDevices >= 20 && percent(phones, visitorsOnDevices) >= 50 && claudeReady) {
    items.push({
      id: "phones",
      text: (
        <>
          <strong>{percent(phones, visitorsOnDevices)}% of visitors</strong> use a phone. Check your busiest pages on a small screen first.
        </>
      ),
      actions: (
        <Button
          className="px-2.5 py-1 text-xs"
          disabled={locked}
          onClick={() =>
            onAsk(
              `Most of my visitors (${percent(phones, visitorsOnDevices)}%) use phones. Check read_analytics for my most viewed pages, read them, and fix anything that doesn't work well on a small screen.`,
            )
          }
        >
          <span aria-hidden="true">✦</span> Ask the AI to check them
        </Button>
      ),
    });
  }

  // Pages nobody opened. Only once the site has some traffic, so a new site isn't told off.
  const viewed = new Set(report.pages.map((p) => p.path));
  const unseen =
    !missingOnly && report.totals.pageviews >= 50 && report.pages.length < 50
      ? pages.filter((p) => !p.draft && p.url && p.url !== "/404.html" && !viewed.has(normalizedPath(p.url)))
      : [];
  if (unseen.length) {
    items.push({
      id: "unseen",
      text: (
        <>
          Nobody opened{" "}
          {unseen.length === 1 ? (
            <strong>{unseen[0].title}</strong>
          ) : (
            <>
              <strong>{unseen.length} of your pages</strong> ({unseen.slice(0, 3).map((p) => p.title).join(", ")}
              {unseen.length > 3 ? " and more" : ""})
            </>
          )}{" "}
          {period}. Link to {unseen.length === 1 ? "it" : "them"} from a page people do visit, or add {unseen.length === 1 ? "it" : "them"} to the menu on
          the Pages screen.
        </>
      ),
      actions: unseen.length === 1 && (
        <Button className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => onEdit(unseen[0].file)}>
          Open page
        </Button>
      ),
    });
  }

  if (!items.length) return null;
  return (
    <Section title="What to do next" description="Suggestions from your visits.">
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <span className="min-w-0 flex-1">{item.text}</span>
            {item.actions && <span className="flex flex-wrap gap-2">{item.actions}</span>}
          </li>
        ))}
      </ul>
      {error ? (
        <div className="mt-2">
          <ErrorText error={error} />
        </div>
      ) : null}
    </Section>
  );
}

/* ------------------------------------------------------------------ pieces */

type Change = { percent: number } | { points: number; lowerIsBetter?: boolean };

/** The change from `before` to `now` in percent, or null when there's nothing to compare. */
const change = (now: number, before: number): Change | null => (before > 0 ? { percent: Math.round(((now - before) / before) * 100) } : null);

function StatTile({ label, value, change: delta, note }: { label: string; value: string; change: Change | null; note?: string }) {
  let line: ReactNode = note ? <span className="text-zinc-500">{note}</span> : null;
  if (delta) {
    const amount = "percent" in delta ? delta.percent : delta.points;
    const lowerIsBetter = "points" in delta && delta.lowerIsBetter === true;
    const good = amount === 0 ? null : amount > 0 !== lowerIsBetter;
    line = (
      <span className={good === null ? "text-zinc-500" : good ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
        <span aria-hidden="true">{amount > 0 ? "▲ " : amount < 0 ? "▼ " : ""}</span>
        {amount === 0 ? "No change" : `${amount > 0 ? "Up" : "Down"} ${Math.abs(amount)}${"percent" in delta ? "%" : " points"}`}
      </span>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {line && <p className="mt-1 text-xs">{line}</p>}
    </div>
  );
}

/** Rows with a light bar behind each, as long as its share of the largest; clickable when `onPick` is set. */
function BarList({
  rows,
  valueLabel,
  empty,
  active,
  onPick,
}: {
  rows: { key: string; label: ReactNode; value: number }[];
  valueLabel: string;
  empty: string;
  active?: string;
  onPick?: (key: string) => void;
}) {
  if (!rows.length) return empty ? <p className="text-sm text-zinc-500">{empty}</p> : null;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="text-sm">
      <div className="mb-1 flex justify-end text-xs font-medium text-zinc-500">{valueLabel}</div>
      <ul className="space-y-1">
        {rows.map((row) => {
          const selected = active === row.key;
          const content = (
            <>
              <span
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 rounded ${selected ? "bg-sky-600/25 dark:bg-sky-400/30" : "bg-sky-600/10 dark:bg-sky-400/15"}`}
                style={{ width: `${(row.value / max) * 100}%` }}
              />
              <span className="relative min-w-0 truncate text-left">{row.label}</span>
              <span className="relative shrink-0 tabular-nums">{number.format(row.value)}</span>
            </>
          );
          const rowClass = "relative flex w-full items-center justify-between gap-3 overflow-hidden rounded px-2 py-1";
          return (
            <li key={row.key}>
              {onPick ? (
                <button
                  type="button"
                  onClick={() => onPick(row.key)}
                  aria-pressed={selected}
                  className={`${rowClass} hover:ring-1 hover:ring-zinc-300 dark:hover:ring-zinc-700 ${selected ? "font-medium ring-1 ring-sky-400" : ""}`}
                >
                  {content}
                </button>
              ) : (
                <div className={rowClass}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Rounds up to 1, 2 or 5 times a power of ten, so the axis has clean numbers. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * power >= value)!;
  return step * power;
}

/** What one bucket is called: "3 pm", "16 Oct", or "Week of 13 Oct". */
function bucketLabel(report: AnalyticsReport, i: number, long = false) {
  const point = report.series[i];
  if (report.unit === "hour") return hourLabel(point.hour ?? i);
  if (report.unit === "week") return `${long ? "Week of " : ""}${dayLabel(point.date, long)}`;
  return dayLabel(point.date, long);
}

/**
 * Visitors over the period: a column per hour (today) or day (7 and 30 days), a line per week for
 * longer periods. The latest value is labelled; hover shows any bucket; a table has them all.
 */
function VisitsChart({ report }: { report: AnalyticsReport }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = report.series;
  const n = series.length;
  // The report's own "now" (when it was made), so the chart stays the same between renders.
  const now = new Date(report.to).getTime();
  // Hours of today that haven't happened yet are left empty, not drawn as zero.
  const past = series.map((s) => new Date(s.start).getTime() <= now);
  const lastPast = past.lastIndexOf(true);
  const max = niceMax(Math.max(...series.map((d) => d.visitors), 0));
  const ticks = [0, max / 2, max];
  const height = 180;
  const y = (v: number) => 100 - (v / max) * 100;
  const shown = hover ?? lastPast;
  const point = shown >= 0 ? series[shown] : null;
  const columns = report.unit !== "week";

  // Axis labels: the first and last bucket, and the middle for longer runs (every 6 hours today).
  const axis = report.unit === "hour" ? [0, 6, 12, 18, 23] : n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];

  const tooltip = point && (
    <div
      className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-md border border-zinc-200 bg-background px-2.5 py-1.5 text-xs text-foreground shadow-sm dark:border-zinc-800"
      style={(shown / Math.max(1, n - 1)) * 100 > 60 ? { right: `${100 - ((shown + 0.5) / n) * 100}%` } : { left: `${((shown + 0.5) / n) * 100}%` }}
    >
      <p className="font-medium">{bucketLabel(report, shown, true)}</p>
      <p className="tabular-nums">
        {number.format(point.visitors)} {point.visitors === 1 ? "visitor" : "visitors"} · {number.format(point.pageviews)} page {point.pageviews === 1 ? "view" : "views"}
      </p>
    </div>
  );

  return (
    <div>
      <div className="flex gap-2 pt-12">
        <div className="relative w-10 shrink-0 text-right text-xs text-zinc-500 tabular-nums" style={{ height }} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
              {formatCount(t)}
            </span>
          ))}
        </div>
        <div
          className="relative min-w-0 flex-1 text-sky-600 dark:text-sky-400"
          style={{ height }}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`Visitors ${inPeriod(report.period)}, ${report.unit === "hour" ? "by hour" : report.unit === "week" ? "per week" : "per day"}; the table below has every value.`}
        >
          {ticks.map((t) => (
            <span key={t} aria-hidden="true" className="absolute inset-x-0 h-px bg-zinc-200 dark:bg-zinc-800" style={{ top: `${y(t)}%` }} />
          ))}

          {columns ? (
            <div className="absolute inset-0 flex items-end gap-0.5">
              {series.map((d, i) => (
                <div key={d.start} className="relative flex h-full min-w-0 flex-1 items-end justify-center" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                  {past[i] && d.visitors > 0 && (
                    <span
                      className={`block w-full max-w-6 rounded-t-sm bg-current ${hover !== null && hover !== i ? "opacity-50" : ""}`}
                      style={{ height: `${(d.visitors / max) * 100}%` }}
                    />
                  )}
                  {i === lastPast && hover === null && d.visitors > 0 && (
                    <span className="absolute text-xs font-medium text-foreground tabular-nums" style={{ bottom: `calc(${(d.visitors / max) * 100}% + 4px)` }}>
                      {number.format(d.visitors)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
                <path
                  d={`${series.map((d, i) => `${i ? "L" : "M"}${((i + 0.5) / n) * 100},${y(d.visitors)}`).join(" ")} L${((n - 0.5) / n) * 100},100 L${(0.5 / n) * 100},100 Z`}
                  fill="currentColor"
                  fillOpacity="0.1"
                />
                <path
                  d={series.map((d, i) => `${i ? "L" : "M"}${((i + 0.5) / n) * 100},${y(d.visitors)}`).join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {point && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-background"
                  style={{ left: `${((shown + 0.5) / n) * 100}%`, top: `${y(point.visitors)}%` }}
                />
              )}
              <div className="absolute inset-0 flex">
                {series.map((d, i) => (
                  <div key={d.start} className="h-full flex-1" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
                ))}
              </div>
            </>
          )}
          {hover !== null && tooltip}
          {hover === null && !columns && point && (
            <span
              className="pointer-events-none absolute -translate-x-1/2 text-xs font-medium text-foreground tabular-nums"
              style={{ left: `${((shown + 0.5) / n) * 100}%`, top: `calc(${y(point.visitors)}% - 22px)` }}
            >
              {number.format(point.visitors)}
            </span>
          )}
        </div>
      </div>
      <div className="relative mt-1 ml-12 h-4 text-xs text-zinc-500" aria-hidden="true">
        {axis.map((i) => (
          <span
            key={i}
            className={`absolute whitespace-nowrap ${i === 0 ? "" : i === n - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: i === 0 ? 0 : i === n - 1 ? "100%" : `${((i + 0.5) / n) * 100}%` }}
          >
            {bucketLabel(report, i)}
          </span>
        ))}
      </div>
      <div className="mt-3">
        <Details summary="Show as a table">
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">{report.unit === "hour" ? "Hour" : report.unit === "week" ? "Week" : "Day"}</th>
                  <th className="py-1 text-right font-medium">Visitors</th>
                  <th className="py-1 text-right font-medium">Page views</th>
                </tr>
              </thead>
              <tbody>
                {series
                  .map((d, i) => ({ d, i }))
                  .filter(({ i }) => past[i])
                  .reverse()
                  .map(({ d, i }) => (
                    <tr key={d.start} className="border-t border-zinc-100 dark:border-zinc-900">
                      <td className="py-1">{bucketLabel(report, i, true)}</td>
                      <td className="py-1 text-right">{number.format(d.visitors)}</td>
                      <td className="py-1 text-right">{number.format(d.pageviews)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Details>
      </div>
    </div>
  );
}
