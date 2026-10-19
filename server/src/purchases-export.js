import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { PLATFORM_SHARE, purchaseMoney, totalsMoney } from "./credits.js";

// The admin Purchases page's downloads: the purchases matching the page's filters, as Excel (a
// summary sheet with the profit worked out, then every purchase with totals that follow the sheet's
// own filters), PDF (a printable report: the summary, then a row per purchase) or CSV (one plain
// table, for importing). All three come from the same rows (purchaseRows), so they always agree.
// Money is in dollars; the summary counts live payments only, with test payments beside it.

export const PURCHASE_EXPORT_FORMATS = {
  xlsx: { extension: "xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pdf: { extension: "pdf", type: "application/pdf" },
  csv: { extension: "csv", type: "text/csv; charset=utf-8" },
};

const STATUS_NAMES = {
  pending: "Waiting for payment",
  paid: "Paid",
  failed: "Failed",
  expired: "Not completed",
  refunded: "Refunded",
  "part-refunded": "Partly refunded",
  disputed: "Disputed",
};
const share = `${Math.round(PLATFORM_SHARE * 100)}%`;

/* ------------------------------------------------------------ rows */

const col = (header, type, width, pdf) => ({ header, type, width, pdf });
// `pdf`: the PDF's narrower table keeps only these, at these widths (points).
const COLUMNS = [
  col("Date", "datetime", 18, 92),
  col("Buyer", "text", 22, 120),
  col("Email", "text", 28, null),
  col("Status", "text", 15, 74),
  col("Mode", "text", 8, 36),
  col("Paid", "money", 11, 58),
  col("Credits", "count", 11, 58),
  col("Credits value", "money", 13, null),
  col("Refunded", "money", 11, 54),
  col(`Kept (${share})`, "money", 12, 58),
  col("Stripe fee", "money", 11, 58),
  col("Fee estimated", "text", 9, null),
  col("Profit", "money", 11, 58),
  col("Card", "text", 16, null),
  col("Card country", "text", 8, null),
  col("Stripe payment", "text", 30, null),
  col("Stripe checkout", "text", 30, null),
  col("Receipt", "text", 30, null),
];
const index = Object.fromEntries(COLUMNS.map((c, i) => [c.header, i]));
const dollars = (cents) => (typeof cents === "number" ? cents / 100 : null);

/** One row per purchase, in COLUMNS' order, plus what the summary needs. */
function purchaseRows(items) {
  return items.map((p) => {
    const m = purchaseMoney(p);
    const settled = m && m.paidCents > 0;
    const mode = p.provider === "demo" ? "Demo" : p.livemode ? "Live" : "Test";
    const cells = [
      p.createdAt,
      p.buyer?.name || p.account?.name || "",
      p.buyer?.email || p.account?.email || "",
      STATUS_NAMES[p.status] ?? p.status,
      mode,
      settled ? dollars(m.paidCents) : null,
      p.credits - (p.refundedCredits ?? 0),
      settled ? dollars(m.creditsValueCents) : null,
      settled && m.refundedCents ? dollars(m.refundedCents) : null,
      settled ? dollars(m.keptCents) : null,
      settled ? dollars(m.stripeFeeCents) : null,
      settled && m.feeEstimated ? "Yes" : "",
      settled ? dollars(m.profitCents) : null,
      p.card ? `${p.card.brand} ${p.card.last4}` : (p.method ?? ""),
      p.card?.country ?? "",
      p.paymentIntentId ?? "",
      p.stripeSessionId ?? "",
      p.receiptUrl ?? "",
    ];
    return { cells, mode, money: settled ? m : null, purchase: p };
  });
}

/** The live (and test) totals of the exported rows, as the Purchases page's summary works them out. */
function summaryOf(rows) {
  const sums = (mode) => {
    const picked = rows.filter((r) => r.mode === mode && r.money);
    const s = { purchases: picked.length, paidCents: 0, feeCents: 0, unreportedPaidCents: 0, unreportedCount: 0, refundedCents: 0, disputedCents: 0, credits: 0, creditsTakenBack: 0 };
    for (const { purchase: p, money: m } of picked) {
      s.paidCents += m.paidCents;
      if (m.feeEstimated) {
        s.unreportedPaidCents += m.paidCents;
        s.unreportedCount += 1;
      } else s.feeCents += m.stripeFeeCents;
      s.refundedCents += m.refundedCents;
      s.credits += p.credits;
      s.creditsTakenBack += p.refundedCredits ?? 0;
    }
    return totalsMoney(s);
  };
  return { live: sums("Live"), test: sums("Test"), demo: rows.filter((r) => r.mode === "Demo").length, unpaid: rows.filter((r) => !r.money && r.mode !== "Demo").length };
}

/* ------------------------------------------------------------ words */

const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function wallClock(zone, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, Number(x.value)]),
  );
  return parts;
}
/** "19 Oct 2026, 14:39" in `zone`. */
function dateTimeWords(zone, instant) {
  const p = wallClock(zone, instant);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${pad(p.hour)}:${pad(p.minute)}`;
}
/** Plain ASCII money for the PDF's built-in fonts: "$1,234.50", "-$0.59". */
const usd = (n) => (n === null || n === undefined ? "" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function aboutLines({ filters, zone, generatedAt, rows }) {
  return [
    ["Generated", `${dateTimeWords(zone, generatedAt)} (${zone})`],
    ["Showing", filters || "Every purchase"],
    ["Purchases", `${rows.length.toLocaleString("en")}`],
  ];
}

/** The summary's lines: [label, dollars, note]. */
function summaryLines(s) {
  return [
    ["Users paid", s.paidCents / 100, `${s.purchases} ${s.purchases === 1 ? "purchase" : "purchases"}`],
    ["Credits given", -s.creditsValueCents / 100, `${(s.credits - s.creditsTakenBack).toLocaleString("en")} credits of AI use`],
    ["Refunded or disputed", -(s.refundedCents + (s.disputedCents ?? 0)) / 100, ""],
    [`Kept (${share})`, s.keptCents / 100, ""],
    ["Stripe fees", -s.feeCents / 100, s.feeEstimatedCents ? `includes ${usd(s.feeEstimatedCents / 100)} estimated` : ""],
    ["Profit", s.profitCents / 100, s.paidCents ? `${(s.margin * 100).toFixed(1)}% of what users paid` : ""],
  ];
}

/* ------------------------------------------------------------ export */

/**
 * The purchases as a file. `items` are listAllPurchases rows; `filters` says in words which ones;
 * `zone` is the admin's time zone for dates.
 */
export async function exportPurchases(format, { items, filters, zone, generatedAt = new Date() }) {
  const rows = purchaseRows(items);
  const context = { rows, summary: summaryOf(rows), filters, zone, generatedAt };
  if (format === "xlsx") return excelReport(context);
  if (format === "pdf") return pdfReport(context);
  return Buffer.from(csvReport(context), "utf8");
}

export const purchasesFileName = (format, generatedAt = new Date()) =>
  `twinstack-purchases-${generatedAt.toISOString().slice(0, 10)}.${PURCHASE_EXPORT_FORMATS[format].extension}`;

/* ------------------------------------------------------------ csv */

// Quoted, and a leading = + - @ neutralised so a spreadsheet never runs a buyer's name as a formula.
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}

function csvReport({ rows, zone }) {
  const value = (column, v) => {
    if (v === null || v === undefined) return "";
    if (column.type === "datetime") {
      const p = wallClock(zone, v);
      return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
    }
    if (column.type === "money") return v.toFixed(2);
    return v;
  };
  const lines = [COLUMNS.map((c) => csvCell(c.type === "money" ? `${c.header} (USD)` : c.header))];
  for (const { cells } of rows) lines.push(cells.map((v, i) => csvCell(value(COLUMNS[i], v))));
  // The BOM makes Excel read it as UTF-8.
  return `﻿${lines.map((cells) => cells.join(",")).join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------ excel */

const MONEY_FORMAT = '"$"#,##0.00;[Red]-"$"#,##0.00';
const FORMATS = { money: MONEY_FORMAT, count: "#,##0", datetime: "d mmm yyyy hh:mm" };
const DARK = "FF27272A";
const GREY = "FF71717A";
const GREEN = "FF15803D";

function styleHeader(row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK } };
    cell.alignment = { vertical: "middle", horizontal: cell.alignment?.horizontal ?? "left", wrapText: true };
  });
}

async function excelReport({ rows, summary, filters, zone, generatedAt }) {
  const book = new ExcelJS.Workbook();
  book.creator = "Twinstack";
  book.title = "Credit purchases";
  book.created = generatedAt;

  // Summary: what the file holds, then the profit worked out for live (and test) payments.
  const sheet = book.addWorksheet("Summary", { properties: { tabColor: { argb: "FF15803D" } }, views: [{ showGridLines: false }] });
  sheet.columns = [{ width: 26 }, { width: 16 }, { width: 16 }, { width: 36 }];
  sheet.addRow(["Credit purchases"]).font = { bold: true, size: 16 };
  sheet.addRow([`Twinstack · ${share} of every purchase is kept; Stripe's fee is paid from it and the rest is profit.`]).font = { color: { argb: GREY } };
  sheet.addRow([]);
  for (const [label, value] of aboutLines({ filters, zone, generatedAt, rows })) {
    const line = sheet.addRow([label, value]);
    line.getCell(1).font = { bold: true, color: { argb: GREY } };
    sheet.mergeCells(line.number, 2, line.number, 4);
  }
  sheet.addRow([]);
  const modes = [["Live payments", summary.live], ...(summary.test.purchases ? [["Test payments (no real money)", summary.test]] : [])];
  const head = sheet.addRow(["", ...modes.map(([name]) => name), ""]);
  styleHeader(head);
  head.getCell(2).alignment = { horizontal: "right", vertical: "middle" };
  head.getCell(3).alignment = { horizontal: "right", vertical: "middle" };
  const lines = modes.map(([, s]) => summaryLines(s));
  lines[0].forEach(([label], i) => {
    const line = sheet.addRow([label, ...lines.map((l) => l[i][1]), lines[0][i][2]]);
    for (let c = 2; c <= 1 + modes.length; c++) line.getCell(c).numFmt = MONEY_FORMAT;
    line.getCell(2 + modes.length).font = { italic: true, color: { argb: GREY } };
    const profit = label === "Profit";
    const kept = label.startsWith("Kept");
    if (profit || kept) {
      line.eachCell((cell, c) => {
        cell.border = { top: { style: "thin", color: { argb: "FFA1A1AA" } } };
        if (c <= 1 + modes.length) cell.font = { bold: true, ...(profit && { color: { argb: GREEN }, size: 12 }) };
      });
    }
  });
  if (summary.demo || summary.unpaid) {
    sheet.addRow([]);
    sheet.addRow([
      [summary.demo && `${summary.demo} demo purchase${summary.demo === 1 ? "" : "s"} (nothing paid)`, summary.unpaid && `${summary.unpaid} not paid (waiting, failed or not completed)`]
        .filter(Boolean)
        .join(" and ") + " aren't counted.",
    ]).font = { italic: true, color: { argb: GREY } };
  }
  sheet.addRow([]);
  sheet.addRow(["Every purchase is on the Purchases sheet; its totals row follows the sheet's own filters."]).font = { italic: true, color: { argb: GREY } };
  sheet.pageSetup = { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // Purchases: every row, money as numbers, a totals row that follows the sheet's own filters.
  const list = book.addWorksheet("Purchases", { views: [{ state: "frozen", ySplit: 1 }] });
  list.columns = COLUMNS.map((c) => ({ header: c.header, key: c.header, width: c.width, style: FORMATS[c.type] ? { numFmt: FORMATS[c.type] } : {} }));
  styleHeader(list.getRow(1));
  for (const { cells } of rows) {
    const line = list.addRow(cells.map((v, i) => (COLUMNS[i].type === "datetime" && v ? sheetDate(zone, v) : v)));
    const receipt = cells[index.Receipt];
    if (receipt) line.getCell(index.Receipt + 1).value = { text: "Receipt", hyperlink: receipt };
    const profit = line.getCell(index.Profit + 1);
    if (typeof profit.value === "number") profit.font = { bold: true, color: { argb: profit.value < 0 ? "FFB91C1C" : GREEN } };
  }
  COLUMNS.forEach((c, i) => {
    if (c.type !== "text") list.getColumn(i + 1).alignment = { horizontal: "right" };
  });
  if (rows.length) {
    const first = 2;
    const last = rows.length + 1;
    list.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
    // SUBTOTAL(109, …) adds only the rows the sheet's filter shows.
    const total = list.addRow(COLUMNS.map((c, i) => (i === 0 ? "Total of rows shown" : c.type === "money" || c.type === "count" ? null : "")));
    COLUMNS.forEach((c, i) => {
      if (c.type !== "money" && c.type !== "count") return;
      const letter = list.getColumn(i + 1).letter;
      total.getCell(i + 1).value = { formula: `SUBTOTAL(109,${letter}${first}:${letter}${last})` };
    });
    total.eachCell((cell) => {
      cell.font = { bold: true };
      cell.border = { top: { style: "medium", color: { argb: DARK } } };
    });
  } else {
    list.addRow(["No purchases match."]).font = { italic: true, color: { argb: GREY } };
  }
  list.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1" };
  list.headerFooter = { oddFooter: "&L&8Twinstack · Credit purchases&R&8Page &P of &N" };

  return Buffer.from(await book.xlsx.writeBuffer());
}

/** An instant as a spreadsheet date showing the wall-clock time in `zone` (spreadsheets have no time zones). */
function sheetDate(zone, instant) {
  const p = wallClock(zone, instant);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute));
}

/* ------------------------------------------------------------ pdf */

const INK = "#18181b";
const MUTED = "#71717a";
const LINE = "#e4e4e7";
const ZEBRA = "#fafafa";
const PDF_GREEN = "#15803d";
const PDF_RED = "#b91c1c";
const PDF_AMBER = "#b45309";
const MAX_PDF_ROWS = 2000;

function pdfReport({ rows, summary, filters, zone, generatedAt }) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 48, bottom: 56, left: 40, right: 40 },
    bufferPages: true,
    info: { Title: "Credit purchases", Author: "Twinstack" },
  });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // Title.
  doc.rect(left, doc.y, 4, 40).fillColor(PDF_GREEN).fill();
  const top = doc.y;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text("Credit purchases", left + 14, top);
  doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(`Twinstack · ${share} of every purchase is kept: Stripe's fee is paid from it and the rest is profit.`, left + 14, doc.y + 2);
  doc.y = Math.max(doc.y, top + 40) + 10;
  for (const [label, value] of aboutLines({ filters, zone, generatedAt, rows })) {
    doc.fontSize(8.5).font("Helvetica-Bold").fillColor(MUTED).text(`${label}: `, left, doc.y, { continued: true }).font("Helvetica").fillColor(INK).text(value);
  }
  doc.moveDown(0.8);

  // Tiles: the live summary.
  const s = summary.live;
  const tiles = [
    ["Users paid", usd(s.paidCents / 100), `${s.purchases} ${s.purchases === 1 ? "purchase" : "purchases"}`, INK],
    ["Credits given", usd(s.creditsValueCents / 100), `${(s.credits - s.creditsTakenBack).toLocaleString("en")} credits`, INK],
    [`Kept (${share})`, usd(s.keptCents / 100), s.refundedCents ? `after ${usd(s.refundedCents / 100)} refunded` : "", INK],
    ["Stripe fees", usd(s.feeCents / 100), s.feeEstimatedCents ? `incl. ${usd(s.feeEstimatedCents / 100)} estimated` : "", PDF_AMBER],
    ["Profit", usd(s.profitCents / 100), s.paidCents ? `${(s.margin * 100).toFixed(1)}% of what users paid` : "No live purchases", s.profitCents < 0 ? PDF_RED : PDF_GREEN],
  ];
  const gap = 10;
  const tileWidth = (width - gap * (tiles.length - 1)) / tiles.length;
  const tileTop = doc.y;
  tiles.forEach(([label, value, note, color], i) => {
    const x = left + i * (tileWidth + gap);
    const profit = i === tiles.length - 1;
    doc.roundedRect(x, tileTop, tileWidth, 62, 6).fillColor(profit ? "#f0fdf4" : "#ffffff").strokeColor(profit ? "#bbf7d0" : LINE).lineWidth(1).fillAndStroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`${label}${i === 0 ? " (live)" : ""}`, x + 10, tileTop + 9, { width: tileWidth - 20 });
    doc.fillColor(color).font("Helvetica-Bold").fontSize(17).text(value, x + 10, tileTop + 22, { width: tileWidth - 20 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(note, x + 10, tileTop + 45, { width: tileWidth - 20, lineBreak: false, ellipsis: true });
  });
  doc.y = tileTop + 62 + 10;
  doc.x = left;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(
    `${usd(s.paidCents / 100)} paid - ${usd(s.creditsValueCents / 100)} credits given${s.refundedCents ? ` - ${usd(s.refundedCents / 100)} refunded` : ""} = ${usd(s.keptCents / 100)} kept; - ${usd(s.feeCents / 100)} Stripe fees = ${usd(s.profitCents / 100)} profit.` +
      (summary.test.purchases ? `  Test payments (no real money): ${summary.test.purchases}, ${usd(summary.test.paidCents / 100)} paid.` : ""),
    left,
    doc.y,
    { width },
  );
  doc.moveDown(1);

  // The table: the PDF's columns, sized to fit; Buyer takes what's left.
  const shown = COLUMNS.map((c, i) => ({ ...c, i })).filter((c) => c.pdf);
  const fixed = shown.reduce((sum, c) => sum + (c.header === "Buyer" ? 0 : c.pdf), 0);
  const widths = shown.map((c) => (c.header === "Buyer" ? width - fixed : c.pdf));
  const ROW = 26;
  const drawHeader = () => {
    const y = doc.y;
    let x = left;
    shown.forEach((c, k) => {
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7).text(c.header.toUpperCase(), x + 4, y + 4, { width: widths[k] - 8, lineBreak: false, ellipsis: true, align: c.type === "text" || c.type === "datetime" ? "left" : "right" });
      x += widths[k];
    });
    doc.moveTo(left, y + 16).lineTo(left + width, y + 16).strokeColor(INK).lineWidth(0.8).stroke();
    doc.y = y + 16;
  };
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("Purchases", left, doc.y);
  doc.moveDown(0.3);
  drawHeader();
  const printed = rows.slice(0, MAX_PDF_ROWS);
  printed.forEach(({ cells }, r) => {
    if (doc.y + ROW > bottom()) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    if (r % 2 === 1) doc.rect(left, y, width, ROW).fillColor(ZEBRA).fill();
    let x = left;
    shown.forEach((c, k) => {
      const v = cells[c.i];
      let text = v === null || v === undefined ? "-" : c.type === "money" ? usd(v) : c.type === "count" ? Number(v).toLocaleString("en") : c.type === "datetime" ? dateTimeWords(zone, v) : String(v);
      let color = INK;
      let font = "Helvetica";
      if (c.header === "Profit" && typeof v === "number") {
        color = v < 0 ? PDF_RED : PDF_GREEN;
        font = "Helvetica-Bold";
      }
      if (c.header === "Stripe fee" && cells[index["Fee estimated"]]) text += "*";
      if (c.header === "Mode" && v === "Test") color = PDF_AMBER;
      const align = c.type === "text" || c.type === "datetime" ? "left" : "right";
      if (c.header === "Buyer") {
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.5).text(text || "Unknown", x + 4, y + 4, { width: widths[k] - 8, lineBreak: false, ellipsis: true });
        doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(cells[index.Email] || "", x + 4, y + 14.5, { width: widths[k] - 8, lineBreak: false, ellipsis: true });
      } else {
        doc.fillColor(color).font(font).fontSize(8.5).text(text, x + 4, y + 8.5, { width: widths[k] - 8, lineBreak: false, ellipsis: true, align });
      }
      x += widths[k];
    });
    doc.moveTo(left, y + ROW).lineTo(left + width, y + ROW).strokeColor(LINE).lineWidth(0.4).stroke();
    doc.x = left;
    doc.y = y + ROW;
  });
  if (!rows.length) doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("No purchases match.", left, doc.y + 6);
  doc.moveDown(0.8);
  const notes = [];
  if (rows.some((r) => r.cells[index["Fee estimated"]])) notes.push("* Stripe fee estimated (2.9% + 30c); Stripe hadn't reported it yet.");
  if (rows.length > printed.length) notes.push(`Showing the first ${printed.length.toLocaleString("en")} of ${rows.length.toLocaleString("en")}. The Excel and CSV downloads have them all.`);
  if (notes.length) doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(notes.join("  "), left, doc.y, { width });

  // A footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 34;
    doc.moveTo(left, y - 8).lineTo(left + width, y - 8).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5);
    doc.text(`Twinstack · Credit purchases · ${dateTimeWords(zone, generatedAt)}`, left, y, { width: width - 80, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left, y, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return done;
}
