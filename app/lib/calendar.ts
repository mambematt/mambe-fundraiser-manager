// Calendar helpers in Pacific time for dashboards and the work queue.

import { DateTime } from "luxon";
import { DEFAULT_TIMEZONE } from "./window";

/** Today's date in Pacific, "YYYY-MM-DD". */
export function todayPacific(now: Date): string {
  return DateTime.fromJSDate(now).setZone(DEFAULT_TIMEZONE).toISODate()!;
}

/** "YYYY-MM-DD" plus n days. */
export function addDays(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: "UTC" }).plus({ days }).toISODate()!;
}

/** Whole days from date a to date b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round(DateTime.fromISO(b, { zone: "UTC" }).diff(DateTime.fromISO(a, { zone: "UTC" }), "days").days);
}

export interface Range {
  start: Date;
  end: Date;
}

/** From 12:00 AM Pacific on the 1st of this month until now. */
export function monthToDate(now: Date): Range {
  return { start: DateTime.fromJSDate(now).setZone(DEFAULT_TIMEZONE).startOf("month").toJSDate(), end: now };
}

/** From 12:00 AM Pacific on Jan 1 this year until now. */
export function yearToDate(now: Date): Range {
  return { start: DateTime.fromJSDate(now).setZone(DEFAULT_TIMEZONE).startOf("year").toJSDate(), end: now };
}

export function lastDays(now: Date, days: number): Range {
  return { start: new Date(now.getTime() - days * 24 * 3600 * 1000), end: now };
}

/** start <= at <= end (end is "now" for to-date ranges). */
export function inRange(at: Date, range: Range): boolean {
  return at.getTime() >= range.start.getTime() && at.getTime() <= range.end.getTime();
}

/** "12 days left", "Ends today", "Ended 3 days ago", "Starts in 2 days". */
export function dayStatus(startDate: string, endDate: string, now: Date): string {
  const today = todayPacific(now);
  if (today < startDate) {
    const n = daysBetween(today, startDate);
    return n === 1 ? "Starts tomorrow" : `Starts in ${n} days`;
  }
  if (today <= endDate) {
    const n = daysBetween(today, endDate);
    return n === 0 ? "Ends today" : `${n} day${n === 1 ? "" : "s"} left`;
  }
  const n = daysBetween(endDate, today);
  return `Ended ${n} day${n === 1 ? "" : "s"} ago`;
}
