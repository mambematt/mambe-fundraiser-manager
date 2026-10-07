import { DateTime } from "luxon";
import { DEFAULT_TIMEZONE } from "./window";

/** A moment shown in Pacific time, e.g. "Oct 7, 2026 3:15 PM PDT". */
export function pacific(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return DateTime.fromJSDate(new Date(date)).setZone(DEFAULT_TIMEZONE).toFormat("LLL d, yyyy h:mm a ZZZZ");
}

/** A calendar date ("2026-10-01" or a DATE column) as "Oct 1, 2026". */
export function calendarDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const iso = typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  return DateTime.fromISO(iso).toFormat("LLL d, yyyy");
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const TIMEZONES: Array<[string, string]> = [
  ["America/Los_Angeles", "Pacific"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Chicago", "Central"],
  ["America/New_York", "Eastern"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
];
