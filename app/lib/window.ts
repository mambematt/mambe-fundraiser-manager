// The one place a fundraiser's calendar dates become a UTC time window.
//
// A window is the half-open interval
//   [start date 00:00 local, day after end date 00:00 local)
// converted to UTC. Daylight-saving changes are handled by Luxon's timezone
// database, never by hand-coded offsets.

import { DateTime } from "luxon";

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

export interface TimeWindow {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** A calendar date, either "YYYY-MM-DD" or a Date from a Postgres DATE column (UTC midnight). */
export type CalendarDate = string | Date;

function toIsoDate(value: CalendarDate): string {
  const iso = typeof value === "string" ? value : value.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Invalid calendar date: ${String(value)}`);
  }
  return iso;
}

function startOfLocalDay(isoDate: string, timezone: string): DateTime {
  const day = DateTime.fromISO(isoDate, { zone: timezone }).startOf("day");
  if (!day.isValid) {
    throw new Error(
      `Invalid date "${isoDate}" or timezone "${timezone}": ${day.invalidExplanation}`,
    );
  }
  return day;
}

export function computeWindow(
  startDate: CalendarDate,
  endDate: CalendarDate,
  timezone: string = DEFAULT_TIMEZONE,
): TimeWindow {
  const startIso = toIsoDate(startDate);
  const endIso = toIsoDate(endDate);
  if (endIso < startIso) {
    throw new Error(`End date ${endIso} is before start date ${startIso}`);
  }
  const start = startOfLocalDay(startIso, timezone);
  const end = startOfLocalDay(endIso, timezone).plus({ days: 1 }).startOf("day");
  return { start: start.toUTC().toJSDate(), end: end.toUTC().toJSDate() };
}

/** A cancelled fundraiser's window ends at the moment it was cancelled. */
export function effectiveWindow(
  window: TimeWindow,
  cancelledAt: Date | null | undefined,
): TimeWindow {
  if (cancelledAt && cancelledAt.getTime() < window.end.getTime()) {
    const end = cancelledAt.getTime() < window.start.getTime() ? window.start : cancelledAt;
    return { start: window.start, end };
  }
  return window;
}

export function windowContains(window: TimeWindow, at: Date): boolean {
  const t = at.getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}
