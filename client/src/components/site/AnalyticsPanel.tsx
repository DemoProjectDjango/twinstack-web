"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { confirmModal } from "@/lib/confirm";
import { toast } from "@/lib/toast";
import {
  api,
  workspacePath,
  type AnalyticsReport,
  type AnalyticsSettings,
  type AnalyticsView,
  type WorkspaceStatus,
} from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
import { useSite } from "./site-context";
import { Button, Details, EmptyState, ErrorText, Notice, ScreenHeader, Section, Segmented, Spinner } from "./ui";

// The site's visits, for its creator only (server/src/analytics.js). Counting starts when the
// owner turns it on (the counter goes into site.config.json) and publishes. The numbers come with
// suggestions that lead straight to the editor's own tools: make a missing page people look for,
// open a page nobody visits, or ask Claude about the busiest one.

type Range = "7" | "30" | "90" | "365";
const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
];
const RANGE_KEY = "twinstack:analytics-range";

function readRange(): Range {
  try {
    const value = localStorage.getItem(RANGE_KEY);
    return RANGES.some((r) => r.value === value) ? (value as Range) : "30";
  } catch {
    return "30";
  }
}

const number = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const formatCount = (n: number) => (n >= 10_000 ? compact.format(n) : number.format(n));
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const dayLabel = (date: string, withYear = false) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(withYear && { year: "numeric" }), timeZone: "UTC" });

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

export function AnalyticsPanel() {
  const { owner, repo, overview, status, refresh, showSection, editFile, busy, claude } = useSite();
  const { send, turn } = useAssistant();
  const [range, setRange] = useState<Range>(readRange);
  const [view, setView] = useState<AnalyticsView | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The range the shown numbers are for: while it differs from `range`, new ones are loading.
  const [loadedRange, setLoadedRange] = useState<Range | null>(null);
  const loading = loadedRange !== range;
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<AnalyticsView>(workspacePath(owner, repo, `/analytics?range=${range}`))
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoadedRange(range));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, range]);

  function chooseRange(next: Range) {
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      // Private mode: remembered for this visit only.
    }
  }

  async function act(name: string, path: string, method: "POST" | "DELETE", done: string) {
    setWorking(name);
    setError(null);
    try {
      const result = await api<{ settings?: AnalyticsSettings; deleted?: number }>(workspacePath(owner, repo, `/analytics${path}`), { method, body: {} });
      if (result.settings) setView((v) => ({ settings: result.settings!, report: result.settings!.hasData ? (v?.report ?? null) : null }));
      if (result.deleted !== undefined) setView((v) => (v ? { settings: { ...v.settings, hasData: false }, report: null } : v));
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
  const unpublished = status.changes.some((c) => c.path === "site.config.json");
  const ignoreUrl = settings?.siteUrl ? `${settings.siteUrl}${settings.siteUrl.includes("?") ? "&" : "?"}${settings.ignoreParam}` : null;

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Analytics"
        description="How many people visit your published site, where they come from and what they look at. Only you can see this."
      >
        {settings?.enabled && settings.hasData && (
          <span className="flex items-center gap-2">
            {loading && <Spinner />}
            <Segmented label="Time period" value={range} options={RANGES} onChange={chooseRange} />
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

      {report && (
        <Report
          report={report}
          pages={overview?.collections.flatMap((c) => c.pages) ?? []}
          claudeReady={claude.ready && turn?.status !== "running"}
          locked={busy || working !== null}
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

/* ------------------------------------------------------------------ report */

type SitePageLite = { file: string; title: string; url?: string | null; draft: boolean };

/** A page's address the way the counter records it: /x/index.html is /x/. */
const normalizedPath = (url: string) => url.replace(/\/index\.html$/, "/");

function Report({
  report,
  pages,
  claudeReady,
  locked,
  onEdit,
  onAsk,
}: {
  report: AnalyticsReport;
  pages: SitePageLite[];
  claudeReady: boolean;
  locked: boolean;
  onEdit: (file: string) => void;
  onAsk: (text: string) => void;
}) {
  const { totals, previous } = report;
  const period = report.range === 365 ? "12 months" : `${report.range} days`;
  const pageByPath = useMemo(() => new Map(pages.filter((p) => p.url).map((p) => [normalizedPath(p.url!), p])), [pages]);
  const titleOf = (path: string) => pageByPath.get(path)?.title ?? null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Visitors" value={totals.visitors} before={previous.visitors} period={period} />
        <StatTile label="Page views" value={totals.pageviews} before={previous.pageviews} period={period} />
        <StatTile
          label="Pages per visitor"
          value={totals.visitors ? totals.pageviews / totals.visitors : 0}
          before={previous.visitors ? previous.pageviews / previous.visitors : 0}
          period={period}
          decimals
        />
        <StatTile
          label="Left after one page"
          value={percent(totals.singlePage, totals.visitors)}
          before={percent(previous.singlePage, previous.visitors)}
          period={period}
          suffix="%"
          lowerIsBetter
        />
      </div>

      <Section title="Visitors per day" description="A visitor is one person on one day, so someone who comes back tomorrow counts again.">
        <VisitsChart series={report.series} />
      </Section>

      <Suggestions report={report} pages={pages} pageByPath={pageByPath} claudeReady={claudeReady} locked={locked} onEdit={onEdit} onAsk={onAsk} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Pages" description="The pages people look at most.">
          <BarList
            rows={report.pages.slice(0, 12).map((p) => ({ key: p.path, label: <PageLabel path={p.path} title={titleOf(p.path)} />, value: p.pageviews }))}
            valueLabel="Views"
            empty="No page views in this period."
          />
        </Section>
        <Section title="Where visitors come from" description="The site or link that sent each visitor.">
          <BarList
            rows={report.sources.map((s) => ({
              key: `${s.channel}:${s.name}`,
              label: (
                <span>
                  {s.name === "Direct" ? "Direct" : s.name} <span className="text-zinc-500">· {CHANNELS[s.channel] ?? s.channel}</span>
                </span>
              ),
              value: s.count,
            }))}
            valueLabel="Visitors"
            empty="No visitors in this period."
          />
        </Section>
        <Section title="Where visitors arrive" description="The first page each visitor opens.">
          <BarList
            rows={report.entries.map((p) => ({ key: p.path, label: <PageLabel path={p.path} title={titleOf(p.path)} />, value: p.count }))}
            valueLabel="Visitors"
            empty="No visitors in this period."
          />
        </Section>
        <Section title="Devices" description="Phones are under 768 pixels wide, tablets under 1024.">
          <BarList rows={report.devices.map((d) => ({ key: d.name, label: d.name, value: d.count }))} valueLabel="Visitors" empty="No visitors in this period." />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <BarList rows={report.browsers.map((d) => ({ key: d.name, label: d.name, value: d.count }))} valueLabel="Browser" empty="" />
            <BarList rows={report.systems.map((d) => ({ key: d.name, label: d.name, value: d.count }))} valueLabel="System" empty="" />
          </div>
        </Section>
        <Section title="Where visitors are" description="From each visitor's time zone, the only location the counter knows.">
          <BarList
            rows={report.zones.slice(0, 10).map((z) => ({ key: z.name, label: zoneLabel(z.name), value: z.count }))}
            valueLabel="Visitors"
            empty="No visitors in this period."
          />
        </Section>
        <Section title="Contact clicks" description="Clicks on your phone number, email address, WhatsApp and links to other sites.">
          <BarList
            rows={report.clicks.map((c) => ({
              key: `${c.kind}:${c.target ?? ""}`,
              label: c.kind === "link" ? `${CLICK_KINDS.link} ${c.target ?? "another site"}` : CLICK_KINDS[c.kind],
              value: c.count,
            }))}
            valueLabel="Clicks"
            empty="No clicks on contact details or outside links in this period."
          />
        </Section>
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
            empty="Nobody hit a missing page in this period."
          />
        </Section>
      </div>
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
}: {
  report: AnalyticsReport;
  pages: SitePageLite[];
  pageByPath: Map<string, SitePageLite>;
  claudeReady: boolean;
  locked: boolean;
  onEdit: (file: string) => void;
  onAsk: (text: string) => void;
}) {
  const { owner, repo, setStatus, refresh } = useSite();
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const period = report.range === 365 ? "12 months" : `${report.range} days`;

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
                  `Visitors keep opening ${miss.path} on my site, which doesn't exist (${miss.hits} visits in the last ${period}${miss.referrers.length ? `, some from ${miss.referrers.join(", ")}` : ""}). Create it with create_page at exactly that address and write it from what the rest of my site says, in the site's look.`,
                )
              }
            >
              <span aria-hidden="true">✦</span> Create and write with Claude
            </Button>
          )}
        </>
      ),
    });
  }

  // The busiest page that most people leave from: worth a closer look.
  const busiest = report.pages[0];
  const busiestPage = busiest && pageByPath.get(busiest.path);
  if (busiest && busiestPage && report.totals.visitors >= 20 && percent(report.totals.singlePage, report.totals.visitors) >= 60) {
    items.push({
      id: `busy:${busiest.path}`,
      text: (
        <>
          <strong>{busiestPage.title}</strong> is your most viewed page, and {percent(report.totals.singlePage, report.totals.visitors)}% of visitors leave
          after one page. A clearer next step on it (a button to contact you, or links to related pages) can keep more of them.
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
                  `${busiestPage.title} (${busiestPage.file}) is my most viewed page, but ${percent(report.totals.singlePage, report.totals.visitors)}% of visitors leave after one page. Read it and read_analytics, then suggest and make changes that give visitors a clear next step.`,
                )
              }
            >
              <span aria-hidden="true">✦</span> Ask Claude to improve it
            </Button>
          )}
        </>
      ),
    });
  }

  // Most visitors on phones: the phone layout matters most.
  const visitorsOnDevices = report.devices.reduce((sum, d) => sum + d.count, 0);
  const phones = report.devices.find((d) => d.name === "Phone")?.count ?? 0;
  if (visitorsOnDevices >= 20 && percent(phones, visitorsOnDevices) >= 50 && claudeReady) {
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
          <span aria-hidden="true">✦</span> Ask Claude to check them
        </Button>
      ),
    });
  }

  // Pages nobody opened. Only once the site has some traffic, so a new site isn't told off.
  const viewed = new Set(report.pages.map((p) => p.path));
  const unseen =
    report.totals.pageviews >= 50 && report.pages.length < 50
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
          in the last {period}. Link to {unseen.length === 1 ? "it" : "them"} from a page people do visit, or add {unseen.length === 1 ? "it" : "them"} to
          the menu on the Pages screen.
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

function StatTile({
  label,
  value,
  before,
  period,
  decimals = false,
  suffix = "",
  lowerIsBetter = false,
}: {
  label: string;
  value: number;
  before: number;
  period: string;
  decimals?: boolean;
  suffix?: string;
  lowerIsBetter?: boolean;
}) {
  const shown = decimals ? value.toFixed(1) : `${formatCount(value)}${suffix}`;
  let delta: ReactNode = <span className="text-zinc-500">Nothing to compare with yet</span>;
  if (before > 0) {
    const change = suffix === "%" ? Math.round(value - before) : Math.round(((value - before) / before) * 100);
    const unit = suffix === "%" ? " points" : "%";
    const good = change === 0 ? null : change > 0 !== lowerIsBetter;
    delta = (
      <span className={good === null ? "text-zinc-500" : good ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
        <span aria-hidden="true">{change > 0 ? "▲ " : change < 0 ? "▼ " : ""}</span>
        {change === 0 ? "No change" : `${change > 0 ? "Up" : "Down"} ${Math.abs(change)}${unit}`}
        <span className="text-zinc-500"> on the {period} before</span>
      </span>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{shown}</p>
      <p className="mt-1 text-xs">{delta}</p>
    </div>
  );
}

/** Rows with a light bar behind each, as long as its share of the largest. */
function BarList({ rows, valueLabel, empty }: { rows: { key: string; label: ReactNode; value: number }[]; valueLabel: string; empty: string }) {
  if (!rows.length) return empty ? <p className="text-sm text-zinc-500">{empty}</p> : null;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="text-sm">
      <div className="mb-1 flex justify-end text-xs font-medium text-zinc-500">{valueLabel}</div>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.key} className="relative flex items-center justify-between gap-3 overflow-hidden rounded px-2 py-1">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded bg-sky-600/10 dark:bg-sky-400/15" style={{ width: `${(row.value / max) * 100}%` }} />
            <span className="relative min-w-0 truncate">{row.label}</span>
            <span className="relative shrink-0 tabular-nums">{number.format(row.value)}</span>
          </li>
        ))}
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

/** Visitors per day: a line with a light wash beneath, a crosshair and a tooltip on hover. */
function VisitsChart({ series }: { series: AnalyticsReport["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const height = 180;
  const max = niceMax(Math.max(...series.map((d) => d.visitors), 0));
  const ticks = [0, max / 2, max];
  const n = series.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - (v / max) * 100;
  const line = series.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.visitors)}`).join(" ");
  const area = `${line} L${x(n - 1)},100 L${x(0)},100 Z`;
  const point = hover !== null ? series[hover] : null;

  function onMove(event: PointerEvent<HTMLDivElement>) {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !n) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (n - 1)));
  }

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative w-10 shrink-0 text-right text-xs text-zinc-500 tabular-nums" style={{ height }} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
              {formatCount(t)}
            </span>
          ))}
        </div>
        <div
          ref={box}
          className="relative min-w-0 flex-1 touch-none text-sky-600 dark:text-sky-400"
          style={{ height }}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`Visitors per day from ${dayLabel(series[0].date)} to ${dayLabel(series[n - 1].date)}; the table below has every day.`}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            {ticks.map((t) => (
              <line key={t} x1="0" x2="100" y1={y(t)} y2={y(t)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            <path d={area} fill="currentColor" fillOpacity="0.1" />
            <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {point && hover !== null && (
            <>
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-zinc-400 dark:bg-zinc-600" style={{ left: `${x(hover)}%` }} />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-background"
                style={{ left: `${x(hover)}%`, top: `${y(point.visitors)}%` }}
              />
              <div
                className="pointer-events-none absolute top-0 z-10 rounded-md border border-zinc-200 bg-background px-2.5 py-1.5 text-xs text-foreground shadow-sm dark:border-zinc-800"
                style={x(hover) > 60 ? { right: `${100 - x(hover)}%`, marginRight: 8 } : { left: `${x(hover)}%`, marginLeft: 8 }}
              >
                <p className="font-medium">{dayLabel(point.date, true)}</p>
                <p className="tabular-nums">
                  {number.format(point.visitors)} visitors · {number.format(point.pageviews)} page views
                </p>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-1 flex justify-between pl-12 text-xs text-zinc-500" aria-hidden="true">
        <span>{dayLabel(series[0].date)}</span>
        <span>{dayLabel(series[n - 1].date)}</span>
      </div>
      <div className="mt-3">
        <Details summary="Show as a table">
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">Day</th>
                  <th className="py-1 text-right font-medium">Visitors</th>
                  <th className="py-1 text-right font-medium">Page views</th>
                </tr>
              </thead>
              <tbody>
                {[...series].reverse().map((d) => (
                  <tr key={d.date} className="border-t border-zinc-100 dark:border-zinc-900">
                    <td className="py-1">{dayLabel(d.date, true)}</td>
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
