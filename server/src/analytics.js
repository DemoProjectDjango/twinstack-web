import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import {
  ANALYTICS_RETENTION_DAYS,
  aggregateAnalytics,
  analyticsSaltFor,
  deleteAnalyticsEvents,
  findSiteAnalytics,
  findSiteByAnalyticsKey,
  hasAnalyticsEvents,
  insertAnalyticsEvents,
  updateSiteAnalytics,
} from "./db.js";
import { getPublishedHosts } from "./publishing.js";
import { DAY, HOUR, addDays, dayStartOf, localDate, offsetAt, startOfDay, zoneOf } from "./zoned-days.js";
import { WorkspaceError, acquire, workspaceDir } from "./workspace.js";

// Visit counting for published sites, seen only by the site's creator.
//
// The template's assets/js/analytics.js (loaded by base.html when site.config.json → analytics has
// a key) posts each page view and outside-link click to POST /api/collect/<key> as text/plain JSON:
//   { t: "pageview", p: path, nf: true on the 404 page, r: referrer host, us/um/uc: utm_source,
//     utm_medium, utm_campaign, w: window width, tz: time zone }
//   { t: "click", p: path, k: "phone" | "email" | "whatsapp" | "link", h: host for a link }
// Keep those fields in step with the template.
//
// Nothing identifies a visitor: no cookies, and the IP address is only hashed, with the site and
// the browser, under a random salt that's replaced every day and deleted after two (db.js). So a
// visitor is the same visitor for one UTC day, and the dashboard's "visitors" adds up daily ones.
// Visits are kept for ANALYTICS_RETENTION_DAYS (a TTL index).
//
// The collector answers 204 whatever happens, so it tells nobody whether a key exists, and it
// never returns data. Only visits from the hosts the site is published at count (the browser's
// Origin, else Referer); that's a filter against stray traffic, not a lock.

export const ANALYTICS_MARKER = "site.analytics.key";
const CONFIG_FILE = "site.config.json";
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|prerender|monitor|uptime|curl|wget|python|axios|node-fetch|go-http|java\/|httpclient|facebookexternalhit|embedly|quora link|whatsapp\//i;

/* --------------------------------------------------------------- collecting */

const RATE_LIMIT = 120; // events per IP per minute
const rates = new Map();
const keyCache = new Map(); // key → { site, until }
const KEY_CACHE_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, rate] of rates) if (rate.resetAt <= now) rates.delete(ip);
  for (const [key, entry] of keyCache) if (entry.until <= now) keyCache.delete(key);
}, 60_000).unref();

function limited(ip) {
  const now = Date.now();
  const rate = rates.get(ip);
  if (!rate || rate.resetAt <= now) {
    rates.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  rate.count += 1;
  return rate.count > RATE_LIMIT;
}

async function siteForKey(key) {
  const cached = keyCache.get(key);
  if (cached && cached.until > Date.now()) return cached.site;
  const site = await findSiteByAnalyticsKey(key);
  keyCache.set(key, { site, until: Date.now() + KEY_CACHE_MS });
  return site;
}

const forgetKey = (key) => key && keyCache.delete(key);

function requestHost(req) {
  for (const header of [req.get("origin"), req.get("referer")]) {
    if (!header || header === "null") continue;
    try {
      return new URL(header).hostname.toLowerCase();
    } catch {
      // Try the next one.
    }
  }
  return null;
}

const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const hostName = (value) => {
  const host = text(value, 253)?.toLowerCase();
  return host && /^[a-z0-9.-]+$/.test(host) ? host.replace(/^www\./, "") : null;
};

function sitePath(value) {
  const p = text(value, 300);
  if (!p || !p.startsWith("/")) return null;
  // "/index.html" is the homepage and "/x/index.html" the page at /x/: one page, counted as one.
  return p.split(/[?#]/)[0].replace(/(^|\/)index\.html$/i, "$1") || "/";
}

function device(width) {
  if (!Number.isFinite(width) || width <= 0) return "Unknown";
  return width < 768 ? "Phone" : width < 1024 ? "Tablet" : "Desktop";
}

function browserOf(ua) {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS/.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS/.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Other";
}

function systemOf(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

// Where a visit came from, by the referring site's host. Unknown hosts are shown as they are.
const SOURCES = [
  [/(^|\.)google\.[a-z.]+$/, "Google", "search"],
  [/(^|\.)bing\.com$/, "Bing", "search"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo", "search"],
  [/(^|\.)yahoo\.[a-z.]+$/, "Yahoo", "search"],
  [/(^|\.)yandex\.[a-z.]+$/, "Yandex", "search"],
  [/(^|\.)baidu\.com$/, "Baidu", "search"],
  [/(^|\.)ecosia\.org$/, "Ecosia", "search"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook", "social"],
  [/(^|\.)instagram\.com$/, "Instagram", "social"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "X (Twitter)", "social"],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, "LinkedIn", "social"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube", "social"],
  [/(^|\.)reddit\.com$/, "Reddit", "social"],
  [/(^|\.)pinterest\.[a-z.]+$/, "Pinterest", "social"],
  [/(^|\.)tiktok\.com$/, "TikTok", "social"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "WhatsApp", "social"],
  [/(^|\.)(chatgpt\.com|openai\.com)$/, "ChatGPT", "ai"],
  [/(^|\.)perplexity\.ai$/, "Perplexity", "ai"],
  [/(^|\.)claude\.ai$/, "Claude", "ai"],
  [/(^|\.)gemini\.google\.com$/, "Gemini", "ai"],
  [/(^|\.)github\.com$/, "GitHub", "other"],
];

function sourceOf(referrer, utmSource) {
  if (utmSource) return { source: utmSource.toLowerCase(), channel: "campaign" };
  if (!referrer) return { source: "Direct", channel: "direct" };
  for (const [pattern, name, channel] of SOURCES) if (pattern.test(referrer)) return { source: name, channel };
  return { source: referrer, channel: "other" };
}

const utcDay = (date) => date.toISOString().slice(0, 10);

/** The event to store for one posted visit, or null to drop it. */
export async function eventFor({ site, body, ip, ua, now = new Date() }) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const pathname = sitePath(data.p);
  if (!pathname) return null;

  const salt = await analyticsSaltFor(utcDay(now));
  const visitor = createHash("sha256").update(`${salt}|${site.siteId}|${ip}|${ua}`).digest("hex").slice(0, 20);
  const base = { siteId: site.siteId, at: now, path: pathname, visitor };

  if (data.t === "click") {
    const kind = ["phone", "email", "whatsapp", "link"].includes(data.k) ? data.k : null;
    if (!kind) return null;
    return { ...base, type: "click", kind, ...(kind === "link" && { target: hostName(data.h) }) };
  }
  if (data.t !== "pageview") return null;

  const referrer = hostName(data.r);
  const utm = { source: text(data.us, 100), medium: text(data.um, 100), campaign: text(data.uc, 100) };
  const zone = text(data.tz, 64);
  return {
    ...base,
    type: "pageview",
    notFound: data.nf === true,
    referrer,
    ...sourceOf(referrer, utm.source),
    ...(utm.source || utm.medium || utm.campaign ? { utm } : {}),
    device: device(Number(data.w)),
    browser: browserOf(ua),
    os: systemOf(ua),
    zone: zone && /^[A-Za-z0-9_+\-/]+$/.test(zone) ? zone : null,
  };
}

/** POST /api/collect/:key. Always 204. */
export async function collect(req, res) {
  res.status(204).end();
  try {
    const key = req.params.key;
    const ua = req.get("user-agent") ?? "";
    if (!KEY.test(key ?? "") || typeof req.body !== "string" || !ua || BOT.test(ua)) return;
    const ip = req.ip ?? "";
    if (limited(ip)) return;
    const site = await siteForKey(key);
    if (!site?.enabled) return;
    const host = requestHost(req);
    if (!host || !site.hosts.includes(host)) return;
    const event = await eventFor({ site, body: req.body, ip, ua });
    if (event) await insertAnalyticsEvents([event]);
  } catch (err) {
    console.error("Recording a visit failed:", err.message);
  }
}

/* ------------------------------------------------------------ the owner */

/**
 * The site's analytics record, for its creator only. Anyone else gets the same 404 as a site with
 * no analytics, so they can't even tell it's there.
 */
export async function ownedSite(siteId, userId) {
  const site = await findSiteAnalytics(siteId);
  if (!site || !site.userId || site.userId !== userId) throw new WorkspaceError("Not found.", 404);
  return site;
}

/** Whether this user created the site (the Analytics screen is shown only then). */
export async function isSiteCreator(siteId, userId) {
  const site = await findSiteAnalytics(siteId).catch(() => null);
  return Boolean(site?.userId && site.userId === userId);
}

async function readConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (raw === null) throw new WorkspaceError(`${CONFIG_FILE} doesn't exist.`, 404);
  try {
    return { file, raw, data: JSON.parse(raw) };
  } catch {
    throw new WorkspaceError(`${CONFIG_FILE} isn't valid JSON. Fix it first.`, 409);
  }
}

/** Sets or removes (null) site.config.json → analytics in the working copy, keeping everything else. */
async function writeConfigAnalytics(key, value) {
  const release = acquire(key, `saving ${CONFIG_FILE}`);
  try {
    const { file, raw, data } = await readConfig(workspaceDir(key));
    if (value) data.analytics = value;
    else if ("analytics" in data) delete data.analytics;
    else return;
    const newline = raw.includes("\r\n") ? "\r\n" : "\n";
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`.replace(/\n/g, newline));
  } finally {
    release();
  }
}

async function supportsAnalytics(dir) {
  const base = await fs.readFile(path.join(dir, "templates/partials/base.html"), "utf8").catch(() => "");
  return base.includes(ANALYTICS_MARKER);
}

const HOSTS_REFRESH_MS = 10 * 60_000;
const collectUrl = () => `${config.publicApiUrl}/api/collect`;

/** Keeps `hosts` in step with where the site is published (a custom domain added later, say). */
async function refreshHosts(siteId, site, accessToken) {
  const analytics = site.analytics;
  if (!analytics?.enabled) return analytics;
  const checked = analytics.hostsCheckedAt ? new Date(analytics.hostsCheckedAt).getTime() : 0;
  if (Date.now() - checked < HOSTS_REFRESH_MS) return analytics;
  const published = await getPublishedHosts(accessToken, site.fullName).catch(() => null);
  if (!published?.hosts.length) return analytics;
  await updateSiteAnalytics(siteId, { hosts: published.hosts, url: published.url, hostsCheckedAt: new Date() });
  forgetKey(analytics.key);
  return { ...analytics, hosts: published.hosts, url: published.url };
}

/** The settings part of the Analytics screen. */
export async function analyticsSettings({ key, siteId, userId, accessToken }) {
  const site = await ownedSite(siteId, userId);
  const dir = workspaceDir(key);
  const analytics = await refreshHosts(siteId, site, accessToken);
  const { data } = await readConfig(dir).catch(() => ({ data: {} }));
  const enabled = analytics?.enabled === true;
  return {
    supported: await supportsAnalytics(dir),
    enabled,
    // The working copy has the counter's settings; once published, the live pages count visits.
    configured: enabled && data.analytics?.key === analytics.key,
    // Its address isn't this server's (PUBLIC_API_URL changed since): enabling again rewrites it.
    endpointChanged: enabled && data.analytics?.key === analytics.key && data.analytics?.endpoint !== collectUrl(),
    endpoint: collectUrl(),
    // PUBLIC_API_URL isn't set, so published pages would send their visits to localhost.
    localEndpoint: !config.publicApiUrlSet,
    hosts: analytics?.hosts ?? [],
    hasData: Boolean(analytics?.key) && (await hasAnalyticsEvents(siteId)),
    retentionDays: ANALYTICS_RETENTION_DAYS,
    // Opening the site with this once stops counting that browser's visits.
    ignoreParam: "twinstack-analytics=off",
    siteUrl: analytics?.url ?? null,
  };
}

/**
 * Turns counting on: a key for the site, its published hosts, and the counter in site.config.json.
 * Run again while on, it keeps the key and rewrites the counter with this server's current address.
 */
export async function enableAnalytics({ key, siteId, userId, accessToken }) {
  const site = await ownedSite(siteId, userId);
  if (!(await supportsAnalytics(workspaceDir(key)))) {
    throw new WorkspaceError("This site needs the latest site update before it can count visits.", 409);
  }
  const analyticsKey = site.analytics?.key ?? randomBytes(18).toString("base64url");
  const { url, hosts } = await getPublishedHosts(accessToken, site.fullName);
  await writeConfigAnalytics(key, { endpoint: collectUrl(), key: analyticsKey });
  await updateSiteAnalytics(siteId, { key: analyticsKey, enabled: true, hosts, url, hostsCheckedAt: new Date() });
  forgetKey(analyticsKey);
  return analyticsSettings({ key, siteId, userId, accessToken });
}

/** Stops counting now (visits are dropped) and takes the counter out of site.config.json. */
export async function disableAnalytics({ key, siteId, userId, accessToken }) {
  const site = await ownedSite(siteId, userId);
  await updateSiteAnalytics(siteId, { enabled: false });
  forgetKey(site.analytics?.key);
  await writeConfigAnalytics(key, null);
  return analyticsSettings({ key, siteId, userId, accessToken });
}

export async function deleteAnalyticsData({ siteId, userId }) {
  await ownedSite(siteId, userId);
  return { deleted: await deleteAnalyticsEvents(siteId) };
}

/* ---------------------------------------------------------------- reports */

// Days and weeks are the owner's own (their browser's time zone, `tz`), so "today" starts at their
// midnight (see periodOf for the ranges).
const TOP = 20;
const MAX_FILTERED_VISITORS = 200_000;

// The ranges the dashboard offers. "custom" takes `from` and `to` (local dates, both included).
export const PRESETS = ["today", "yesterday", "7", "30", "90", "365", "month", "lastmonth", "custom"];
const MAX_DAYS = 366;

/**
 * The period a report covers, in the owner's zone: `from` (inclusive) to `to` (exclusive, never
 * after now), the buckets it's shown in, and the period before it of the same length. One day is
 * shown by hour, up to 62 days by day, anything longer by week (Monday first).
 */
function periodOf({ range, from: fromDate, to: toDate } = {}, zone, now = Date.now()) {
  const today = startOfDay(zone, now);
  const tomorrow = addDays(zone, today, 1);
  // "1" was today before presets had names.
  const preset = range === "1" ? "today" : PRESETS.includes(range) ? range : "30";
  let start;
  let end;
  if (preset === "today") [start, end] = [today, tomorrow];
  else if (preset === "yesterday") [start, end] = [addDays(zone, today, -1), today];
  else if (preset === "month" || preset === "lastmonth") {
    const thisMonth = dayStartOf(zone, `${localDate(zone, today).slice(0, 7)}-01`);
    start = preset === "month" ? thisMonth : dayStartOf(zone, `${localDate(zone, thisMonth - DAY).slice(0, 7)}-01`);
    end = preset === "month" ? tomorrow : thisMonth;
  } else if (preset === "custom") {
    start = dayStartOf(zone, fromDate);
    const last = dayStartOf(zone, toDate);
    if (start === null || last === null) throw new WorkspaceError("Choose a start and an end date.", 400);
    if (start > last) throw new WorkspaceError("The start date must be on or before the end date.", 400);
    if (last > today) throw new WorkspaceError("The end date can't be after today.", 400);
    end = addDays(zone, last, 1);
  } else {
    start = addDays(zone, today, -(Number(preset) - 1));
    end = tomorrow;
  }

  const days = Math.round((end - start) / DAY);
  if (days > MAX_DAYS) throw new WorkspaceError(`Choose at most ${MAX_DAYS} days.`, 400);
  const to = Math.min(end, now);
  // Today is compared with yesterday up to the same time; anything else with the same number of days before it.
  const previous = days === 1 && end > now ? { previousFrom: start - DAY, previousTo: now - DAY } : { previousFrom: addDays(zone, start, -days), previousTo: start };
  const info = { preset, days, first: localDate(zone, start), last: localDate(zone, end - 1), current: end > now };

  if (days === 1) {
    const buckets = Array.from({ length: 24 }, (_, h) => start + h * HOUR);
    return { unit: "hour", from: start, to, ...previous, buckets, info };
  }
  if (days <= 62) {
    return { unit: "day", from: start, to, ...previous, buckets: Array.from({ length: days }, (_, i) => addDays(zone, start, i)), info };
  }
  // Weeks start on Monday: the first one may begin before the period does.
  const weekday = (new Date(start + offsetAt(zone, start)).getUTCDay() + 6) % 7;
  const buckets = [];
  for (let week = addDays(zone, start, -weekday); week < to; week = addDays(zone, week, 7)) buckets.push(week);
  return { unit: "week", from: start, to, ...previous, buckets, info };
}

const FILTER_FIELDS = ["page", "source", "device", "browser", "os", "zone"];

/** The dashboard's filters from a query: { page: "/about.html", source: "Google", … }. */
export function filtersOf(query = {}) {
  const filters = {};
  for (const field of FILTER_FIELDS) {
    const value = typeof query[field] === "string" ? query[field].trim().slice(0, 300) : "";
    if (value) filters[field] = value;
  }
  return filters;
}

const top = (by, value, limit = TOP) => [
  { $group: { _id: by, value } },
  { $sort: { value: -1, _id: 1 } },
  { $limit: limit },
];

// One row per visitor (a visitor is one person on one day): where they came in, and how. Page
// views after the first have no outside referrer, so where a visitor came from is their first one's.
const ENTRIES = [
  { $sort: { at: 1 } },
  {
    $group: {
      _id: "$visitor",
      path: { $first: "$path" },
      source: { $first: "$source" },
      channel: { $first: "$channel" },
      utm: { $first: "$utm" },
      device: { $first: "$device" },
      browser: { $first: "$browser" },
      os: { $first: "$os" },
      zone: { $first: "$zone" },
      paths: { $addToSet: "$path" },
      pageviews: { $sum: 1 },
    },
  },
];

const VIEWS = { $match: { type: "pageview", notFound: { $ne: true } } };
const rows = (list, name = "name") => list.map((row) => ({ [name]: row._id ?? "Unknown", count: row.value }));

/**
 * The visitors the filters pick (null: no filters, so everyone): those who opened `page`, and
 * whose visit came from `source`, on that `device`, `browser`, `os` and `zone`. Every part of the
 * report is then about those visitors only.
 */
async function filteredVisitors(siteId, from, to, filters) {
  if (!Object.keys(filters).length) return null;
  const match = {};
  if (filters.page) match.paths = filters.page;
  for (const field of ["source", "device", "browser", "os", "zone"]) {
    if (filters[field]) match[field] = filters[field] === "Unknown" ? null : filters[field];
  }
  const list = await aggregateAnalytics(siteId, from, to, [VIEWS, ...ENTRIES, { $match: match }, { $limit: MAX_FILTERED_VISITORS }, { $project: { _id: 1 } }]);
  return list.map((row) => row._id);
}

const onlyVisitors = (visitors) => (visitors ? [{ $match: { visitor: { $in: visitors } } }] : []);

async function totals(siteId, from, to, visitors) {
  const [row] = await aggregateAnalytics(siteId, from, to, [
    ...onlyVisitors(visitors),
    VIEWS,
    { $group: { _id: "$visitor", pageviews: { $sum: 1 } } },
    { $group: { _id: null, visitors: { $sum: 1 }, pageviews: { $sum: "$pageviews" }, single: { $sum: { $cond: [{ $eq: ["$pageviews", 1] }, 1, 0] } } } },
  ]);
  return {
    visitors: row?.visitors ?? 0,
    pageviews: row?.pageviews ?? 0,
    // Visitors who saw one page and left.
    singlePage: row?.single ?? 0,
  };
}

/**
 * The dashboard for `span` ({ range: a PRESETS id, from, to } for "custom") in the owner's time zone
 * `tz`, with the period before it for comparison, narrowed to the visitors `filters` pick.
 */
export async function analyticsReport({ siteId, userId, span = {}, tz, filters = {} }) {
  await ownedSite(siteId, userId);
  const zone = zoneOf(tz);
  const period = periodOf(span, zone);
  const from = new Date(period.from);
  const to = new Date(period.to);
  const previousFrom = new Date(period.previousFrom);
  const previousTo = new Date(period.previousTo);
  const [visitors, previousVisitors] = await Promise.all([
    filteredVisitors(siteId, from, to, filters),
    filteredVisitors(siteId, previousFrom, previousTo, filters),
  ]);

  const views = VIEWS;
  const [[facets], current, previous] = await Promise.all([
    aggregateAnalytics(siteId, from, to, [
      ...onlyVisitors(visitors),
      {
        $facet: {
          series: [
            views,
            {
              $group: {
                _id: { $dateTrunc: { date: "$at", unit: period.unit, timezone: zone, ...(period.unit === "week" && { startOfWeek: "monday" }) } },
                pageviews: { $sum: 1 },
                visitors: { $addToSet: "$visitor" },
              },
            },
            { $project: { pageviews: 1, visitors: { $size: "$visitors" } } },
          ],
          pages: [
            views,
            { $group: { _id: "$path", pageviews: { $sum: 1 }, visitors: { $addToSet: "$visitor" } } },
            { $project: { pageviews: 1, visitors: { $size: "$visitors" } } },
            { $sort: { pageviews: -1, _id: 1 } },
            { $limit: 50 },
          ],
          entries: [views, ...ENTRIES, ...top("$path", { $sum: 1 })],
          sources: [views, ...ENTRIES, ...top({ source: "$source", channel: "$channel" }, { $sum: 1 })],
          campaigns: [
            views,
            ...ENTRIES,
            { $match: { utm: { $type: "object" } } },
            ...top({ source: "$utm.source", medium: "$utm.medium", campaign: "$utm.campaign" }, { $sum: 1 }),
          ],
          devices: [views, ...ENTRIES, ...top("$device", { $sum: 1 }, 5)],
          browsers: [views, ...ENTRIES, ...top("$browser", { $sum: 1 }, 10)],
          systems: [views, ...ENTRIES, ...top("$os", { $sum: 1 }, 10)],
          zones: [views, ...ENTRIES, ...top("$zone", { $sum: 1 })],
          notFound: [
            { $match: { type: "pageview", notFound: true } },
            { $group: { _id: "$path", value: { $sum: 1 }, last: { $max: "$at" }, referrers: { $addToSet: "$referrer" } } },
            { $sort: { value: -1, _id: 1 } },
            { $limit: TOP },
          ],
          clicks: [{ $match: { type: "click" } }, ...top({ kind: "$kind", target: "$target" }, { $sum: 1 })],
          clicksByPage: [{ $match: { type: "click" } }, ...top("$path", { $sum: 1 }, 50)],
        },
      },
    ]),
    totals(siteId, from, to, visitors),
    totals(siteId, previousFrom, previousTo, previousVisitors),
  ]);

  // Every bucket in the range (hour, day or week), with the empty ones.
  const byStart = new Map(facets.series.map((bucket) => [new Date(bucket._id).getTime(), bucket]));
  const series = period.buckets.map((start, i) => {
    const bucket = byStart.get(start);
    return {
      start: new Date(start).toISOString(),
      date: localDate(zone, start),
      ...(period.unit === "hour" && { hour: i }),
      visitors: bucket?.visitors ?? 0,
      pageviews: bucket?.pageviews ?? 0,
    };
  });

  const clicksByPage = new Map(facets.clicksByPage.map((row) => [row._id, row.value]));
  return {
    // The preset, how many days, the first and last day (local dates), and whether it runs to now.
    period: period.info,
    unit: period.unit,
    zone,
    filters,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: current,
    previous,
    series,
    pages: facets.pages.map((row) => ({ path: row._id, pageviews: row.pageviews, visitors: row.visitors, clicks: clicksByPage.get(row._id) ?? 0 })),
    entries: rows(facets.entries, "path"),
    sources: facets.sources.map((row) => ({ name: row._id.source ?? "Direct", channel: row._id.channel ?? "direct", count: row.value })),
    campaigns: facets.campaigns.map((row) => ({ ...row._id, count: row.value })),
    devices: rows(facets.devices),
    browsers: rows(facets.browsers),
    systems: rows(facets.systems),
    zones: rows(facets.zones),
    notFound: facets.notFound.map((row) => ({
      path: row._id,
      hits: row.value,
      last: row.last,
      referrers: row.referrers.filter(Boolean).slice(0, 5),
    })),
    clicks: facets.clicks.map((row) => ({ kind: row._id.kind, target: row._id.target ?? null, count: row.value })),
  };
}

const LIVE_WINDOW = 30 * 60 * 1000;

/** Who's on the site now: visitors and page views in the last 30 minutes, and the latest visit. */
export async function analyticsLive({ siteId, userId }) {
  await ownedSite(siteId, userId);
  const now = new Date();
  const [[recent], [last]] = await Promise.all([
    aggregateAnalytics(siteId, new Date(now.getTime() - LIVE_WINDOW), now, [
      VIEWS,
      { $group: { _id: null, pageviews: { $sum: 1 }, visitors: { $addToSet: "$visitor" } } },
      { $project: { pageviews: 1, visitors: { $size: "$visitors" } } },
    ]),
    aggregateAnalytics(siteId, new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * DAY), now, [
      { $match: { type: "pageview" } },
      { $sort: { at: -1 } },
      { $limit: 1 },
      { $project: { _id: 0, at: 1, path: 1, notFound: 1 } },
    ]),
  ]);
  return {
    minutes: LIVE_WINDOW / 60_000,
    visitors: recent?.visitors ?? 0,
    pageviews: recent?.pageviews ?? 0,
    last: last ? { at: last.at, path: last.path, notFound: last.notFound === true } : null,
  };
}

const MAX_EXPORT_ROWS = 200_000;

/**
 * Every page view and click of the period (with the filters), oldest first, one plain row each
 * with nothing that tells visitors apart: for the full-report downloads (analytics-export.js).
 * `truncated` says the period had more than MAX_EXPORT_ROWS.
 */
export async function analyticsVisits({ siteId, userId, span = {}, tz, filters = {} }) {
  await ownedSite(siteId, userId);
  const period = periodOf(span, zoneOf(tz));
  const from = new Date(period.from);
  const to = new Date(period.to);
  const visitors = await filteredVisitors(siteId, from, to, filters);
  const events = await aggregateAnalytics(siteId, from, to, [
    ...onlyVisitors(visitors),
    { $sort: { at: 1 } },
    { $limit: MAX_EXPORT_ROWS + 1 },
    { $project: { _id: 0, siteId: 0, visitor: 0 } },
  ]);
  const rows = events.slice(0, MAX_EXPORT_ROWS).map((e) => ({
    time: e.at.toISOString(),
    type: e.type,
    page: e.path,
    missingPage: e.notFound === true,
    source: e.source ?? null,
    channel: e.channel ?? null,
    referrer: e.referrer ?? null,
    utmSource: e.utm?.source ?? null,
    utmMedium: e.utm?.medium ?? null,
    utmCampaign: e.utm?.campaign ?? null,
    device: e.device ?? null,
    browser: e.browser ?? null,
    system: e.os ?? null,
    timeZone: e.zone ?? null,
    click: e.kind ?? null,
    clickTarget: e.target ?? null,
  }));
  return { rows, truncated: events.length > MAX_EXPORT_ROWS };
}

/** A short plain-text summary of the last 30 days, for "Ask Claude" (read_analytics). */
export async function analyticsSummary({ siteId, userId, days = 30 }) {
  const site = await ownedSite(siteId, userId);
  if (!site.analytics?.key) return "Visit counting isn't turned on for this site (the owner can turn it on on the Analytics screen).";
  const report = await analyticsReport({ siteId, userId, span: { range: Number(days) === 1 ? "today" : String(days) } });
  const list = (items, show) => (items.length ? items.slice(0, 10).map(show).join("\n") : "  (none)");
  return [
    `Visits ${report.period.days === 1 ? "today (UTC)" : `in the last ${report.period.days} days`} (a visitor is one person on one day; the period before in brackets):`,
    `  visitors ${report.totals.visitors} (${report.previous.visitors}), page views ${report.totals.pageviews} (${report.previous.pageviews}), saw only one page ${report.totals.singlePage}`,
    "Most viewed pages (views, visitors, outside-link clicks):",
    list(report.pages, (p) => `  ${p.path}: ${p.pageviews}, ${p.visitors}, ${p.clicks}`),
    "Pages visitors arrive on:",
    list(report.entries, (p) => `  ${p.path}: ${p.count}`),
    "Where visitors come from:",
    list(report.sources, (s) => `  ${s.name} (${s.channel}): ${s.count}`),
    "Devices:",
    list(report.devices, (d) => `  ${d.name}: ${d.count}`),
    "Missing pages visitors tried to open (404s):",
    list(report.notFound, (n) => `  ${n.path}: ${n.hits}`),
    "Clicks on phone, email, WhatsApp and outside links:",
    list(report.clicks, (c) => `  ${c.kind}${c.target ? ` ${c.target}` : ""}: ${c.count}`),
  ].join("\n");
}
