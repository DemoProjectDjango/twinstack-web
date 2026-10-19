import { purchaseMoney, totalsMoney } from "./credits.js";
import { paidPurchasesBetween, purchaseStatusCounts } from "./db.js";
import { addDays, localDate, startOfDay, zoneOf } from "./zoned-days.js";

// The admin Purchases page's summary for a period (the last 7, 30 or 90 days, or 12 months, in the
// admin's time zone), live or test payments: the profit worked out (credits.js totalsMoney), the
// same for the period before it to compare, a point per day (a week per point over 12 months) for
// the chart, the buyers who paid the most, and how many purchases are in each status.

export const INSIGHT_PERIODS = { 7: 7, 30: 30, 90: 90, 365: 365 };
const TOP_BUYERS = 5;

/** purchaseTotals-style sums of some purchases, with their money worked out. */
function sumsOf(purchases) {
  const s = { purchases: 0, paidCents: 0, feeCents: 0, unreportedPaidCents: 0, unreportedCount: 0, refundedCents: 0, disputedCents: 0, credits: 0, creditsTakenBack: 0 };
  for (const p of purchases) {
    const m = purchaseMoney(p);
    s.purchases += 1;
    s.paidCents += m.paidCents;
    if (m.feeEstimated) {
      s.unreportedPaidCents += m.paidCents;
      s.unreportedCount += 1;
    } else s.feeCents += m.stripeFeeCents;
    s.refundedCents += p.refundedCents ?? 0;
    s.disputedCents += p.disputedCents ?? 0;
    s.credits += p.credits;
    s.creditsTakenBack += p.refundedCredits ?? 0;
  }
  return totalsMoney(s);
}

export async function purchaseInsights({ days, live, tz }) {
  const zone = zoneOf(tz);
  const today = startOfDay(zone, Date.now());
  const end = addDays(zone, today, 1);
  const start = addDays(zone, today, 1 - days);
  const previousStart = addDays(zone, start, -days);
  const [current, previous, statusCounts] = await Promise.all([
    paidPurchasesBetween({ start: new Date(start), end: new Date(end), live }),
    paidPurchasesBetween({ start: new Date(previousStart), end: new Date(start), live }),
    purchaseStatusCounts(),
  ]);

  // A point per day, or per 7 days over 12 months, oldest first.
  const step = days > 90 ? 7 : 1;
  const points = [];
  for (let at = start; at < end; at = addDays(zone, at, step)) points.push({ start: at, date: localDate(zone, at), paidCents: 0, profitCents: 0, purchases: 0 });
  for (const p of current) {
    const t = new Date(p.paidAt).getTime();
    const point = points.findLast((x) => x.start <= t);
    if (!point) continue;
    const m = purchaseMoney(p);
    point.paidCents += m.paidCents;
    point.profitCents += m.profitCents;
    point.purchases += 1;
  }

  // The buyers who paid the most.
  const buyers = new Map();
  for (const p of current) {
    const m = purchaseMoney(p);
    const b = buyers.get(p.userId) ?? { userId: p.userId, email: p.buyer?.email ?? null, name: p.buyer?.name ?? null, purchases: 0, paidCents: 0, profitCents: 0 };
    b.purchases += 1;
    b.paidCents += m.paidCents;
    b.profitCents += m.profitCents;
    buyers.set(p.userId, b);
  }

  return {
    days,
    live,
    zone,
    step,
    totals: sumsOf(current),
    previous: sumsOf(previous),
    series: points.map(({ start: _s, ...point }) => point),
    topBuyers: [...buyers.values()].sort((a, b) => b.paidCents - a.paidCents).slice(0, TOP_BUYERS),
    buyerCount: buyers.size,
    statusCounts,
  };
}
