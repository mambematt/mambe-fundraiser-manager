// Loads the Home page's number strip and work queue.

import type { PrismaClient } from "@prisma/client";
import { periodTotals } from "../lib/attribution";
import { lastDays, monthToDate, yearToDate } from "../lib/calendar";
import { buildWorkQueue, type QueueGroup } from "../lib/work-queue";
import { isoDate } from "./fundraisers.server";
import { webhookHealth } from "./jobs.server";

export interface NumberStrip {
  active: number;
  scheduled: number;
  settling: number;
  payoutsOutstandingCents: number;
  month: { units: number; estimatedPayoutCents: number };
  year: { units: number; estimatedPayoutCents: number };
  outsideWindowUnits30d: number;
}

export async function loadNumberStrip(db: PrismaClient, now = new Date()): Promise<NumberStrip> {
  const year = yearToDate(now);
  const last30 = lastDays(now, 30);
  const earliest = year.start < last30.start ? year.start : last30.start;

  const [statusCounts, outstanding, lines] = await Promise.all([
    db.fundraiser.groupBy({ by: ["status"], _count: true }),
    db.payout.aggregate({ where: { status: "approved" }, _sum: { amountCents: true } }),
    db.orderLineItem.findMany({
      where: { order: { processedAt: { gte: earliest } }, outcome: { in: ["qualifying", "non_fundraiser"] } },
      include: { order: { select: { processedAt: true } }, attributedFundraiser: { select: { payoutRateCents: true } } },
    }),
  ]);
  const count = (s: string) => statusCounts.find((c) => c.status === s)?._count ?? 0;
  const rows = lines.map((l) => ({
    processedAt: l.order.processedAt,
    outcome: l.outcome,
    qualifyingUnits: l.qualifyingUnits,
    quantity: l.quantity,
    refundedQuantity: l.refundedQuantity,
    currentQuantity: l.currentQuantity,
    payoutRateCents: l.attributedFundraiser?.payoutRateCents ?? null,
  }));
  const month = periodTotals(rows, monthToDate(now).start, now);
  const ytd = periodTotals(rows, year.start, now);
  const recent = periodTotals(rows, last30.start, now);

  return {
    active: count("active"),
    scheduled: count("scheduled"),
    settling: count("settling"),
    payoutsOutstandingCents: outstanding._sum.amountCents ?? 0,
    month: { units: month.qualifyingUnits, estimatedPayoutCents: month.estimatedPayoutCents },
    year: { units: ytd.qualifyingUnits, estimatedPayoutCents: ytd.estimatedPayoutCents },
    outsideWindowUnits30d: recent.outsideWindowUnits,
  };
}

export async function loadWorkQueue(db: PrismaClient, now = new Date()): Promise<QueueGroup[]> {
  const [fundraisers, newApplications, flagged, payouts, failedWebhooks, lastNightlyOk, health, failedEmails] = await Promise.all([
    db.fundraiser.findMany({ where: { status: { notIn: ["paid", "declined"] } } }),
    db.application.count({ where: { status: "new" } }),
    db.orderLineItem.findMany({
      where: {
        attributedFundraiserId: { not: null },
        adminDecision: null,
        reviewFlags: { isEmpty: false },
        outcome: { in: ["qualifying", "not_eligible"] },
        attributedFundraiser: { status: { not: "paid" } },
      },
      select: { attributedFundraiserId: true },
    }),
    db.payout.aggregate({ where: { status: "approved" }, _count: true, _sum: { amountCents: true } }),
    db.webhookEvent.count({ where: { status: "failed" } }),
    db.jobRun.findFirst({ where: { name: "nightly", status: "succeeded" }, orderBy: { startedAt: "desc" } }),
    webhookHealth(db, now),
    db.communication.groupBy({ by: ["fundraiserId"], where: { status: "failed" }, _count: true }),
  ]);

  const codes = new Map(fundraisers.map((f) => [f.id, f.publicCode]));
  const flagCounts = new Map<number, number>();
  for (const l of flagged) flagCounts.set(l.attributedFundraiserId!, (flagCounts.get(l.attributedFundraiserId!) ?? 0) + 1);

  return buildWorkQueue({
    now,
    fundraisers: fundraisers.map((f) => ({
      id: f.id,
      publicCode: f.publicCode,
      status: f.status,
      startDate: isoDate(f.startDate),
      endDate: isoDate(f.endDate),
      windowEnd: f.windowEnd,
      waitingOnOrganizerSince: f.waitingOnOrganizerSince,
    })),
    newApplications,
    flagsByFundraiser: [...flagCounts].map(([id, count]) => ({ id, publicCode: codes.get(id) ?? `#${id}`, count })),
    payoutsToSend: { count: payouts._count, amountCents: payouts._sum.amountCents ?? 0 },
    failedWebhooks,
    lastNightlyOkAt: lastNightlyOk?.startedAt ?? null,
    webhookSilence: health.silent,
    failedEmails: failedEmails.map((g) => ({ id: g.fundraiserId, publicCode: codes.get(g.fundraiserId) ?? `#${g.fundraiserId}`, count: g._count })),
    storefrontErrors: fundraisers
      .filter((f) => f.storefrontError)
      .map((f) => ({ id: f.id, publicCode: f.publicCode, error: f.storefrontError! })),
  });
}
