// Weekly payout backup (spec "Backups"): every Monday the accountant payout
// CSV is written to Fundraising/_Backups/ in Drive, named with the date. A
// failure alerts and shows in the work queue; the clock tries again an hour
// later, until it succeeds that week.

import type { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { calendarDate } from "../lib/format";
import { accountantCsv, type AccountantRow } from "../lib/payout-files";
import { alertError } from "./alerts.server";
import { backupsFolderId, type DriveClient } from "./drive.server";
import { payoutSummary } from "./settlement.server";

export const BACKUP_JOB = "payout_backup";
const ZONE = "America/Los_Angeles";
const RETRY_AFTER_MS = 3600 * 1000;

/**
 * The accountant rows, built exactly as the Payouts page builds them
 * (app/routes/app.payouts.tsx, frozen until the first live payout; switch
 * that page to this function afterwards).
 */
export async function accountantRows(db: PrismaClient): Promise<AccountantRow[]> {
  const payouts = await db.payout.findMany({
    include: { fundraiser: { include: { team: { include: { organization: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(
    payouts.map(async (p) => {
      const s = await payoutSummary(db, p.id);
      return {
        publicCode: p.fundraiser.publicCode,
        organization: p.fundraiser.team.organization.name,
        team: p.fundraiser.team.name,
        payeeEmail: p.status === "draft" ? p.fundraiser.paypalPayeeEmail : p.payeeEmail,
        units: s.units,
        rateCents: s.rateCents,
        calculatedCents: s.amountCents,
        adjustmentsCents: s.adjustmentsCents,
        finalCents: s.finalCents,
        status: p.status,
        approvedDate: p.approvedAt ? calendarDate(p.approvedAt) : null,
        paidDate: p.paidAt ? calendarDate(p.paidAt) : null,
        paidAmountCents: p.paidAmountCents,
        paypalReference: p.paypalReference,
      };
    }),
  );
}

export function backupFileName(now: Date): string {
  return `mambe-payouts-${DateTime.fromJSDate(now).setZone(ZONE).toISODate()}.csv`;
}

/** Monday (Pacific), not yet done this Monday, and no failed try in the last hour. */
export async function backupIsDue(db: PrismaClient, now: Date): Promise<boolean> {
  const local = DateTime.fromJSDate(now).setZone(ZONE);
  if (local.weekday !== 1) return false;
  const mondayStart = local.startOf("day").toJSDate();
  const done = await db.jobRun.findFirst({ where: { name: BACKUP_JOB, status: "succeeded", startedAt: { gte: mondayStart } } });
  if (done) return false;
  const recentFail = await db.jobRun.findFirst({ where: { name: BACKUP_JOB, status: "failed", startedAt: { gte: new Date(now.getTime() - RETRY_AFTER_MS) } } });
  return !recentFail;
}

/** Write the CSV to _Backups. Records a job run either way; never throws. */
export async function runPayoutBackup(db: PrismaClient, drive: DriveClient | null, now = new Date()) {
  const run = await db.jobRun.create({ data: { name: BACKUP_JOB, startedAt: now } });
  try {
    if (!drive) throw new Error("Google Drive isn't set up on this service (GOOGLE_SERVICE_ACCOUNT_JSON, DRIVE_SHARED_DRIVE_ID).");
    const rows = await accountantRows(db);
    const folderId = await backupsFolderId(db, drive);
    const name = backupFileName(now);
    const file = await drive.uploadFile(name, folderId, "text/csv", accountantCsv(rows));
    await db.jobRun.update({
      where: { id: run.id },
      data: { status: "succeeded", finishedAt: new Date(), details: { file: name, fileId: file.id, payouts: rows.length } },
    });
    return { ok: true as const, file: name, payouts: rows.length };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    await db.jobRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), error: message } });
    alertError(error, "Weekly payout backup to Drive failed");
    return { ok: false as const, error: message };
  }
}
