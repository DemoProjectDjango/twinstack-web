// Local days in a person's own time zone (their browser's IANA name), as UTC instants: the
// analytics dashboard and the admin's activity report count "today" from their midnight.

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** The owner's time zone when it's a real IANA name, else UTC. */
export function zoneOf(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** How far `zone` is ahead of UTC at `instant`, in milliseconds. */
export function offsetAt(zone, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Midnight in `zone` of the day `instant` falls on, as a UTC instant. */
export function startOfDay(zone, instant) {
  const local = new Date(instant + offsetAt(zone, instant));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // The offset at midnight itself, which differs on the night the clocks change.
  return midnight - offsetAt(zone, midnight - offsetAt(zone, instant));
}

/** Midnight `days` days after the midnight `dayStart` (going via noon keeps clock changes out). */
export const addDays = (zone, dayStart, days) => startOfDay(zone, dayStart + days * DAY + 12 * HOUR);

/** The local date ("2026-10-16") a UTC instant falls on in `zone`. */
export const localDate = (zone, instant) => new Date(instant + offsetAt(zone, instant)).toISOString().slice(0, 10);

/** Midnight in `zone` at the start of a local date ("2026-10-16"), or null if it isn't one. */
export function dayStartOf(zone, date) {
  const match = typeof date === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const noonUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (Number.isNaN(noonUtc) || new Date(noonUtc).toISOString().slice(0, 10) !== date) return null;
  // Noon on that date in `zone`, then back to its midnight.
  return startOfDay(zone, noonUtc - offsetAt(zone, noonUtc));
}
