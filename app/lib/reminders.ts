// The organizer reminder plan. Owner decision (session 4):
//   - reminders on day 7, day 14, then every 14 days (days 28, 42, …)
//   - a "final 3 days" email at the start of the last 3 days
//   - skip any regular reminder within 5 days of the final one
//   - every email at 9:00 AM Pacific (the fundraiser's timezone)
// Day 1 is the start date.

import { DateTime } from "luxon";
import { addDays, daysBetween } from "./calendar";
import { DEFAULT_TIMEZONE } from "./window";

export const SEND_HOUR = 9;
export const FINAL_DAYS = 3;
export const SKIP_WITHIN_DAYS_OF_FINAL = 5;
/** A due email is sent only within this long of its time; later, it's skipped. */
export const SEND_GRACE_MS = 2 * 3600 * 1000;

export interface PlannedEmail {
  kind: "reminder" | "final";
  reminderNumber: number | null;
  /** "YYYY-MM-DD" in the fundraiser's timezone. */
  date: string;
  scheduledFor: Date;
}

export function atSendTime(isoDate: string, timezone: string = DEFAULT_TIMEZONE): Date {
  return DateTime.fromISO(isoDate, { zone: timezone }).set({ hour: SEND_HOUR, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

export function planReminders(startDate: string, endDate: string, timezone: string = DEFAULT_TIMEZONE): PlannedEmail[] {
  const lengthDays = daysBetween(startDate, endDate) + 1;
  // The last 3 days are end-2, end-1, end; a fundraiser of 3 days or fewer
  // gets the final email on its first day.
  const finalDate = lengthDays > FINAL_DAYS ? addDays(endDate, -(FINAL_DAYS - 1)) : startDate;

  const regularDays: number[] = [];
  for (let day = 7; ; day = day === 7 ? 14 : day + 14) {
    const date = addDays(startDate, day - 1);
    if (date >= finalDate) break;
    regularDays.push(day);
  }

  const emails: PlannedEmail[] = [];
  let n = 0;
  for (const day of regularDays) {
    const date = addDays(startDate, day - 1);
    if (daysBetween(date, finalDate) <= SKIP_WITHIN_DAYS_OF_FINAL) continue;
    n += 1;
    emails.push({ kind: "reminder", reminderNumber: n, date, scheduledFor: atSendTime(date, timezone) });
  }
  emails.push({ kind: "final", reminderNumber: null, date: finalDate, scheduledFor: atSendTime(finalDate, timezone) });
  return emails;
}
