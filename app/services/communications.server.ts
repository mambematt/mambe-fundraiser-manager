// Organizer emails. The communications table is both the schedule and the
// send log. Rules:
//   - Nothing is sent unless the fundraiser's Organizer emails switch is on.
//   - A reminder whose time has passed is never sent late: it's marked
//     "skipped_past_due" (when planned, or if the clock was down).
//   - Failed sends retry on the next clock runs, then show as failed.

import type { Communication, PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { PORTAL_HELP_EMAIL } from "../content/portal-copy";
import { dayStatus, todayPacific } from "../lib/calendar";
import { UserError } from "../lib/errors";
import { planReminders, SEND_GRACE_MS } from "../lib/reminders";
import { defaultBannerTeamName } from "../lib/storefront";
import { alert } from "./alerts.server";
import { writeAudit } from "./audit.server";
import { isoDate, storedTotals } from "./fundraisers.server";
import { METRICS, splitName, type KlaviyoClient, type MetricName } from "./klaviyo.server";

export const MAX_SEND_ATTEMPTS = 3;
/** Launch, ended and portal-ready emails can go out up to a day late; reminders can't. */
const IMMEDIATE_GRACE_MS = 24 * 3600 * 1000;
const PLANNED_KINDS = ["reminder", "final"];
const EMAIL_STATUSES = new Set(["scheduled", "active"]);

const METRIC_FOR_KIND: Record<string, MetricName> = {
  launch: METRICS.launched,
  reminder: METRICS.reminder,
  final: METRICS.finalDays,
  ended: METRICS.ended,
  portal_ready: METRICS.portalReady,
  paid: METRICS.payoutSent,
};

export function portalUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PORTAL_HOST) return `https://${env.PORTAL_HOST}/portal`;
  const base = env.SHOPIFY_APP_URL || env.RENDER_EXTERNAL_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/portal`;
}

export function storefrontUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.STOREFRONT_URL || "https://mambeblankets.com").replace(/\/$/, "");
}

/**
 * Create the reminder rows (if emails are on and the fundraiser is Scheduled
 * or Active). Unsent rows are re-planned from the current dates; anything
 * already sent or skipped stays as it is.
 */
export async function planCommunications(db: PrismaClient, fundraiserId: number, now = new Date()) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId } });
  await db.communication.deleteMany({ where: { fundraiserId, status: "scheduled", kind: { in: PLANNED_KINDS } } });
  if (!f.emailsEnabled || !EMAIL_STATUSES.has(f.status)) return [];

  const existing = await db.communication.findMany({ where: { fundraiserId, kind: { in: PLANNED_KINDS }, status: { in: ["sent", "skipped_past_due", "failed"] } } });
  const done = new Set(existing.map((c) => `${c.kind}:${c.reminderNumber ?? ""}`));
  const plan = planReminders(isoDate(f.startDate), isoDate(f.endDate), f.timezone);
  for (const item of plan) {
    if (done.has(`${item.kind}:${item.reminderNumber ?? ""}`)) continue;
    const pastDue = item.scheduledFor.getTime() <= now.getTime();
    await db.communication.create({
      data: {
        fundraiserId,
        kind: item.kind,
        reminderNumber: item.reminderNumber,
        scheduledFor: item.scheduledFor,
        status: pastDue ? "skipped_past_due" : "scheduled",
        error: pastDue ? "Its time had passed when emails were planned; never sent late." : null,
      },
    });
  }
  return plan;
}

export async function cancelCommunications(db: PrismaClient, fundraiserId: number, why: string) {
  await db.communication.updateMany({ where: { fundraiserId, status: "scheduled" }, data: { status: "cancelled", error: why } });
}

/** A one-off email (launch, ended, portal ready), due now. */
export async function queueEmail(db: PrismaClient, fundraiserId: number, kind: "launch" | "ended" | "portal_ready", now = new Date()) {
  return db.communication.create({ data: { fundraiserId, kind, scheduledFor: now, status: "scheduled" } });
}

export async function setEmailsEnabled(db: PrismaClient, id: number, enabled: boolean, actor: string, now = new Date()) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
  if (f.emailsEnabled === enabled) return;
  await db.fundraiser.update({ where: { id }, data: { emailsEnabled: enabled } });
  await writeAudit(db, { entity: "fundraiser", entityId: id, action: enabled ? "switch:emails_on" : "switch:emails_off", actor });
  if (enabled) await planCommunications(db, id, now);
  else await cancelCommunications(db, id, "Organizer emails switched off.");
}

/** The properties every email gets, so Klaviyo templates can use any of them. */
export async function emailProperties(db: PrismaClient, fundraiserId: number, now = new Date()) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId }, include: { team: { include: { organization: true } } } });
  const totals = await storedTotals(db, f);
  const startDate = isoDate(f.startDate);
  const endDate = isoDate(f.endDate);
  const today = todayPacific(now);
  const daysLeft = today > endDate ? 0 : Math.round(DateTime.fromISO(endDate).diff(DateTime.fromISO(today < startDate ? startDate : today), "days").days) + 1;
  return {
    fundraiser_code: f.publicCode,
    organization_name: f.team.organization.name,
    team_name: f.bannerTeamName ?? defaultBannerTeamName(f.team.organization.name, f.team.name),
    start_date: DateTime.fromISO(startDate).toFormat("LLLL d"),
    end_date: DateTime.fromISO(endDate).toFormat("LLLL d"),
    days_left: daysLeft,
    day_status: dayStatus(startDate, endDate, now),
    units_so_far: totals.qualifyingUnits,
    estimated_raised: `$${(totals.estimatedPayoutCents / 100).toFixed(2)}`,
    payout_rate: `$${(f.payoutRateCents / 100).toFixed(f.payoutRateCents % 100 ? 2 : 0)}`,
    short_link: f.shortUrl ? `${storefrontUrl()}${f.shortUrl}` : null,
    portal_link: portalUrl(),
    help_email: PORTAL_HELP_EMAIL,
  };
}

/** Send one row to every organizer on the fundraiser. */
export async function sendCommunication(
  db: PrismaClient,
  klaviyo: KlaviyoClient,
  comm: Communication,
  sentBy: string,
  now = new Date(),
): Promise<"sent" | "failed" | "retry"> {
  const f = await db.fundraiser.findUniqueOrThrow({
    where: { id: comm.fundraiserId },
    include: { organizers: { include: { organizer: true }, orderBy: { isPrimary: "desc" } } },
  });
  const properties = {
    ...(await emailProperties(db, f.id, now)),
    email_kind: comm.kind,
    reminder_number: comm.reminderNumber,
  };
  try {
    if (f.organizers.length === 0) throw new Error("This fundraiser has no organizers.");
    const deliveredTo: string[] = [];
    for (const link of f.organizers) {
      const { firstName, lastName } = splitName(link.organizer.name);
      const result = await klaviyo.sendEvent(
        METRIC_FOR_KIND[comm.kind] ?? METRICS.reminder,
        { email: link.organizer.email, firstName, lastName },
        { ...properties, organizer_first_name: firstName },
        `comm-${comm.id}-organizer-${link.organizerId}`,
      );
      deliveredTo.push(result.deliveredTo);
    }
    await db.communication.update({
      where: { id: comm.id },
      data: { status: "sent", sentAt: now, sentBy, attempts: comm.attempts + 1, lastAttemptAt: now, error: null },
    });
    return "sent";
  } catch (error) {
    const attempts = comm.attempts + 1;
    const failed = attempts >= MAX_SEND_ATTEMPTS;
    await db.communication.update({
      where: { id: comm.id },
      data: { attempts, lastAttemptAt: now, error: String((error as Error)?.message ?? error).slice(0, 500), ...(failed ? { status: "failed" } : {}) },
    });
    if (failed) alert(`Organizer email "${comm.kind}" for ${f.publicCode} failed ${attempts} times`, { communicationId: comm.id });
    return failed ? "failed" : "retry";
  }
}

/** Run by the clock every 15 minutes. */
export async function sendDueCommunications(db: PrismaClient, klaviyo: KlaviyoClient, now = new Date()) {
  const due = await db.communication.findMany({
    where: { status: "scheduled", scheduledFor: { lte: now } },
    include: { fundraiser: { select: { emailsEnabled: true, status: true } } },
    orderBy: { scheduledFor: "asc" },
  });
  const summary = { sent: 0, skipped: 0, cancelled: 0, failed: 0, retrying: 0 };
  for (const comm of due) {
    if (!comm.fundraiser.emailsEnabled || comm.fundraiser.status === "cancelled") {
      await db.communication.update({ where: { id: comm.id }, data: { status: "cancelled", error: "Organizer emails off or fundraiser cancelled." } });
      summary.cancelled += 1;
      continue;
    }
    const grace = PLANNED_KINDS.includes(comm.kind) ? SEND_GRACE_MS : IMMEDIATE_GRACE_MS;
    if (now.getTime() - comm.scheduledFor!.getTime() > grace) {
      await db.communication.update({ where: { id: comm.id }, data: { status: "skipped_past_due", error: "Too late to send; never sent late." } });
      summary.skipped += 1;
      continue;
    }
    const result = await sendCommunication(db, klaviyo, comm, "clock", now);
    if (result === "sent") summary.sent += 1;
    else if (result === "failed") summary.failed += 1;
    else summary.retrying += 1;
  }
  return summary;
}

/** Admin "Send now" for one row. Audited. */
export async function sendNow(db: PrismaClient, klaviyo: KlaviyoClient, communicationId: number, actor: string, now = new Date()) {
  const comm = await db.communication.findUniqueOrThrow({ where: { id: communicationId }, include: { fundraiser: true } });
  if (!comm.fundraiser.emailsEnabled) throw new UserError("Turn on Organizer emails for this fundraiser first.");
  if (comm.status === "sent") throw new UserError("That email was already sent.");
  const result = await sendCommunication(db, klaviyo, { ...comm, attempts: 0 }, actor, now);
  await writeAudit(db, {
    entity: "fundraiser",
    entityId: comm.fundraiserId,
    action: "email:send_now",
    after: { communicationId, kind: comm.kind, reminderNumber: comm.reminderNumber, result },
    actor,
  });
  if (result !== "sent") {
    const row = await db.communication.findUniqueOrThrow({ where: { id: communicationId } });
    throw new UserError(`Klaviyo didn't accept it: ${row.error}`);
  }
}
