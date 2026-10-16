import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

// The Analytics screen's "Download full report": everything for the period and filters on screen,
// as Excel (a summary sheet, then a sheet per table), PDF (a printable report), CSV (one file: a
// header block, then each table under a "# title" line, as Google Analytics exports) or JSON.
// Every format is built from the same typed tables (reportTables), so they always agree, and shows
// times in the owner's time zone and pages by their titles. All but the PDF include every visit.

export const EXPORT_FORMATS = {
  xlsx: { extension: "xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pdf: { extension: "pdf", type: "application/pdf" },
  csv: { extension: "csv", type: "text/csv; charset=utf-8" },
  json: { extension: "json", type: "application/json; charset=utf-8" },
};

const PRESET_NAMES = {
  today: "Today",
  yesterday: "Yesterday",
  7: "Last 7 days",
  30: "Last 30 days",
  90: "Last 90 days",
  365: "Last 12 months",
  month: "This month",
  lastmonth: "Last month",
  custom: "Custom range",
};
const FILTER_NAMES = { page: "Opened", source: "Came from", device: "Device", browser: "Browser", os: "System", zone: "Location" };
const CHANNELS = { direct: "Direct", search: "Search engine", social: "Social media", ai: "AI assistant", campaign: "Campaign link", other: "Other website" };
const CLICKS = { phone: "Phone number", email: "Email address", whatsapp: "WhatsApp", link: "Link to another website" };

/* ------------------------------------------------------------------ words */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "17 Sep 2026", the same on every server (locale data spells some months differently). */
const dateWords = (date) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

/** "17 Sep 2026 – 16 Oct 2026". */
const spanWords = (period) => (period.first === period.last ? dateWords(period.first) : `${dateWords(period.first)} – ${dateWords(period.last)}`);

/** "Last 30 days (17 Sep 2026 – 16 Oct 2026)". */
export const periodName = (period) => `${PRESET_NAMES[period.preset] ?? "Period"} (${spanWords(period)})`;

const filtersName = (filters, titleOf) =>
  Object.entries(filters ?? {})
    .map(([field, value]) => `${FILTER_NAMES[field] ?? field}: ${field === "page" ? titleOf(value) : field === "zone" ? placeOf(value) : value}`)
    .join("; ") || "All visitors";

/** "Europe/London" → "London, Europe". */
function placeOf(zone) {
  if (!zone || zone === "Unknown") return "Unknown";
  const parts = zone.split("/");
  const place = parts.at(-1).replace(/_/g, " ");
  return parts.length > 1 ? `${place}, ${parts[0].replace(/_/g, " ")}` : place;
}

/** The wall-clock time of an instant in `zone`, as numbers. */
function wallClock(zone, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, Number(p.value)]),
  );
  return parts;
}

const pad = (n) => String(n).padStart(2, "0");
/** "16 Oct 2026, 11:55" in `zone`. */
function dateTimeWords(zone, instant) {
  const p = wallClock(zone, instant);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${pad(p.hour)}:${pad(p.minute)}`;
}
/** "2026-10-16 11:55:03" in `zone`. */
function localStamp(zone, instant) {
  const p = wallClock(zone, instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/* ------------------------------------------------------------------ tables */

// Column types, each shown its own way in every format:
//   text, count (whole number), decimal, percent (a fraction: 0.25 is 25%), date ("2026-10-16"),
//   datetime (an ISO instant, shown in the report's time zone).

const col = (header, type = "text", width) => ({ header, type, width });

/**
 * The report as typed tables: `{ name, title, sheet, description, columns, rows }`, in the order
 * every format shows them. `titleOf(path)` names a page ("Homepage", its title, or null).
 */
export function reportTables(report, visits, titleOf) {
  const { totals } = report;
  const share = (count, whole) => (whole ? count / whole : 0);
  const pageTitle = (path) => titleOf(path) ?? "";
  const bucket = report.unit === "hour" ? "Hour" : report.unit === "week" ? "Week starting" : "Day";
  return [
    {
      name: "over-time",
      title: report.unit === "hour" ? "Visitors by hour" : report.unit === "week" ? "Visitors per week" : "Visitors per day",
      sheet: "Over time",
      columns: [col(bucket, report.unit === "hour" ? "text" : "date", 18), col("Visitors", "count"), col("Page views", "count")],
      rows: report.series.map((b) => [report.unit === "hour" ? `${b.date} ${pad(b.hour)}:00` : b.date, b.visitors, b.pageviews]),
    },
    {
      name: "pages",
      title: "Most viewed pages",
      sheet: "Pages",
      columns: [col("Page", "text", 34), col("Address", "text", 30), col("Views", "count"), col("Visitors", "count"), col("Share of views", "percent"), col("Contact clicks", "count")],
      rows: report.pages.map((p) => [pageTitle(p.path), p.path, p.pageviews, p.visitors, share(p.pageviews, totals.pageviews), p.clicks]),
    },
    {
      name: "entry-pages",
      title: "Where visitors arrive",
      sheet: "Entry pages",
      description: "The first page each visitor opened.",
      columns: [col("Page", "text", 34), col("Address", "text", 30), col("Visitors", "count"), col("Share", "percent")],
      rows: report.entries.map((p) => [pageTitle(p.path), p.path, p.count, share(p.count, totals.visitors)]),
    },
    {
      name: "sources",
      title: "Where visitors come from",
      sheet: "Sources",
      columns: [col("Source", "text", 30), col("Kind", "text", 18), col("Visitors", "count"), col("Share", "percent")],
      rows: report.sources.map((s) => [s.name, CHANNELS[s.channel] ?? s.channel, s.count, share(s.count, totals.visitors)]),
    },
    {
      name: "campaigns",
      title: "Campaigns",
      sheet: "Campaigns",
      description: "Visits from links tagged with utm_source, utm_medium or utm_campaign.",
      columns: [col("Campaign", "text", 24), col("Source", "text", 20), col("Medium", "text", 16), col("Visitors", "count")],
      rows: report.campaigns.map((c) => [c.campaign ?? "", c.source ?? "", c.medium ?? "", c.count]),
    },
    {
      name: "devices",
      title: "Devices",
      sheet: "Devices",
      columns: [col("Device", "text", 18), col("Visitors", "count"), col("Share", "percent")],
      rows: report.devices.map((d) => [d.name, d.count, share(d.count, totals.visitors)]),
    },
    {
      name: "browsers",
      title: "Browsers",
      sheet: "Browsers",
      columns: [col("Browser", "text", 18), col("Visitors", "count"), col("Share", "percent")],
      rows: report.browsers.map((d) => [d.name, d.count, share(d.count, totals.visitors)]),
    },
    {
      name: "systems",
      title: "Operating systems",
      sheet: "Systems",
      columns: [col("System", "text", 18), col("Visitors", "count"), col("Share", "percent")],
      rows: report.systems.map((d) => [d.name, d.count, share(d.count, totals.visitors)]),
    },
    {
      name: "locations",
      title: "Locations",
      sheet: "Locations",
      description: "From each visitor's time zone.",
      columns: [col("Location", "text", 26), col("Time zone", "text", 22), col("Visitors", "count"), col("Share", "percent")],
      rows: report.zones.map((z) => [placeOf(z.name), z.name, z.count, share(z.count, totals.visitors)]),
    },
    {
      name: "missing-pages",
      title: "Missing pages people tried",
      sheet: "Missing pages",
      description: "Addresses visitors opened that the site doesn't have.",
      columns: [col("Address", "text", 32), col("Visits", "count"), col("Last visit", "datetime", 20), col("Came from", "text", 30)],
      rows: report.notFound.map((n) => [n.path, n.hits, new Date(n.last).toISOString(), n.referrers.join(", ")]),
    },
    {
      name: "contact-clicks",
      title: "Contact clicks",
      sheet: "Contact clicks",
      columns: [col("Clicked", "text", 24), col("Where to", "text", 28), col("Clicks", "count")],
      rows: report.clicks.map((c) => [CLICKS[c.kind] ?? c.kind, c.target ?? "", c.count]),
    },
    {
      name: "visits",
      title: "Every visit",
      sheet: "All visits",
      description: "One row per page view or click, oldest first. Nothing in it tells visitors apart.",
      columns: [
        col("Time", "datetime", 20),
        col("Event", "text", 11),
        col("Page", "text", 28),
        col("Address", "text", 26),
        col("Missing page", "text", 13),
        col("Source", "text", 18),
        col("Kind", "text", 16),
        col("Referrer", "text", 22),
        col("Campaign source", "text", 16),
        col("Campaign medium", "text", 16),
        col("Campaign name", "text", 16),
        col("Device", "text", 10),
        col("Browser", "text", 12),
        col("System", "text", 11),
        col("Location", "text", 20),
        col("Clicked", "text", 18),
        col("Click target", "text", 22),
      ],
      rows: visits.rows.map((v) => [
        v.time,
        v.type === "click" ? "Click" : "Page view",
        pageTitle(v.page),
        v.page,
        v.missingPage ? "Yes" : "",
        v.type === "click" ? "" : (v.source ?? ""),
        v.type === "click" ? "" : (CHANNELS[v.channel] ?? v.channel ?? ""),
        v.referrer ?? "",
        v.utmSource ?? "",
        v.utmMedium ?? "",
        v.utmCampaign ?? "",
        v.device ?? "",
        v.browser ?? "",
        v.system ?? "",
        v.timeZone ? placeOf(v.timeZone) : "",
        v.click ? (CLICKS[v.click] ?? v.click) : "",
        v.clickTarget ?? "",
      ]),
    },
  ];
}

/** The headline numbers: this period, the period before and the change. */
function summaryRows(report) {
  const { totals: now, previous: before } = report;
  const perVisitor = (t) => (t.visitors ? t.pageviews / t.visitors : 0);
  const leftAfterOne = (t) => (t.visitors ? t.singlePage / t.visitors : 0);
  const rows = [
    { label: "Visitors", type: "count", now: now.visitors, before: before.visitors },
    { label: "Page views", type: "count", now: now.pageviews, before: before.pageviews },
    { label: "Pages per visitor", type: "decimal", now: perVisitor(now), before: perVisitor(before) },
    { label: "Left after one page", type: "percent", now: leftAfterOne(now), before: leftAfterOne(before), lowerIsBetter: true },
  ];
  // Change as a fraction of before (percentage points for a percentage); null with nothing before.
  return rows.map((r) => ({ ...r, change: before.visitors ? (r.type === "percent" ? r.now - r.before : r.before ? (r.now - r.before) / r.before : null) : null }));
}

function aboutLines({ siteName, report, visits, generatedAt, titleOf }) {
  return [
    ["Website", siteName],
    ["Period", periodName(report.period)],
    ["Compared with", report.period.days === 1 && report.period.current ? "Yesterday, up to the same time" : `The ${report.period.days === 1 ? "day" : `${report.period.days} days`} before`],
    ["Visitors shown", filtersName(report.filters, titleOf)],
    ["Time zone", report.zone],
    ["Generated", `${localStamp(report.zone, generatedAt).slice(0, 16)} (${report.zone})`],
    ["How visitors are counted", "Without cookies. A visitor is one person on one day."],
    ...(visits.truncated ? [["Note", `Only the first ${visits.rows.length.toLocaleString("en")} visits are listed.`]] : []),
  ];
}

/* ------------------------------------------------------------------ formats */

/** The file for `format`, from the report, its visits, and `titles` (address → page title). */
export async function exportReport(format, { siteName, report, visits, titles }) {
  const titleOf = (path) => (path === "/" ? "Homepage" : (titles.get(path) ?? null));
  const context = { siteName, report, visits, titleOf, generatedAt: new Date() };
  const tables = reportTables(report, visits, titleOf);
  if (format === "json") return Buffer.from(`${JSON.stringify(jsonReport(context), null, 2)}\n`);
  if (format === "csv") return Buffer.from(csvReport(context, tables));
  if (format === "xlsx") return excelReport(context, tables);
  if (format === "pdf") return pdfReport(context, tables);
  throw new Error(`Unknown format ${format}`);
}

/** A file name from the site's name and the period: "harbour-street-bakery-visits-2026-09-17-to-2026-10-16". */
export function exportFileName(siteName, period) {
  const slug = siteName.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s_-]+/g, "-").slice(0, 60) || "site";
  return `${slug}-visits-${period.first === period.last ? period.first : `${period.first}-to-${period.last}`}`;
}

/* ---------------------------------------------------------------------- json */

function jsonReport({ siteName, report, visits, generatedAt, titleOf }) {
  const withTitle = (path) => ({ path, title: titleOf(path) });
  return {
    format: "twinstack-visits-report",
    version: 1,
    site: siteName,
    generatedAt: generatedAt.toISOString(),
    period: { ...report.period, name: periodName(report.period) },
    timeZone: report.zone,
    filters: report.filters,
    note: "Counted without cookies. A visitor is one person on one day. Times are UTC (ISO 8601).",
    totals: report.totals,
    previous: report.previous,
    series: { unit: report.unit, buckets: report.series },
    pages: report.pages.map((p) => ({ ...withTitle(p.path), views: p.pageviews, visitors: p.visitors, contactClicks: p.clicks })),
    entryPages: report.entries.map((p) => ({ ...withTitle(p.path), visitors: p.count })),
    sources: report.sources.map((s) => ({ source: s.name, kind: s.channel, visitors: s.count })),
    campaigns: report.campaigns.map((c) => ({ campaign: c.campaign, source: c.source, medium: c.medium, visitors: c.count })),
    devices: report.devices.map((d) => ({ device: d.name, visitors: d.count })),
    browsers: report.browsers.map((d) => ({ browser: d.name, visitors: d.count })),
    systems: report.systems.map((d) => ({ system: d.name, visitors: d.count })),
    locations: report.zones.map((z) => ({ timeZone: z.name, location: placeOf(z.name), visitors: z.count })),
    missingPages: report.notFound.map((n) => ({ path: n.path, visits: n.hits, lastVisit: new Date(n.last).toISOString(), referrers: n.referrers })),
    contactClicks: report.clicks.map((c) => ({ kind: c.kind, target: c.target, clicks: c.count })),
    visits: visits.rows.map((v) => ({ ...v, pageTitle: titleOf(v.page) })),
    visitsTruncated: visits.truncated,
  };
}

/* ----------------------------------------------------------------------- csv */

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = typeof value === "string" && /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A cell's CSV value: numbers stay plain numbers, percentages are out of 100, times are local. */
function csvValue(type, value, zone) {
  if (value === "" || value === null || value === undefined) return "";
  if (type === "percent") return Math.round(value * 1000) / 10;
  if (type === "decimal") return Math.round(value * 100) / 100;
  if (type === "datetime") return localStamp(zone, value);
  return value;
}

const csvHeader = (column) => (column.type === "percent" ? `${column.header} (%)` : column.header);

function csvReport(context, tables) {
  const { report } = context;
  const lines = [];
  const row = (cells) => lines.push(cells.map(csvCell).join(","));
  row([`# Visits report: ${context.siteName}`]);
  for (const [label, value] of aboutLines(context)) row([`# ${label}: ${value}`]);
  lines.push("");
  row(["# Summary"]);
  row(["Measure", "This period", "Period before", "Change (%)"]);
  for (const r of summaryRows(report)) {
    row([r.type === "percent" ? `${r.label} (%)` : r.label, csvValue(r.type, r.now), csvValue(r.type, r.before), r.change === null ? "" : Math.round(r.change * 1000) / 10]);
  }
  for (const table of tables) {
    lines.push("");
    row([`# ${table.title}${table.name === "visits" ? ` (times in ${report.zone})` : ""}`]);
    row(table.columns.map(csvHeader));
    if (!table.rows.length) row(["No data for this period"]);
    for (const cells of table.rows) row(cells.map((value, i) => csvValue(table.columns[i].type, value, report.zone)));
  }
  // The byte-order mark makes Excel read the file as UTF-8; CRLF line ends are the CSV standard.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/* --------------------------------------------------------------------- excel */

const NUMBER_FORMATS = { count: "#,##0", decimal: "0.0", percent: "0.0%", date: "d mmm yyyy", datetime: "d mmm yyyy hh:mm" };
const DARK = "FF27272A";
const SOFT = "FFF4F4F5";
const GREY = "FF71717A";

/** An instant as a spreadsheet date showing the wall-clock time in `zone` (spreadsheets have no time zones). */
function sheetDate(zone, instant) {
  const p = wallClock(zone, instant);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

function sheetValue(type, value, zone) {
  if (value === "" || value === null || value === undefined) return null;
  if (type === "date") return new Date(`${value}T00:00:00Z`);
  if (type === "datetime") return sheetDate(zone, value);
  return value;
}

function printSetup(sheet, context, { landscape = false, titleRow = null } = {}) {
  sheet.pageSetup = {
    paperSize: 9, // A4
    orientation: landscape ? "landscape" : "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    ...(titleRow && { printTitlesRow: `${titleRow}:${titleRow}` }),
  };
  const name = context.siteName.replace(/&/g, "&&");
  sheet.headerFooter = { oddFooter: `&L&8${name} · Visits report · ${spanWords(context.report.period)}&R&8Page &P of &N` };
}

async function excelReport(context, tables) {
  const { report } = context;
  const book = new ExcelJS.Workbook();
  book.creator = "Twinstack";
  book.title = `Visits report: ${context.siteName}`;
  book.subject = periodName(report.period);
  book.created = context.generatedAt;

  // Summary: what the report is, then the headline numbers.
  const summary = book.addWorksheet("Summary", { properties: { tabColor: { argb: "FF0284C7" } }, views: [{ showGridLines: false }] });
  summary.columns = [{ width: 26 }, { width: 18 }, { width: 18 }, { width: 14 }];
  summary.addRow([`Visits report: ${context.siteName}`]).font = { bold: true, size: 16 };
  summary.addRow([periodName(report.period)]).font = { size: 11, color: { argb: GREY } };
  summary.addRow([]);
  for (const [label, value] of aboutLines(context)) {
    const line = summary.addRow([label, value]);
    line.getCell(1).font = { bold: true, color: { argb: GREY } };
    summary.mergeCells(line.number, 2, line.number, 4);
    line.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  summary.addRow([]);
  const head = summary.addRow(["Measure", "This period", "Period before", "Change"]);
  styleHeader(head);
  for (const r of summaryRows(report)) {
    const line = summary.addRow([r.label, r.now, r.before, r.change]);
    line.getCell(2).numFmt = NUMBER_FORMATS[r.type];
    line.getCell(3).numFmt = NUMBER_FORMATS[r.type];
    // A percentage changes in points: "+5.0 pts".
    line.getCell(4).numFmt = r.type === "percent" ? '+0.0" pts";-0.0" pts";0" pts"' : "+0%;-0%;0%";
    line.getCell(2).font = { bold: true };
    if (r.change) line.getCell(4).font = { color: { argb: r.change > 0 !== Boolean(r.lowerIsBetter) ? "FF15803D" : "FFB91C1C" } };
    line.eachCell((cell) => {
      cell.border = { bottom: { style: "thin", color: { argb: "FFE4E4E7" } } };
    });
  }
  summary.addRow([]);
  summary.addRow(["Each table is on its own sheet. All visits lists every page view and click."]).font = { italic: true, color: { argb: GREY } };
  printSetup(summary, context);

  for (const table of tables) {
    const wide = table.columns.length > 6;
    const sheet = book.addWorksheet(table.sheet, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = table.columns.map((c) => ({ header: c.header, key: c.header, width: c.width ?? Math.max(12, c.header.length + 4), style: NUMBER_FORMATS[c.type] ? { numFmt: NUMBER_FORMATS[c.type] } : {} }));
    styleHeader(sheet.getRow(1));
    for (const cells of table.rows) sheet.addRow(cells.map((value, i) => sheetValue(table.columns[i].type, value, report.zone)));
    if (table.rows.length) {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
    } else {
      sheet.addRow(["No data for this period."]).font = { italic: true, color: { argb: GREY } };
    }
    table.columns.forEach((c, i) => {
      if (c.type !== "text") sheet.getColumn(i + 1).alignment = { horizontal: "right" };
    });
    printSetup(sheet, context, { landscape: wide, titleRow: 1 });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

function styleHeader(row) {
  row.height = 20;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK } };
    cell.alignment = { vertical: "middle", horizontal: cell.alignment?.horizontal ?? "left" };
  });
}

/* ----------------------------------------------------------------------- pdf */

const INK = "#18181b";
const MUTED = "#71717a";
const LINE = "#e4e4e7";
const ZEBRA = "#fafafa";
const ACCENT = "#0284c7";
const GOOD = "#15803d";
const BAD = "#b91c1c";
const PDF_ROWS = 15;

const pdfNumber = (type, value) => {
  if (value === "" || value === null || value === undefined) return "";
  if (type === "count") return Number(value).toLocaleString("en");
  if (type === "decimal") return Number(value).toFixed(1);
  if (type === "percent") return `${(value * 100).toFixed(1)}%`;
  return String(value);
};

function niceMax(value) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].find((m) => m * power >= value) * power;
}

function pdfReport(context, tables) {
  const { siteName, report, visits } = context;
  const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 64, left: 48, right: 48 }, bufferPages: true, info: { Title: `Visits report: ${siteName}`, Author: "Twinstack", Subject: periodName(report.period) } });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const room = (needed) => {
    if (doc.y + needed > bottom()) doc.addPage();
  };

  // Title block.
  doc.rect(left, doc.y, 4, 46).fillColor(ACCENT).fill();
  const top = doc.y;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(siteName, left + 14, top, { width: width - 14 });
  doc.fillColor(MUTED).font("Helvetica").fontSize(11).text(`Visits report · ${periodName(report.period)}`, left + 14, doc.y + 2, { width: width - 14 });
  doc.y = Math.max(doc.y, top + 46) + 12;
  doc.x = left;
  doc.fontSize(9).fillColor(MUTED);
  const about = aboutLines(context).filter(([label]) => !["Website", "Period"].includes(label));
  for (const [label, value] of about) {
    doc.font("Helvetica-Bold").fillColor(MUTED).text(`${label}: `, left, doc.y, { continued: true }).font("Helvetica").fillColor(INK).text(value, { width });
  }
  doc.moveDown(1);

  // Headline numbers.
  const tileGap = 10;
  const tileWidth = (width - 3 * tileGap) / 4;
  const tileTop = doc.y;
  summaryRows(report).forEach((r, i) => {
    const x = left + i * (tileWidth + tileGap);
    doc.roundedRect(x, tileTop, tileWidth, 66, 6).fillColor("#ffffff").strokeColor(LINE).lineWidth(1).fillAndStroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(r.label, x + 10, tileTop + 10, { width: tileWidth - 20 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(pdfNumber(r.type, r.now), x + 10, tileTop + 24, { width: tileWidth - 20 });
    let note = "Nothing to compare with";
    let color = MUTED;
    if (r.change !== null) {
      const amount = r.type === "percent" ? `${r.change >= 0 ? "+" : ""}${(r.change * 100).toFixed(1)} pts` : `${r.change >= 0 ? "+" : ""}${Math.round(r.change * 100)}%`;
      note = `${amount} on the period before`;
      if (Math.abs(r.change) >= 0.005) color = r.change > 0 !== Boolean(r.lowerIsBetter) ? GOOD : BAD;
    }
    doc.fillColor(color).font("Helvetica").fontSize(7.5).text(note, x + 10, tileTop + 50, { width: tileWidth - 20 });
  });
  doc.y = tileTop + 66 + 22;

  // Chart: a column per hour, day or week.
  const overTime = tables.find((t) => t.name === "over-time");
  const series = report.series;
  const chartHeight = 130;
  room(chartHeight + 60);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(overTime.title, left, doc.y);
  const chartTop = doc.y + 10;
  const axisWidth = 30;
  const plotLeft = left + axisWidth;
  const plotWidth = width - axisWidth;
  const max = niceMax(Math.max(0, ...series.map((b) => b.visitors)));
  for (const tick of [0, max / 2, max]) {
    const y = chartTop + chartHeight - (tick / max) * chartHeight;
    doc.moveTo(plotLeft, y).lineTo(plotLeft + plotWidth, y).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(7).text(Number.isInteger(tick) ? tick.toLocaleString("en") : tick.toFixed(1), left, y - 4, { width: axisWidth - 6, align: "right" });
  }
  const slot = plotWidth / Math.max(1, series.length);
  const barWidth = Math.max(1, Math.min(16, slot - 2));
  series.forEach((b, i) => {
    if (!b.visitors) return;
    const h = (b.visitors / max) * chartHeight;
    doc.roundedRect(plotLeft + i * slot + (slot - barWidth) / 2, chartTop + chartHeight - h, barWidth, h, Math.min(2, barWidth / 2)).fillColor(ACCENT).fill();
  });
  const label = (b) => (report.unit === "hour" ? `${pad(b.hour)}:00` : dateWords(b.date));
  if (series.length) {
    doc.fillColor(MUTED).fontSize(7).text(label(series[0]), plotLeft, chartTop + chartHeight + 5, { lineBreak: false });
    doc.text(label(series.at(-1)), plotLeft, chartTop + chartHeight + 5, { width: plotWidth, align: "right", lineBreak: false });
  }
  doc.x = left;
  doc.y = chartTop + chartHeight + 26;

  // Tables: the first rows of each. The visit-by-visit list is left to the other formats.
  for (const table of tables) {
    if (table.name === "over-time" || table.name === "visits" || !table.rows.length) continue;
    const shown = table.rows.slice(0, PDF_ROWS);
    room(58 + Math.min(4, shown.length) * 17);
    doc.moveDown(0.8).fillColor(INK).font("Helvetica-Bold").fontSize(12).text(table.title, left, doc.y);
    if (table.description) doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(table.description, left, doc.y + 1);
    doc.moveDown(0.4);
    // Number and date columns as wide as their heading (and a date), text columns share the rest.
    const numeric = table.columns.map((c) => c.type !== "text");
    doc.font("Helvetica-Bold").fontSize(7.5);
    const fixed = table.columns.map((c, i) => (numeric[i] ? Math.max(c.type === "datetime" ? 92 : 52, doc.widthOfString(c.header.toUpperCase()) + 14) : 0));
    const textCount = numeric.filter((n) => !n).length;
    const textWidth = (width - fixed.reduce((sum, w) => sum + w, 0)) / Math.max(1, textCount);
    const widths = fixed.map((w, i) => (numeric[i] ? w : textWidth));
    const drawRow = (cells, { header = false, shade = false } = {}) => {
      room(18);
      const y = doc.y;
      if (shade) doc.rect(left, y, width, 17).fillColor(ZEBRA).fill();
      let x = left;
      cells.forEach((cell, i) => {
        const value = header ? cell : table.columns[i].type === "datetime" ? dateTimeWords(report.zone, cell) : numeric[i] ? pdfNumber(table.columns[i].type, cell) : String(cell ?? "");
        doc.fillColor(header ? MUTED : INK)
          .font(header ? "Helvetica-Bold" : "Helvetica")
          .fontSize(header ? 7.5 : 8.5)
          .text(value, x + 4, y + 4.5, { width: widths[i] - 8, height: 11, ellipsis: true, lineBreak: false, align: numeric[i] ? "right" : "left" });
        x += widths[i];
      });
      doc.moveTo(left, y + 17).lineTo(left + width, y + 17).strokeColor(LINE).lineWidth(header ? 0.8 : 0.4).stroke();
      doc.x = left;
      doc.y = y + 17;
    };
    drawRow(table.columns.map((c) => c.header.toUpperCase()), { header: true });
    shown.forEach((row, i) => drawRow(row, { shade: i % 2 === 1 }));
    if (table.rows.length > shown.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(`Showing the top ${shown.length} of ${table.rows.length}. The Excel, CSV and JSON downloads have them all.`, left, doc.y + 3);
    }
  }

  room(30);
  doc.moveDown(1.5).fillColor(MUTED).font("Helvetica").fontSize(8).text(
    `The visit-by-visit list (${visits.rows.length.toLocaleString("en")} rows) is in the Excel, CSV and JSON downloads.`,
    left,
    doc.y,
    { width },
  );

  // A footer on every page: the site and period, and the page number.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 40;
    doc.moveTo(left, y - 8).lineTo(left + width, y - 8).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5);
    doc.text(`${siteName} · Visits report · ${spanWords(report.period)}`, left, y, { width: width - 80, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left, y, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return done;
}
