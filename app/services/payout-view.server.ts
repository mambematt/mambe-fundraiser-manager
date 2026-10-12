// Everything the fundraiser page's Payout section shows.
import type { PrismaClient } from "@prisma/client";
import { launched } from "../lib/launched";
import { adminOrderUrl } from "../lib/shopify-links";
import { crosscheckData } from "./crosscheck.server";
import { payoutSummary, settlementDueAt } from "./settlement.server";

export async function loadPayoutView(db: PrismaClient, fundraiserId: number, storeTimezone: string | null) {
  const f = launched(await db.fundraiser.findUniqueOrThrow({
    where: { id: fundraiserId },
    include: { payout: { include: { adjustments: { orderBy: { createdAt: "asc" } }, changes: { orderBy: { detectedAt: "desc" } } } } },
  }));
  const base = {
    fundraiserStatus: f.status,
    dueAt: settlementDueAt(f).toISOString(),
    repulledAt: f.settlementRepulledAt?.toISOString() ?? null,
    repullOrders: f.settlementRepullOrders,
    settlementError: f.settlementError,
    canDryRun: ["active", "settling", "scheduled"].includes(f.status) && !f.payout,
  };
  if (!f.payout) return { ...base, payout: null };

  const p = f.payout;
  const summary = await payoutSummary(db, p.id);
  const frozenLines =
    p.status === "draft"
      ? []
      : (
          await db.payoutLine.findMany({
            where: { payoutId: p.id },
            include: { lineItem: { include: { order: true } } },
            orderBy: { id: "asc" },
          })
        ).map((l) => ({ id: l.id, orderName: l.lineItem.order.name, orderUrl: adminOrderUrl(l.lineItem.order.shopifyOrderId), units: l.unitsCounted }));
  const cross = p.status === "draft" && storeTimezone ? await crosscheckData(db, fundraiserId, storeTimezone) : null;

  return {
    ...base,
    payout: {
      id: p.id,
      status: p.status,
      units: summary.units,
      rateCents: summary.rateCents,
      amountCents: summary.amountCents,
      adjustmentsCents: summary.adjustmentsCents,
      finalCents: summary.finalCents,
      payeeEmail: p.status === "draft" ? f.paypalPayeeEmail : p.payeeEmail,
      blockers: summary.blockers,
      unresolvedFlags: summary.unresolvedFlags,
      crosscheckRequired: summary.crosscheckRequired,
      crosscheckCurrent: summary.crosscheckCurrent,
      crosscheck: p.crosscheckAt
        ? { shopifyUnits: p.crosscheckShopifyUnits, appUnits: p.crosscheckAppUnits, note: p.crosscheckNote, by: p.crosscheckBy, at: p.crosscheckAt.toISOString() }
        : null,
      individualPayee: summary.individualPayee,
      individualConfirmed: p.individualPayeeConfirmedAt
        ? { by: p.individualPayeeConfirmedBy, at: p.individualPayeeConfirmedAt.toISOString(), note: p.individualPayeeNote }
        : null,
      approvedAt: p.approvedAt?.toISOString() ?? null,
      approvedBy: p.approvedBy,
      paid: p.paidAt
        ? { at: p.paidAt.toISOString(), by: p.paidBy, method: p.method, reference: p.paypalReference, amountCents: p.paidAmountCents, note: p.paidNote }
        : null,
      adjustments: p.adjustments.map((a) => ({
        id: a.id,
        amountCents: a.amountCents,
        reason: a.reason,
        date: a.effectiveDate.toISOString().slice(0, 10),
        note: a.adminNote,
        by: a.createdBy,
      })),
      frozenLines,
      changes: p.changes.map((c) => ({
        id: c.id,
        orderName: c.orderName,
        lost: c.unitsCounted - c.unitsNow,
        amountCents: c.amountCents,
        at: c.detectedAt.toISOString(),
        acknowledged: !!c.acknowledgedAt,
      })),
    },
    crosscheck: cross
      ? {
          storeTimezone: cross.storeTimezone,
          sameZone: cross.sameZone,
          windowInStoreTime: cross.windowInStoreTime,
          reportStartDate: cross.reportStartDate,
          reportEndDate: cross.reportEndDate,
          productTitle: cross.productTitle,
          units: cross.units,
          orders: cross.qualifyingOrders.length,
          edgeOrders: cross.edgeOrders,
        }
      : null,
  };
}

export type PayoutView = Awaited<ReturnType<typeof loadPayoutView>>;
