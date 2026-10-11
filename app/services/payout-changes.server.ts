// Changes that reach a line after its payout was frozen (approved or paid).
// Kept separate so the order sync can call it without importing settlement.

import type { Prisma, PrismaClient } from "@prisma/client";
import { netUnits } from "../lib/attribution";
import { alert } from "./alerts.server";
import { writeAudit } from "./audit.server";

type Tx = Prisma.TransactionClient;
const FROZEN = new Set(["approved", "paid"]);


/**
 * Called when a locked line is re-saved. If its units dropped after the
 * payout was frozen, record it once (Case 22: the paid amount never
 * changes; History shows it and the work queue flags it once).
 */
export async function notePostFreezeChange(
  tx: Tx,
  line: { id: number; quantity: number; refundedQuantity: number; currentQuantity: number },
  order: { name: string; cancelledAt: Date | null },
) {
  const frozen = await tx.payoutLine.findUnique({ where: { lineItemId: line.id }, include: { payout: true } });
  if (!frozen || !FROZEN.has(frozen.payout.status)) return;
  const unitsNow = order.cancelledAt ? 0 : netUnits(line);
  if (unitsNow >= frozen.unitsCounted) return;
  const exists = await tx.payoutChange.findUnique({ where: { lineItemId_unitsNow: { lineItemId: line.id, unitsNow } } });
  if (exists) return;
  const lost = frozen.unitsCounted - unitsNow;
  const amountCents = lost * frozen.payout.rateCents;
  await tx.payoutChange.create({
    data: { payoutId: frozen.payoutId, lineItemId: line.id, orderName: order.name, unitsCounted: frozen.unitsCounted, unitsNow, amountCents },
  });
  await writeAudit(tx, {
    entity: "fundraiser",
    entityId: frozen.payout.fundraiserId,
    action: frozen.payout.status === "paid" ? "payout:refund_after_payout" : "payout:refund_after_approval",
    after: { orderName: order.name, units: lost, amountCents, payoutStatus: frozen.payout.status },
    actor: "shopify",
  });
  alert(`Refund after ${frozen.payout.status === "paid" ? "payout" : "approval"}: ${order.name}, ${lost} unit(s)`, { payoutId: frozen.payoutId });
}

export async function acknowledgePayoutChange(db: PrismaClient, changeId: number, actor: string) {
  await db.payoutChange.update({ where: { id: changeId }, data: { acknowledgedAt: new Date(), acknowledgedBy: actor } });
}

